// CityThrive fork: all-sites dashboard. Everything here reads caches and the
// DB only; Google APIs are touched solely by warmFleetCaches(), which the
// 5-minute scheduler calls with a small budget so tokyo never fans out across
// the whole fleet at once. The assembled dashboard is itself cached as one R2
// snapshot, so a page view is a single object read.
import { aliasedTable, and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  projects,
  gscConnections,
  ga4Connections,
  audits,
  auditIssues,
  domainHealthCurrent,
  bingSiteBindings,
  account,
} from "@/db/schema";
import {
  BingWebmasterService,
  type BingSnapshot,
} from "@/server/features/bing/BingWebmasterService";
import { hasBingWorkspaceAccess } from "@/server/features/bing/BingWorkspaceAccess";
import { getGoogleAccessToken } from "@/server/features/google/googleOAuth";
import { GSC_OAUTH_PROVIDER_ID } from "@/shared/gsc";
import { GA4_OAUTH_PROVIDER_ID } from "@/shared/ga4";
import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { getCached, setCached } from "@/server/lib/r2-cache";
import { GscService } from "@/server/features/gsc/services/GscService";
import {
  TTL_SECONDS,
  cacheKey,
  fetchGa4,
  fetchGsc,
  ga4CacheKey,
  getAuditSummaries,
  windows,
  type PortfolioGa4,
  type PortfolioGsc,
  type PortfolioRow,
} from "./PortfolioService";

const SNAPSHOT_TTL_SECONDS = 6 * 60 * 60;
/** The scheduler rebuilds the snapshot when it is older than this. */
const SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;
/** Refresh GSC/GA4 totals this long before their 12h cache expires. */
const REFRESH_AFTER_MS = 9 * 60 * 60 * 1000;
const QUERIES_TTL_SECONDS = 36 * 60 * 60;
const QUERIES_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const QUERIES_PER_SITE = 25;
const WARM_CONCURRENCY = 3;
const WARM_BUDGET_DEFAULT = 120;
/** Sites whose cached evidence is read per window (about 5 R2 reads each). */
const WARM_SCAN_ROWS = 150;
/** Leave room for cache-only assembly inside the self-hosted 150s scheduler. */
const WARM_MAX_MS = 100_000;
const ERROR_RETRY_MS = 30 * 60 * 1000;
const AUTH_CHECK_TTL_SECONDS = 30 * 60;
const BING_REFRESH_AFTER_MS = REFRESH_AFTER_MS;
const BING_MAX_AGE_MS = TTL_SECONDS * 1000;
/** Parallel R2 reads while assembling the snapshot (1,600+ sites x 3 keys). */
const READ_CONCURRENCY = 32;
/** Rows kept for the CSV export (the dashboard shows the first 15). */
const TOP_QUERIES_EXPORT = 1000;

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

function snapshotKey(organizationId: string) {
  // v3 adds complete provider inventory, authorization evidence and Bing.
  // v4 adds the provider issue summary shown above the dashboard.
  return `fleet-dashboard:v4:${organizationId}`;
}
function queriesKey(projectId: string, siteUrl: string) {
  return `portfolio-gscq:v1:${projectId}:${siteUrl}`;
}

type SiteQueries = {
  fetchedAt: string;
  /** [query, clicks, impressions, position] for the current 28-day window. */
  rows: Array<[string, number, number, number]>;
  error?: string;
};

export type FleetSite = {
  projectId: string;
  domain: string;
  clicks: number;
  prevClicks: number;
  impressions: number;
  delta: number;
};

export type FleetQuery = {
  query: string;
  clicks: number;
  impressions: number;
  position: number | null;
  sites: number;
};

export type FleetDownDomain = {
  projectId: string | null;
  domain: string;
  class: string;
  httpStatus: number | null;
  finalUrl: string | null;
  error: string | null;
  onCloudflare: boolean;
  sslDaysRemaining: number | null;
  checkedAt: string;
};

export type FleetProviderEntry<Metrics> = {
  status: "available" | "error" | "missing" | "stale" | "unlinked";
  property: string | null;
  accountId: string | null;
  email: string | null;
  fetchedAt: string | null;
  error: string | null;
  /**
   * Only available evidence contributes to totals; failed/missing is not zero.
   * A stale entry keeps its earlier metrics for display while it refreshes.
   */
  metrics: Metrics | null;
};
export type FleetInventoryRow = {
  projectId: string;
  name: string;
  domain: string | null;
  gsc: FleetProviderEntry<
    Pick<
      PortfolioGsc,
      | "clicks"
      | "prevClicks"
      | "impressions"
      | "prevImpressions"
      | "position"
      | "prevPosition"
    >
  >;
  ga4: FleetProviderEntry<{
    sessions: number;
    prevSessions: number;
    users: number;
    prevUsers: number;
  }>;
  bing: FleetProviderEntry<{
    clicks: number | null;
    impressions: number | null;
    /** Ratio, not percent. Bing supplies no average position. */
    ctr: number | null;
    startDate: string | null;
    endDate: string | null;
  }>;
};

/** One provider failure shared by many sites, for example an expired grant. */
export type FleetProviderIssue = {
  provider: "gsc" | "ga4" | "bing";
  error: string;
  sites: number;
  /** A site with this failure, for the reconnect link. */
  projectId: string;
};

