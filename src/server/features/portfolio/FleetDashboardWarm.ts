import { windows } from "./PortfolioService";

import { GscService } from "@/server/features/gsc/services/GscService";

import { type PortfolioGsc } from "./PortfolioService";

import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";

import { setCached } from "@/server/lib/r2-cache";

import { fetchGsc } from "./PortfolioService";

import { cacheKey } from "./PortfolioService";

import { TTL_SECONDS } from "./PortfolioService";

import { fetchGa4 } from "./PortfolioService";

import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";

import { ga4CacheKey } from "./PortfolioService";

import { hasBingWorkspaceAccess } from "@/server/features/bing/BingWorkspaceAccess";

import { BingWebmasterService } from "@/server/features/bing/BingWebmasterService";

import { getCached } from "@/server/lib/r2-cache";

import { getGoogleAccessToken } from "@/server/features/google/googleOAuth";

import { type SiteQueries } from "./FleetDashboardTypes";

import {
  ageMs,
  AUTH_CHECK_TTL_SECONDS,
  bingAttemptKey,
  cacheEvidenceSchema,
  connectionTime,
  ERROR_RETRY_MS,
  googleIdentity,
  gscSchema,
  QUERIES_PER_SITE,
  QUERIES_REFRESH_AFTER_MS,
  QUERIES_TTL_SECONDS,
  queriesKey,
  readAuthChecks,
  readFleetEvidence,
  REFRESH_AFTER_MS,
  sameReportingDay,
  WARM_BUDGET_DEFAULT,
  WARM_CONCURRENCY,
  WARM_MAX_MS,
  type AuthCheck,
  type GoogleIdentity,
} from "./FleetDashboardEvidence";

import { listFleet } from "./FleetDashboardRepository";

async function fetchTopQueries(projectId: string): Promise<SiteQueries> {
  const w = windows();
  const fetchedAt = new Date().toISOString();
  try {
    const res = await GscService.getPerformance({
      projectId,
      startDate: w.curStart,
      endDate: w.end,
      dimensions: ["query"],
      rowLimit: QUERIES_PER_SITE,
    } as Parameters<typeof GscService.getPerformance>[0]);
    return {
      fetchedAt,
      rows: res.rows
        .map((r): [string, number, number, number] => [
          r.keys?.[0] ?? "",
          r.clicks,
          r.impressions,
          Math.round(r.position * 10) / 10,
        ])
        .filter((r) => r[0]),
    };
  } catch (error) {
    return {
      fetchedAt,
      rows: [],
      error: error instanceof Error ? error.message.slice(0, 200) : "GSC error",
    };
  }
}

/**
 * Refresh due Google/Bing caches within a shared provider-call budget,
 * including uncached Google authorization checks. Coverage fills progressively;
 * missing/stale evidence remains explicit. Top queries use the current reporting date.
 */
// One warm at a time per isolate: the scheduler and site-table page views both
// start warms, and two at once would double provider calls for the same keys.
// A flag older than the warm deadline is treated as stale.
let warmStartedAt = 0;

export async function warmFleetCaches(
  organizationId: string,
  budget = WARM_BUDGET_DEFAULT,
) {
  if (warmStartedAt && Date.now() - warmStartedAt < WARM_MAX_MS + 20_000)
    return {
      ran: 0,
      pending: 0,
      budgetUsed: 0,
      timedOut: false,
      skipped: true,
    };
  warmStartedAt = Date.now();
  try {
    return await warmFleetCachesOnce(organizationId, budget);
  } finally {
    warmStartedAt = 0;
  }
}