export type FleetDashboard = {
  generatedAt: string;
  inventory: FleetInventoryRow[];
  /** Up to three most common failures per provider, most sites first. */
  providerIssues: FleetProviderIssue[];
  windows: ReturnType<typeof windows>;
  coverage: {
    projects: number;
    gscLinked: number;
    ga4Linked: number;
    gscCached: number;
    ga4Cached: number;
    bingLinked: number;
    bingCached: number;
    queriesCached: number;
    audited: number;
    neither: number;
  };
  gsc: {
    sites: number;
    clicks: number;
    prevClicks: number;
    impressions: number;
    prevImpressions: number;
    position: number | null;
    prevPosition: number | null;
    errors: number;
  };
  daily: Array<{
    day: number;
    date: string;
    clicks: number;
    impressions: number;
    prevClicks: number;
    prevImpressions: number;
  }>;
  dailySites: number;
  ga4: {
    sites: number;
    sessions: number;
    prevSessions: number;
    users: number;
    prevUsers: number;
    zeroSessionSites: number;
    errors: number;
  };
  bing: {
    sites: number;
    clicks: number | null;
    impressions: number | null;
    errors: number;
    dateBasis: "provider-returned";
    startDate: string | null;
    endDate: string | null;
    limitations: string[];
  };
  gainers: FleetSite[];
  losers: FleetSite[];
  topQueries: Array<FleetQuery>;
  /** Up to 1,000 queries for the CSV export; absent in older snapshots. */
  topQueriesExport?: Array<FleetQuery>;
  audit: {
    audited: number;
    withCritical: number;
    lastAuditAt: string | null;
    running: number;
    issuesByType: Array<{
      type: string;
      severity: string;
      count: number;
      sites: number;
    }>;
    worstSites: Array<{ projectId: string; domain: string; critical: number }>;
  };
  health: {
    available: boolean;
    checked: number;
    lastCheckedAt: string | null;
    byClass: Record<string, number>;
    down: FleetDownDomain[];
    missingTag: number;
  };
};