async function warmFleetCachesOnce(organizationId: string, budget: number) {
  const deadline = Date.now() + WARM_MAX_MS;
  const limit = Math.max(0, Math.min(WARM_BUDGET_DEFAULT, Math.floor(budget)));
  const rows = await listFleet(organizationId);
  const [evidence, checks] = await Promise.all([
    readFleetEvidence(rows, organizationId),
    readAuthChecks(rows, organizationId),
  ]);
  type Task = {
    id: string;
    cost: number;
    google?: GoogleIdentity;
    run: () => Promise<void>;
  };
  const tasks: Task[] = [];
  let timedOut = false;
  let used = 0;
  let ran = 0;
  const canWrite = () => !timedOut && Date.now() < deadline;
  const due = (
    value: unknown,
    refreshAfter: number,
    timeZone = "UTC",
    updatedAt: string | null = null,
  ) => {
    const parsed = cacheEvidenceSchema.safeParse(value);
    if (!parsed.success) return true;
    const v = parsed.data;
    const age = ageMs(v.fetchedAt);
    if (v.error) return age < 0 || age >= ERROR_RETRY_MS;
    return (
      age < 0 ||
      age >= refreshAfter ||
      !sameReportingDay(v.fetchedAt, timeZone) ||
      !!(updatedAt && Date.parse(v.fetchedAt) < connectionTime(updatedAt))
    );
  };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const e = evidence[i];
    if (r.siteUrl) {
      const google = googleIdentity(r, "gsc", organizationId);
      const saveGsc = async (
        key: string,
        value: PortfolioGsc | SiteQueries,
        ttl: number,
      ) => {
        const current = await GscConnectionRepository.getByProjectId(
          r.projectId,
        );
        if (
          canWrite() &&
          current?.organizationId === organizationId &&
          current.siteUrl === r.siteUrl &&
          current.connectedByUserId === r.gscUserId &&
          current.gscAccountId === r.gscAccountId &&
          current.updatedAt === r.gscUpdatedAt
        )
          await setCached(
            key,
            value,
            value.error ? ERROR_RETRY_MS / 1000 : ttl,
          );
      };
      const parsed = gscSchema.safeParse(e.gsc);
      if (
        due(e.gsc, REFRESH_AFTER_MS, "UTC", r.gscUpdatedAt) ||
        (parsed.success && !parsed.data.error && !parsed.data.daily)
      )
        tasks.push({
          id: `${r.projectId}:gsc`,
          cost: 1,
          google,
          run: async () => {
            const value = await fetchGsc(r.projectId);
            await saveGsc(
              cacheKey(r.projectId, r.siteUrl!),
              value,
              TTL_SECONDS,
            );
          },
        });
      if (due(e.queries, QUERIES_REFRESH_AFTER_MS, "UTC", r.gscUpdatedAt))
        tasks.push({
          id: `${r.projectId}:queries`,
          cost: 1,
          google,
          run: async () => {
            await saveGsc(
              queriesKey(r.projectId, r.siteUrl!),
              await fetchTopQueries(r.projectId),
              QUERIES_TTL_SECONDS,
            );
          },
        });
    }
    if (
      r.ga4PropertyId &&
      due(
        e.ga4,
        REFRESH_AFTER_MS,
        r.ga4PropertyTimeZone ?? "UTC",
        r.ga4UpdatedAt,
      )
    ) {
      const google = googleIdentity(r, "ga4", organizationId);
      tasks.push({
        id: `${r.projectId}:ga4`,
        cost: 1,
        google,
        run: async () => {
          // The preflight fails closed on missing explicit account/user identity.
          if (!r.ga4UserId || !r.ga4AccountId) return;
          const value = await fetchGa4({
            projectId: r.projectId,
            propertyId: r.ga4PropertyId!,
            userId: r.ga4UserId,
            ga4AccountId: r.ga4AccountId,
          });
          const current = await Ga4ConnectionRepository.getByProjectId(
            r.projectId,
          );
          if (
            canWrite() &&
            current?.organizationId === organizationId &&
            current.propertyId === r.ga4PropertyId &&
            current.connectedByUserId === r.ga4UserId &&
            current.ga4AccountId === r.ga4AccountId &&
            current.updatedAt === r.ga4UpdatedAt
          )
            await setCached(
              ga4CacheKey(r.projectId, r.ga4PropertyId),
              value,
              value.error ? ERROR_RETRY_MS / 1000 : TTL_SECONDS,
            );
        },
      });
    }
    const attempt = cacheEvidenceSchema.safeParse(e.bingAttempt);
    const bingFailedRecently =
      attempt.success &&
      attempt.data.error &&
      ageMs(attempt.data.fetchedAt) >= 0 &&
      ageMs(attempt.data.fetchedAt) < ERROR_RETRY_MS;
    if (
      r.bingSiteUrl &&
      hasBingWorkspaceAccess(organizationId) &&
      !bingFailedRecently &&
      (!e.bing || ageMs(e.bing.fetchedAt) >= REFRESH_AFTER_MS)
    )
      tasks.push({
        id: `${r.projectId}:bing`,
        cost: 2,
        run: async () => {
          try {
            await BingWebmasterService.refreshSnapshot({
              projectId: r.projectId,
              organizationId,
            });
            if (canWrite())
              await setCached(
                bingAttemptKey(organizationId, r),
                { fetchedAt: new Date().toISOString() },
                ERROR_RETRY_MS / 1000,
              );
          } catch {
            if (canWrite())
              await setCached(
                bingAttemptKey(organizationId, r),
                {
                  fetchedAt: new Date().toISOString(),
                  error:
                    "Bing snapshot refresh failed; check connector access or retry.",
                },
                ERROR_RETRY_MS / 1000,
              );
          }
        },
      });
  }
  // Stable identity, not array offset: additions/removals and an always-missing
  // failed prefix cannot reset progress. Persist across scheduler invocations.
  tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cursorKey = `fleet-warm-cursor:v1:${organizationId}`;
  const savedCursor = await getCached(cursorKey);
  const after =
    typeof savedCursor === "string"
      ? tasks.findIndex((t) => t.id > savedCursor)
      : 0;
  const start = after < 0 ? 0 : after;
  const ordered = [...tasks.slice(start), ...tasks.slice(0, start)];
  let next = 0;
  let lastId: string | null = null;
  let lastProcessed = -1;
  const markProcessed = (index: number, task: Task) => {
    if (index > lastProcessed) {
      lastProcessed = index;
      lastId = task.id;
    }
  };
  // Existing Google clients do not expose AbortSignal for OAuth. Bound awaiting
  // and stop ALL further work on timeout; never fan out replacements for a hung
  // request. At most three requests can remain in flight, and late results are
  // not written. Bing itself additionally cancels each request after 10 seconds.
  async function bounded<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              timedOut = true;
              reject(new Error("Fleet warm deadline"));
            },
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const preflights = new Map<string, Promise<AuthCheck | null>>();
  async function preflight(id: GoogleIdentity): Promise<AuthCheck | null> {
    if (checks.has(id.key)) return checks.get(id.key)!;
    const existing = preflights.get(id.key);
    if (existing) return existing;
    if (used >= limit) return null;
    used++;
    const work = (async () => {
      let error: string | null = null;
      try {
        // Never let an unspecified account fall back to another user's grant.
        if (!id.userId || !id.accountId || !id.revision)
          throw new Error("Missing explicit account grant");
        await bounded(
          getGoogleAccessToken({
            providerId: id.providerId,
            userId: id.userId,
            accountId: id.accountId,
          }),
        );
      } catch {
        if (timedOut) return null;
        error =
          "Google account authorization failed; reconnect this account or retry.";
      }
      const check = {
        checkedAt: new Date().toISOString(),
        revision: id.revision,
        error,
      };
      if (canWrite()) await setCached(id.key, check, AUTH_CHECK_TTL_SECONDS);
      checks.set(id.key, check);
      return check;
    })();
    preflights.set(id.key, work);
    return work;
  }
  await Promise.all(
    Array.from({ length: WARM_CONCURRENCY }, async () => {
      while (
        next < ordered.length &&
        !timedOut &&
        Date.now() < deadline - 20_000 &&
        used < limit
      ) {
        const index = next++;
        const task = ordered[index];
        try {
          if (task.google) {
            const check = await preflight(task.google);
            if (!check) break;
            // One failed grant explains every project, without a refresh per site.
            if (check.error) {
              markProcessed(index, task);
              continue;
            }
          }
          if (timedOut || used + task.cost > limit) break;
          used += task.cost;
          markProcessed(index, task);
          ran++;
          await bounded(task.run());
        } catch {
          /* Failed provider/cache tasks do not stop fair fleet progress. */
        }
      }
    }),
  );
  if (lastId) await setCached(cursorKey, lastId, 7 * 24 * 3600);
  return {
    ran,
    pending: Math.max(0, tasks.length - ran),
    budgetUsed: used,
    timedOut,
    skipped: false,
  };
}