async function listFleet(organizationId: string) {
  const gscGrant = aliasedTable(account, "fleet_gsc_grant");
  const ga4Grant = aliasedTable(account, "fleet_ga4_grant");
  return db
    .select({
      projectId: projects.id,
      name: projects.name,
      domain: projects.domain,
      siteUrl: gscConnections.siteUrl,
      gscUserId: gscConnections.connectedByUserId,
      gscAccountId: gscConnections.gscAccountId,
      gscEmail: gscConnections.connectedAccountEmail,
      gscUpdatedAt: gscConnections.updatedAt,
      gscGrantUpdatedAt: gscGrant.updatedAt,
      ga4PropertyId: ga4Connections.propertyId,
      ga4PropertyTimeZone: ga4Connections.propertyTimeZone,
      ga4UserId: ga4Connections.connectedByUserId,
      ga4AccountId: ga4Connections.ga4AccountId,
      ga4Email: ga4Connections.connectedAccountEmail,
      ga4UpdatedAt: ga4Connections.updatedAt,
      ga4GrantUpdatedAt: ga4Grant.updatedAt,
      bingBindingId: bingSiteBindings.id,
      bingSiteUrl: bingSiteBindings.siteUrl,
    })
    .from(projects)
    .leftJoin(
      gscConnections,
      and(
        eq(gscConnections.projectId, projects.id),
        eq(gscConnections.organizationId, projects.organizationId),
      ),
    )
    .leftJoin(
      ga4Connections,
      and(
        eq(ga4Connections.projectId, projects.id),
        eq(ga4Connections.organizationId, projects.organizationId),
      ),
    )
    .leftJoin(
      gscGrant,
      and(
        eq(gscGrant.userId, gscConnections.connectedByUserId),
        eq(gscGrant.providerId, GSC_OAUTH_PROVIDER_ID),
        eq(gscGrant.accountId, gscConnections.gscAccountId),
      ),
    )
    .leftJoin(
      ga4Grant,
      and(
        eq(ga4Grant.userId, ga4Connections.connectedByUserId),
        eq(ga4Grant.providerId, GA4_OAUTH_PROVIDER_ID),
        eq(ga4Grant.accountId, ga4Connections.ga4AccountId),
      ),
    )
    .leftJoin(
      bingSiteBindings,
      and(
        eq(bingSiteBindings.projectId, projects.id),
        eq(bingSiteBindings.organizationId, projects.organizationId),
        // A global key is not an entitlement for arbitrary hosted organizations.
        sql`${hasBingWorkspaceAccess(organizationId) ? 1 : 0} = 1`,
      ),
    )
    .where(
      and(
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .orderBy(projects.id);
}
type FleetRow = Awaited<ReturnType<typeof listFleet>>[number];

function ageMs(fetchedAt: string | undefined): number {
  const t = fetchedAt ? Date.parse(fetchedAt) : NaN;
  return Number.isNaN(t) ? Infinity : Date.now() - t;
}

const countSchema = z.number().finite().nonnegative();
const cacheEvidenceSchema = z.object({
  fetchedAt: z.string(),
  error: z.string().optional(),
});
const gscSchema = cacheEvidenceSchema.extend({
  clicks: countSchema,
  prevClicks: countSchema,
  impressions: countSchema,
  prevImpressions: countSchema,
  position: countSchema.nullable(),
  prevPosition: countSchema.nullable(),
  daily: z.array(z.tuple([z.string(), countSchema, countSchema])).optional(),
});
const ga4Schema = cacheEvidenceSchema.extend({
  sessions: countSchema,
  prevSessions: countSchema,
  activeUsers: countSchema,
  prevActiveUsers: countSchema,
});
const queriesSchema = cacheEvidenceSchema.extend({
  rows: z.array(z.tuple([z.string(), countSchema, countSchema, countSchema])),
});
const authCheckSchema = z.object({
  checkedAt: z.string(),
  revision: z.string().nullable(),
  error: z.string().nullable(),
});
type AuthCheck = z.infer<typeof authCheckSchema>;
type GoogleIdentity = {
  key: string;
  providerId: typeof GSC_OAUTH_PROVIDER_ID | typeof GA4_OAUTH_PROVIDER_ID;
  userId: string | null;
  accountId: string | null;
  revision: string | null;
};

function googleIdentity(
  r: FleetRow,
  provider: "gsc" | "ga4",
  organizationId: string,
): GoogleIdentity {
  const providerId =
    provider === "gsc" ? GSC_OAUTH_PROVIDER_ID : GA4_OAUTH_PROVIDER_ID;
  const userId = provider === "gsc" ? r.gscUserId : r.ga4UserId;
  const accountId = provider === "gsc" ? r.gscAccountId : r.ga4AccountId;
  const updatedAt =
    provider === "gsc" ? r.gscGrantUpdatedAt : r.ga4GrantUpdatedAt;
  return {
    key: `fleet-google-auth:v1:${organizationId}:${encodeURIComponent(JSON.stringify([providerId, userId, accountId]))}`,
    providerId,
    userId,
    accountId,
    revision: updatedAt?.toISOString() ?? null,
  };
}

async function readAuthChecks(rows: FleetRow[], organizationId: string) {
  const identities = new Map<string, GoogleIdentity>();
  for (const r of rows) {
    if (r.siteUrl) {
      const id = googleIdentity(r, "gsc", organizationId);
      identities.set(id.key, id);
    }
    if (r.ga4PropertyId) {
      const id = googleIdentity(r, "ga4", organizationId);
      identities.set(id.key, id);
    }
  }
  const checks = new Map<string, AuthCheck>();
  await mapLimit([...identities.values()], READ_CONCURRENCY, async (id) => {
    const parsed = authCheckSchema.safeParse(await getCached(id.key));
    if (
      parsed.success &&
      parsed.data.revision === id.revision &&
      ageMs(parsed.data.checkedAt) >= 0 &&
      ageMs(parsed.data.checkedAt) < AUTH_CHECK_TTL_SECONDS * 1000
    )
      checks.set(id.key, parsed.data);
  });
  return checks;
}

function googleCheck(
  r: FleetRow,
  provider: "gsc" | "ga4",
  organizationId: string,
  checks: Map<string, AuthCheck>,
): AuthCheck | undefined {
  const id = googleIdentity(r, provider, organizationId);
  if (!id.userId || !id.accountId || !id.revision)
    return {
      checkedAt: new Date().toISOString(),
      revision: id.revision,
      error: "Google account grant is missing; reconnect this account.",
    };
  return checks.get(id.key);
}

function connectionTime(value: string) {
  // SQL text timestamps are UTC even on a non-UTC self-hosted process.
  return Date.parse(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value,
  );
}

function sameReportingDay(fetchedAt: string, timeZone = "UTC") {
  try {
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return day.format(new Date(fetchedAt)) === day.format(new Date());
  } catch {
    return false;
  }
}

function providerEntry<Metrics>(
  property: string | null,
  accountId: string | null,
  email: string | null,
  evidence: unknown,
  metrics: Metrics | null,
  currentWindow: boolean,
  maxAgeMs: number,
  updatedAt: string | null = null,
  auth?: AuthCheck,
): FleetProviderEntry<Metrics> {
  const parsed = cacheEvidenceSchema.safeParse(evidence);
  const cached = parsed.success ? parsed.data : null;
  const entry: FleetProviderEntry<Metrics> = {
    status: "unlinked",
    property,
    accountId,
    email,
    fetchedAt: cached?.fetchedAt ?? null,
    error: null,
    metrics: null,
  };
  if (!property) return entry;
  if (auth?.error) return { ...entry, status: "error", error: auth.error };
  if (evidence == null)
    return {
      ...entry,
      status: "missing",
      error: "No stored snapshot; waiting for a scheduled refresh.",
    };
  if (!cached)
    return {
      ...entry,
      status: "error",
      error: "Stored snapshot is invalid; waiting for a scheduled refresh.",
    };
  if (!metrics && !cached.error)
    return {
      ...entry,
      status: "error",
      error: "Stored metrics are invalid; waiting for a scheduled refresh.",
    };
  const age = ageMs(cached.fetchedAt);
  // A selected account/property can change while the property cache key stays
  // the same. Evidence collected before that binding must not be reused.
  const beforeBinding =
    updatedAt && Date.parse(cached.fetchedAt) < connectionTime(updatedAt);
  if (
    age < 0 ||
    age > (cached.error ? ERROR_RETRY_MS : maxAgeMs) ||
    !currentWindow ||
    beforeBinding
  ) {
    // Until a retry succeeds, the last answer for this binding is the failure.
    if (cached.error && !beforeBinding)
      return { ...entry, status: "error", error: cached.error };
    return {
      ...entry,
      status: "stale",
      error:
        cached.error ??
        "Stored snapshot is stale or covers a previous reporting window.",
      // Another account's numbers must not show against this binding.
      metrics: beforeBinding ? null : metrics,
    };
  }
  if (cached.error) return { ...entry, status: "error", error: cached.error };
  return { ...entry, status: "available", metrics };
}

function bingAttemptKey(organizationId: string, r: FleetRow) {
  return `fleet-bing-attempt:v1:${organizationId}:${r.projectId}:${r.bingBindingId}`;
}

async function readFleetEvidence(rows: FleetRow[], organizationId: string) {
  return mapLimit(rows, READ_CONCURRENCY, async (r) => {
    const [gsc, ga4, queries, bing, bingAttempt] = await Promise.all([
      r.siteUrl
        ? getCached(cacheKey(r.projectId, r.siteUrl), { allowExpired: true })
        : null,
      r.ga4PropertyId
        ? getCached(ga4CacheKey(r.projectId, r.ga4PropertyId), {
            allowExpired: true,
          })
        : null,
      r.siteUrl
        ? getCached(queriesKey(r.projectId, r.siteUrl), { allowExpired: true })
        : null,
      r.bingSiteUrl && hasBingWorkspaceAccess(organizationId)
        ? BingWebmasterService.getStoredSnapshot({
            projectId: r.projectId,
            organizationId,
          })
        : null,
      r.bingSiteUrl
        ? getCached(bingAttemptKey(organizationId, r), { allowExpired: true })
        : null,
    ]);
    return { gsc, ga4, queries, bing, bingAttempt };
  });
}

function bingMetrics(
  snapshot: BingSnapshot,
): NonNullable<FleetInventoryRow["bing"]["metrics"]> {
  const dates = snapshot.performance
    .map((r) => r.date)
    .filter((d): d is string => d !== null)
    .sort();
  const knownDates =
    dates.length === snapshot.performance.length && dates.length > 0;
  const clicks = snapshot.performance.length
    ? snapshot.performance.reduce((n, r) => n + r.clicks, 0)
    : null;
  const impressions = snapshot.performance.length
    ? snapshot.performance.reduce((n, r) => n + r.impressions, 0)
    : null;
  return {
    clicks,
    impressions,
    ctr: impressions && clicks !== null ? clicks / impressions : null,
    startDate: knownDates ? dates[0]! : null,
    endDate: knownDates ? dates.at(-1)! : null,
  };
}

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
    return { ran: 0, pending: 0, budgetUsed: 0, timedOut: false, skipped: true };
  warmStartedAt = Date.now();
  try {
    return await warmFleetCachesOnce(organizationId, budget);
  } finally {
    warmStartedAt = 0;
  }
}

async function warmFleetCachesOnce(
  organizationId: string,
  budget: number,
) {
  const deadline = Date.now() + WARM_MAX_MS;
  const limit = Math.max(0, Math.min(WARM_BUDGET_DEFAULT, Math.floor(budget)));
  const allRows = await listFleet(organizationId);
  // Authorization checks are a handful of keys; per-site evidence is read
  // one window at a time below so the read never eats the whole deadline.
  const checks = await readAuthChecks(allRows, organizationId);
  type Task = {
    id: string;
    cost: number;
    google?: GoogleIdentity;
    run: () => Promise<void>;
  };
  let tasks: Task[] = [];
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
  const cursorKey = `fleet-warm-cursor:v1:${organizationId}`;
  const savedCursor = await getCached(cursorKey);
  const cursorProject =
    typeof savedCursor === "string" ? savedCursor.split(":")[0]! : "";
  const sortedRows = [...allRows].sort((a, b) =>
    a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0,
  );
  const startRow = Math.max(
    0,
    sortedRows.findIndex((r) => r.projectId >= cursorProject),
  );
  const rotatedRows = [
    ...sortedRows.slice(startRow),
    ...sortedRows.slice(0, startRow),
  ];
  let lastId: string | null = null;
  let scannedRows = 0;
  let totalTasks = 0;
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
  for (
    let offset = 0;
    offset < rotatedRows.length;
    offset += WARM_SCAN_ROWS
  ) {
    if (timedOut || Date.now() >= deadline - 20_000 || used >= limit) break;
    const rows = rotatedRows.slice(offset, offset + WARM_SCAN_ROWS);
    const evidence = await readFleetEvidence(rows, organizationId);
    scannedRows += rows.length;
    tasks = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const e = evidence[i]!;
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
                ga4CacheKey(r.projectId, r.ga4PropertyId!),
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
        (!e.bing || ageMs(e.bing.fetchedAt) >= BING_REFRESH_AFTER_MS)
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
            } catch (error) {
              // Keep the provider's reason (capped) so the fleet alert says
              // what is wrong instead of a generic retry hint.
              const reason =
                error instanceof Error && error.message
                  ? `: ${error.message.slice(0, 160)}`
                  : "; check connector access or retry.";
              if (canWrite())
                await setCached(
                  bingAttemptKey(organizationId, r),
                  {
                    fetchedAt: new Date().toISOString(),
                    error: `Bing snapshot refresh failed${reason}`,
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
    const after =
      offset === 0 && typeof savedCursor === "string"
        ? tasks.findIndex((t) => t.id > savedCursor)
        : 0;
    const start = after < 0 ? 0 : after;
    const ordered = [...tasks.slice(start), ...tasks.slice(0, start)];
    let next = 0;
    let lastProcessed = -1;
    let processed = 0;
    const markProcessed = (index: number, task: Task) => {
      processed++;
      if (index > lastProcessed) {
        lastProcessed = index;
        lastId = task.id;
      }
    };
    await Promise.all(
      Array.from({ length: WARM_CONCURRENCY }, async () => {
        while (
          next < ordered.length &&
          !timedOut &&
          Date.now() < deadline - 20_000 &&
          used < limit
        ) {
          const index = next++;
          const task = ordered[index]!;
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
    totalTasks += tasks.length;
    // Stop where work ran out; otherwise the whole window is done, so the
    // next warm (or the next window) starts after its last site.
    if (processed < ordered.length) break;
    lastId = `${rows.at(-1)!.projectId}:~`;
  }
  if (lastId) await setCached(cursorKey, lastId, 7 * 24 * 3600);
  return {
    ran,
    pending: Math.max(0, totalTasks - ran),
    scannedRows,
    budgetUsed: used,
    timedOut,
    skipped: false,
  };
}

/** The most common failures per provider; one expired grant explains a fleet. */
function providerIssues(inventory: FleetInventoryRow[]): FleetProviderIssue[] {
  const out: FleetProviderIssue[] = [];
  for (const provider of ["gsc", "ga4", "bing"] as const) {
    const byError = new Map<string, { sites: number; projectId: string }>();
    for (const row of inventory) {
      const entry = row[provider];
      if (entry.status !== "error" || !entry.error) continue;
      const found = byError.get(entry.error);
      if (found) found.sites++;
      else byError.set(entry.error, { sites: 1, projectId: row.projectId });
    }
    out.push(
      ...[...byError.entries()]
        .sort((a, b) => b[1].sites - a[1].sites)
        .slice(0, 3)
        .map(([error, v]) => ({ provider, error, ...v })),
    );
  }
  return out.sort((a, b) => b.sites - a.sites);
}

async function auditRollup(
  projectIds: Set<string>,
  domains: Map<string, string>,
) {
  const latest = await db
    .select({
      id: audits.id,
      projectId: audits.projectId,
      status: audits.status,
      completedAt: audits.completedAt,
    })
    .from(audits)
    .where(
      sql`${audits.startedAt} = (select max(a2.started_at) from audits a2 where a2.project_id = ${audits.projectId})`,
    );
  const mine = latest.filter((a) => projectIds.has(a.projectId));
  const byAudit = new Map(mine.map((a) => [a.id, a]));
  const ids = [...byAudit.keys()];
  const types = new Map<
    string,
    { type: string; severity: string; count: number; sites: number }
  >();
  const critical = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await db
      .select({
        auditId: auditIssues.auditId,
        type: auditIssues.issueType,
        severity: auditIssues.severity,
        n: sql<number>`count(*)`,
      })
      .from(auditIssues)
      .where(inArray(auditIssues.auditId, chunk))
      .groupBy(
        auditIssues.auditId,
        auditIssues.issueType,
        auditIssues.severity,
      );
    for (const r of rows) {
      const k = `${r.type}|${r.severity}`;
      const t = types.get(k) ?? {
        type: r.type,
        severity: r.severity,
        count: 0,
        sites: 0,
      };
      t.count += Number(r.n);
      t.sites += 1;
      types.set(k, t);
      if (r.severity === "critical") {
        const pid = byAudit.get(r.auditId)!.projectId;
        critical.set(pid, (critical.get(pid) ?? 0) + Number(r.n));
      }
    }
  }
  const sevRank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  let lastAuditAt: string | null = null;
  for (const a of mine)
    if (a.completedAt && (!lastAuditAt || a.completedAt > lastAuditAt))
      lastAuditAt = a.completedAt;
  return {
    audited: mine.filter((a) => a.status === "completed").length,
    running: mine.filter(
      (a) => String(a.status) === "running" || String(a.status) === "pending",
    ).length,
    withCritical: critical.size,
    lastAuditAt,
    issuesByType: [...types.values()].sort(
      (a, b) =>
        (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3) ||
        b.count - a.count,
    ),
    worstSites: [...critical.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([projectId, n]) => ({
        projectId,
        domain: domains.get(projectId) ?? projectId,
        critical: n,
      })),
  };
}

function parseIds(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function healthRollup(
  organizationId: string,
): Promise<FleetDashboard["health"]> {
  try {
    const rows = await db
      .select()
      .from(domainHealthCurrent)
      .where(eq(domainHealthCurrent.organizationId, organizationId));
    const byClass: Record<string, number> = {};
    let lastCheckedAt: string | null = null;
    let missingTag = 0;
    const down: FleetDownDomain[] = [];
    for (const r of rows) {
      byClass[r.class] = (byClass[r.class] ?? 0) + 1;
      if (!lastCheckedAt || r.checkedAt > lastCheckedAt)
        lastCheckedAt = r.checkedAt;
      if (
        r.class === "live_ok" &&
        parseIds(r.ga4IdsJson).length === 0 &&
        parseIds(r.gtmIdsJson).length === 0
      )
        missingTag += 1;
      if (r.class !== "live_ok" && r.class !== "redirect_intended")
        down.push({
          projectId: r.projectId ?? null,
          domain: r.domain,
          class: r.class,
          httpStatus: r.httpStatus ?? null,
          finalUrl: r.finalUrl ?? null,
          error: r.error ?? null,
          onCloudflare: Boolean(r.onCloudflare),
          sslDaysRemaining: r.sslDaysRemaining ?? null,
          checkedAt: r.checkedAt,
        });
    }
    down.sort(
      (a, b) =>
        a.class.localeCompare(b.class) || a.domain.localeCompare(b.domain),
    );
    return {
      available: true,
      checked: rows.length,
      lastCheckedAt,
      byClass,
      down,
      missingTag,
    };
  } catch (error) {
    // Table not migrated yet: the panel says so instead of failing the page.
    console.error("[fleet] domain health unavailable", error);
    return {
      available: false,
      checked: 0,
      lastCheckedAt: null,
      byClass: {},
      down: [],
      missingTag: 0,
    };
  }
}

export async function buildFleetDashboard(
  organizationId: string,
): Promise<FleetDashboard> {
  const w = windows();
  const rows = await listFleet(organizationId);
  const domains = new Map(rows.map((r) => [r.projectId, r.domain ?? r.name]));
  const [evidence, checks] = await Promise.all([
    readFleetEvidence(rows, organizationId),
    readAuthChecks(rows, organizationId),
  ]);
  const inventory: FleetInventoryRow[] = rows.map((r, i) => {
    const e = evidence[i]!;
    const g = gscSchema.safeParse(e.gsc);
    const a = ga4Schema.safeParse(e.ga4);
    const attempt = cacheEvidenceSchema.safeParse(e.bingAttempt);
    const bingError =
      attempt.success &&
      attempt.data.error &&
      (!e.bing ||
        Date.parse(attempt.data.fetchedAt) >= Date.parse(e.bing.fetchedAt));
    return {
      projectId: r.projectId,
      name: r.name,
      domain: r.domain,
      gsc: providerEntry(
        r.siteUrl,
        r.gscAccountId,
        r.gscEmail,
        e.gsc,
        g.success
          ? {
              clicks: g.data.clicks,
              prevClicks: g.data.prevClicks,
              impressions: g.data.impressions,
              prevImpressions: g.data.prevImpressions,
              position: g.data.position,
              prevPosition: g.data.prevPosition,
            }
          : null,
        g.success && sameReportingDay(g.data.fetchedAt),
        TTL_SECONDS * 1000,
        r.gscUpdatedAt,
        googleCheck(r, "gsc", organizationId, checks),
      ),
      ga4: providerEntry(
        r.ga4PropertyId,
        r.ga4AccountId,
        r.ga4Email,
        e.ga4,
        a.success
          ? {
              sessions: a.data.sessions,
              prevSessions: a.data.prevSessions,
              users: a.data.activeUsers,
              prevUsers: a.data.prevActiveUsers,
            }
          : null,
        a.success &&
          sameReportingDay(a.data.fetchedAt, r.ga4PropertyTimeZone ?? "UTC"),
        TTL_SECONDS * 1000,
        r.ga4UpdatedAt,
        googleCheck(r, "ga4", organizationId, checks),
      ),
      bing: providerEntry(
        r.bingSiteUrl,
        null,
        null,
        bingError ? e.bingAttempt : e.bing,
        e.bing && !bingError ? bingMetrics(e.bing) : null,
        true,
        BING_MAX_AGE_MS,
      ),
    };
  });
  const gscRows = evidence.map((e, i) => {
    const parsed = gscSchema.safeParse(e.gsc);
    return inventory[i]!.gsc.status === "available" && parsed.success
      ? parsed.data
      : null;
  });
  const ga4Rows = evidence.map((e, i) => {
    const parsed = ga4Schema.safeParse(e.ga4);
    return inventory[i]!.ga4.status === "available" && parsed.success
      ? parsed.data
      : null;
  });
  const queryRows = evidence.map((e, i) => {
    const r = rows[i]!;
    const parsed = queriesSchema.safeParse(e.queries);
    if (!parsed.success) return null;
    const q = parsed.data;
    const entry = providerEntry(
      r.siteUrl,
      r.gscAccountId,
      r.gscEmail,
      q,
      q.rows,
      sameReportingDay(q.fetchedAt),
      QUERIES_TTL_SECONDS * 1000,
      r.gscUpdatedAt,
      googleCheck(r, "gsc", organizationId, checks),
    );
    return entry.status === "available" ? q : null;
  });

  const gsc = {
    sites: 0,
    clicks: 0,
    prevClicks: 0,
    impressions: 0,
    prevImpressions: 0,
    position: null as number | null,
    prevPosition: null as number | null,
    errors: 0,
  };
  let posW = 0;
  let prevPosW = 0;
  const sites: FleetSite[] = [];
  const dayMap = new Map<string, [number, number]>();
  let dailySites = 0;
  gsc.errors = inventory.filter((r) => r.gsc.status === "error").length;
  gscRows.forEach((g, i) => {
    if (!g) return;
    gsc.sites += 1;
    gsc.clicks += g.clicks;
    gsc.prevClicks += g.prevClicks;
    gsc.impressions += g.impressions;
    gsc.prevImpressions += g.prevImpressions;
    if (g.position != null) posW += g.position * g.impressions;
    if (g.prevPosition != null) prevPosW += g.prevPosition * g.prevImpressions;
    const r = rows[i]!;
    sites.push({
      projectId: r.projectId,
      domain: r.domain ?? r.name,
      clicks: g.clicks,
      prevClicks: g.prevClicks,
      impressions: g.impressions,
      delta: g.clicks - g.prevClicks,
    });
    if (g.daily?.length) {
      dailySites += 1;
      for (const [d, c, im] of g.daily) {
        const v = dayMap.get(d) ?? [0, 0];
        v[0] += c;
        v[1] += im;
        dayMap.set(d, v);
      }
    }
  });
  gsc.position = gsc.impressions > 0 ? posW / gsc.impressions : null;
  gsc.prevPosition =
    gsc.prevImpressions > 0 ? prevPosW / gsc.prevImpressions : null;

  // Day i of the current window lines up with day i of the previous one.
  const daily: FleetDashboard["daily"] = [];
  const start = Date.parse(`${w.curStart}T00:00:00Z`);
  const prevStart = Date.parse(`${w.prevStart}T00:00:00Z`);
  for (let i = 0; i < 28; i++) {
    const d = new Date(start + i * 86400_000).toISOString().slice(0, 10);
    const pd = new Date(prevStart + i * 86400_000).toISOString().slice(0, 10);
    const cur = dayMap.get(d) ?? [0, 0];
    const prev = dayMap.get(pd) ?? [0, 0];
    daily.push({
      day: i + 1,
      date: d,
      clicks: cur[0],
      impressions: cur[1],
      prevClicks: prev[0],
      prevImpressions: prev[1],
    });
  }

  const ga4 = {
    sites: 0,
    sessions: 0,
    prevSessions: 0,
    users: 0,
    prevUsers: 0,
    zeroSessionSites: 0,
    errors: 0,
  };
  ga4.errors = inventory.filter((r) => r.ga4.status === "error").length;
  for (const a of ga4Rows) {
    if (!a) continue;
    ga4.sites += 1;
    ga4.sessions += a.sessions;
    ga4.prevSessions += a.prevSessions;
    ga4.users += a.activeUsers;
    ga4.prevUsers += a.prevActiveUsers;
    if (a.sessions === 0) ga4.zeroSessionSites += 1;
  }

  const qAgg = new Map<
    string,
    { clicks: number; impressions: number; posW: number; sites: number }
  >();
  let queriesCached = 0;
  for (const q of queryRows) {
    if (!q || q.error) continue;
    queriesCached += 1;
    for (const [query, clicks, impressions, position] of q.rows) {
      const v = qAgg.get(query) ?? {
        clicks: 0,
        impressions: 0,
        posW: 0,
        sites: 0,
      };
      v.clicks += clicks;
      v.impressions += impressions;
      v.posW += position * impressions;
      v.sites += 1;
      qAgg.set(query, v);
    }
  }
  const topQueriesExport = [...qAgg.entries()]
    .sort(
      (a, b) =>
        b[1].clicks - a[1].clicks || b[1].impressions - a[1].impressions,
    )
    .slice(0, TOP_QUERIES_EXPORT)
    .map(([query, v]) => ({
      query,
      clicks: v.clicks,
      impressions: v.impressions,
      position:
        v.impressions > 0
          ? Math.round((v.posW / v.impressions) * 10) / 10
          : null,
      sites: v.sites,
    }));
  const topQueries = topQueriesExport.slice(0, 15);

  const bingSnapshots = evidence.flatMap((e, i) =>
    inventory[i]!.bing.status === "available" && e.bing ? [e.bing] : [],
  );
  const dateSets = bingSnapshots.map((s) =>
    s.performance.map((r) => r.date).sort(),
  );
  // Never present mixed/unknown provider periods as one fleet reporting window.
  const uniformDates =
    dateSets.length > 0 &&
    dateSets[0]!.length > 0 &&
    dateSets.every(
      (dates) =>
        dates.every((d) => d !== null) &&
        JSON.stringify(dates) === JSON.stringify(dateSets[0]),
    );
  const bing: FleetDashboard["bing"] = {
    sites: bingSnapshots.length,
    clicks: uniformDates
      ? bingSnapshots.reduce(
          (n, s) => n + s.performance.reduce((sum, r) => sum + r.clicks, 0),
          0,
        )
      : null,
    impressions: uniformDates
      ? bingSnapshots.reduce(
          (n, s) =>
            n + s.performance.reduce((sum, r) => sum + r.impressions, 0),
          0,
        )
      : null,
    errors: inventory.filter((r) => r.bing.status === "error").length,
    dateBasis: "provider-returned",
    startDate: uniformDates ? dateSets[0]![0]! : null,
    endDate: uniformDates ? dateSets[0]!.at(-1)! : null,
    limitations: [
      ...new Set([
        "Bing combines search surfaces and is not comparable to Google Search Console.",
        "Missing provider rows are not zero activity; date coverage and timezone are provider-defined.",
        "Fleet totals require identical known provider-returned dates across all included Bing snapshots; no previous-period comparison is inferred.",
        ...bingSnapshots.flatMap((s) => s.limitations),
      ]),
    ],
  };
  const byDelta = [...sites].sort((a, b) => b.delta - a.delta);
  const audit = await auditRollup(
    new Set(rows.map((r) => r.projectId)),
    domains,
  );
  const health = await healthRollup(organizationId);

  return {
    generatedAt: new Date().toISOString(),
    inventory,
    providerIssues: providerIssues(inventory),
    windows: w,
    coverage: {
      projects: rows.length,
      gscLinked: rows.filter((r) => r.siteUrl).length,
      ga4Linked: rows.filter((r) => r.ga4PropertyId).length,
      gscCached: gsc.sites,
      ga4Cached: ga4.sites,
      bingLinked: rows.filter((r) => r.bingSiteUrl).length,
      bingCached: bing.sites,
      queriesCached,
      audited: audit.audited,
      neither: rows.filter(
        (r) => !r.siteUrl && !r.ga4PropertyId && !r.bingSiteUrl,
      ).length,
    },
    gsc,
    daily,
    dailySites,
    ga4,
    bing,
    gainers: byDelta.filter((s) => s.delta > 0).slice(0, 8),
    losers: byDelta
      .filter((s) => s.delta < 0)
      .reverse()
      .slice(0, 8),
    topQueries,
    topQueriesExport,
    audit,
    health,
  };
}

function isFreshDashboard(
  snapshot: FleetDashboard | null,
  organizationId: string,
): snapshot is FleetDashboard {
  const w = windows();
  return (
    !!snapshot &&
    Array.isArray(snapshot.inventory) &&
    Array.isArray(snapshot.providerIssues) &&
    ageMs(snapshot.generatedAt) >= 0 &&
    ageMs(snapshot.generatedAt) < SNAPSHOT_MAX_AGE_MS &&
    snapshot.windows?.curStart === w.curStart &&
    snapshot.windows?.end === w.end &&
    (hasBingWorkspaceAccess(organizationId) ||
      snapshot.coverage?.bingLinked === 0)
  );
}

/**
 * Page read: the cached snapshot, or a fresh cache-only build on a miss. The
 * domain health panel is one cheap DB read, so it is always live; otherwise it
 * could disagree with the Domain health page for up to 30 minutes.
 */
export async function getFleetDashboard(
  organizationId: string,
  refresh = false,
) {
  if (!refresh) {
    const cached = (await getCached(
      snapshotKey(organizationId),
    )) as FleetDashboard | null;
    if (isFreshDashboard(cached, organizationId))
      return { ...cached, health: await healthRollup(organizationId) };
  }
  const fresh = await buildFleetDashboard(organizationId);
  await setCached(snapshotKey(organizationId), fresh, SNAPSHOT_TTL_SECONDS);
  return fresh;
}

/**
 * Site table rows, read from the fleet snapshot: one cache object instead of
 * one cache read per site per provider (3,000+ on this fleet, which queued
 * behind the local R2 emulation and stalled every other request). Audit
 * summaries are a database read. Numbers lag the caches by up to one snapshot
 * rebuild (30 minutes).
 */
export async function getPortfolioOverview(organizationId: string): Promise<{
  rows: PortfolioRow[];
  /** Provider connections with no usable snapshot entry yet (GSC plus GA4). */
  pending: number;
  pendingGsc: number;
  pendingGa4: number;
  /** Connections showing earlier numbers while a refresh is due. */
  refreshingGsc: number;
  refreshingGa4: number;
  generatedAt: string;
}> {
  const snapshot = await getFleetDashboard(organizationId);
  const auditMap = await getAuditSummaries(
    snapshot.inventory.map((r) => r.projectId),
  );
  const fetchedAt = (entry: { fetchedAt: string | null }) =>
    entry.fetchedAt ?? snapshot.generatedAt;
  let pendingGsc = 0;
  let pendingGa4 = 0;
  let refreshingGsc = 0;
  let refreshingGa4 = 0;
  const rows = snapshot.inventory.map((r): PortfolioRow => {
    let gsc: PortfolioGsc | null = null;
    if (r.gsc.status === "available" && r.gsc.metrics)
      gsc = { ...r.gsc.metrics, fetchedAt: fetchedAt(r.gsc) };
    else if (r.gsc.status === "stale" && r.gsc.metrics) {
      gsc = { ...r.gsc.metrics, fetchedAt: fetchedAt(r.gsc), stale: true };
      refreshingGsc++;
    } else if (r.gsc.status === "error")
      gsc = {
        clicks: 0,
        impressions: 0,
        position: null,
        prevClicks: 0,
        prevImpressions: 0,
        prevPosition: null,
        fetchedAt: fetchedAt(r.gsc),
        error: r.gsc.error ?? "GSC error",
      };
    else if (r.gsc.status !== "unlinked") pendingGsc++;
    let ga4: PortfolioGa4 | null = null;
    if (
      (r.ga4.status === "available" || r.ga4.status === "stale") &&
      r.ga4.metrics
    ) {
      ga4 = {
        sessions: r.ga4.metrics.sessions,
        activeUsers: r.ga4.metrics.users,
        prevSessions: r.ga4.metrics.prevSessions,
        prevActiveUsers: r.ga4.metrics.prevUsers,
        fetchedAt: fetchedAt(r.ga4),
        ...(r.ga4.status === "stale" && { stale: true as const }),
      };
      if (r.ga4.status === "stale") refreshingGa4++;
    } else if (r.ga4.status === "error")
      ga4 = {
        sessions: 0,
        activeUsers: 0,
        prevSessions: 0,
        prevActiveUsers: 0,
        fetchedAt: fetchedAt(r.ga4),
        error: r.ga4.error ?? "GA4 error",
      };
    else if (r.ga4.status !== "unlinked") pendingGa4++;
    return {
      projectId: r.projectId,
      name: r.name,
      domain: r.domain,
      siteUrl: r.gsc.property,
      gscEmail: r.gsc.email,
      gsc,
      ga4PropertyId: r.ga4.property,
      ga4Email: r.ga4.email,
      ga4,
      audit: auditMap.get(r.projectId) ?? null,
    };
  });
  return {
    rows,
    pending: pendingGsc + pendingGa4,
    pendingGsc,
    pendingGa4,
    refreshingGsc,
    refreshingGa4,
    generatedAt: snapshot.generatedAt,
  };
}

/**
 * Scheduler hook (every 5 minutes). One organization per turn, round-robin,
 * prevents many workspaces from multiplying the self-hosted request deadline.
 * Each warm turn has a persistent project/provider cursor, a 90-call ceiling
 * (Bing costs two calls), three workers and a 100s awaiting deadline. Coverage
 * is intentionally honest while a large/cold fleet gradually fills in.
 */
/** Every five-minute tick (minus jitter) that is not rebuilding the snapshot. */
const WARM_EVERY_MS = 4.5 * 60 * 1000;
const WARM_BUDGET = WARM_BUDGET_DEFAULT;
// Skip a tick while the previous one is still running (same isolate).
let scheduledStartedAt = 0;
export async function runScheduledFleetDashboard() {
  if (scheduledStartedAt && Date.now() - scheduledStartedAt < 20 * 60 * 1000)
    return;
  scheduledStartedAt = Date.now();
  try {
    await runScheduledFleetDashboardOnce();
  } finally {
    scheduledStartedAt = 0;
  }
}

async function runScheduledFleetDashboardOnce() {
  const orgs = await db
    .selectDistinct({ organizationId: projects.organizationId })
    .from(projects)
    .where(isNull(projects.archivedAt))
    .orderBy(projects.organizationId);
  if (!orgs.length) return;
  const orgCursorKey = "fleet-scheduler-cursor:v1";
  const cursor = await getCached(orgCursorKey);
  const selected =
    orgs.find((o) => typeof cursor !== "string" || o.organizationId > cursor) ??
    orgs[0]!;
  await setCached(orgCursorKey, selected.organizationId, 7 * 24 * 3600);
  const { organizationId } = selected;
  // A snapshot rebuild reads every site's evidence and takes most of a tick on
  // a large fleet, so a tick does either the rebuild or a warm, never both
  // (both together overran the 150 s scheduler limit).
  const snap = (await getCached(
    snapshotKey(organizationId),
  )) as FleetDashboard | null;
  if (!isFreshDashboard(snap, organizationId)) {
    const startedAt = Date.now();
    const fresh = await buildFleetDashboard(organizationId);
    await setCached(snapshotKey(organizationId), fresh, SNAPSHOT_TTL_SECONDS);
    console.log("[fleet] rebuilt snapshot", {
      organizationId,
      ms: Date.now() - startedAt,
    });
    return;
  }
  const guardKey = `fleet-warm:v2:${organizationId}`;
  const guard = (await getCached(guardKey)) as { at: string } | null;
  if (!guard || ageMs(guard.at) > WARM_EVERY_MS) {
    await setCached(guardKey, { at: new Date().toISOString() }, 24 * 3600);
    const startedAt = Date.now();
    const warm = await warmFleetCaches(organizationId, WARM_BUDGET);
    console.log("[fleet] warmed caches", {
      organizationId,
      ...warm,
      ms: Date.now() - startedAt,
    });
  }
}
