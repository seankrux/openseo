import { mapConcurrent as mapLimit } from "@/server/lib/map-concurrent";
import { TTL_SECONDS } from "./PortfolioService";

import { z } from "zod";

import { GSC_OAUTH_PROVIDER_ID } from "@/shared/gsc";

import { GA4_OAUTH_PROVIDER_ID } from "@/shared/ga4";

import { getCached } from "@/server/lib/r2-cache";

import { cacheKey } from "./PortfolioService";

import { ga4CacheKey } from "./PortfolioService";

import { hasBingWorkspaceAccess } from "@/server/features/bing/BingWorkspaceAccess";

import { BingWebmasterService } from "@/server/features/bing/BingWebmasterService";

import { type BingSnapshot } from "@/server/features/bing/BingWebmasterService";

import { sort as sortArray } from "remeda";

import { type FleetRow } from "./FleetDashboardRepository";

import {
  type FleetInventoryRow,
  type FleetProviderEntry,
} from "./FleetDashboardTypes";

export const SNAPSHOT_TTL_SECONDS = 6 * 60 * 60;

/** The scheduler rebuilds the snapshot when it is older than this. */
export const SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;

/** Refresh GSC/GA4 totals this long before their 12h cache expires. */
export const REFRESH_AFTER_MS = 9 * 60 * 60 * 1000;

export const QUERIES_TTL_SECONDS = 36 * 60 * 60;

export const QUERIES_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

export const QUERIES_PER_SITE = 25;

export const WARM_CONCURRENCY = 3;

export const WARM_BUDGET_DEFAULT = 90;

/** Leave room for cache-only assembly inside the self-hosted 150s scheduler. */
export const WARM_MAX_MS = 100_000;

export const ERROR_RETRY_MS = 30 * 60 * 1000;

export const AUTH_CHECK_TTL_SECONDS = 30 * 60;

export const BING_MAX_AGE_MS = TTL_SECONDS * 1000;

/** Parallel R2 reads while assembling the snapshot (1,600+ sites x 3 keys). */
const READ_CONCURRENCY = 32;

/** Rows kept for the CSV export (the dashboard shows the first 15). */
export const TOP_QUERIES_EXPORT = 1000;

export function snapshotKey(organizationId: string) {
  // v3 adds complete provider inventory, authorization evidence and Bing.
  // v4 adds the provider issue summary shown above the dashboard.
  return `fleet-dashboard:v4:${organizationId}`;
}

export function queriesKey(projectId: string, siteUrl: string) {
  return `portfolio-gscq:v1:${projectId}:${siteUrl}`;
}

export function ageMs(fetchedAt: string | undefined): number {
  const t = fetchedAt ? Date.parse(fetchedAt) : NaN;
  return Number.isNaN(t) ? Infinity : Date.now() - t;
}

const countSchema = z.number().finite().nonnegative();

export const cacheEvidenceSchema = z.object({
  fetchedAt: z.string(),
  error: z.string().optional(),
});

export const gscSchema = cacheEvidenceSchema.extend({
  clicks: countSchema,
  prevClicks: countSchema,
  impressions: countSchema,
  prevImpressions: countSchema,
  position: countSchema.nullable(),
  prevPosition: countSchema.nullable(),
  daily: z.array(z.tuple([z.string(), countSchema, countSchema])).optional(),
});

export const ga4Schema = cacheEvidenceSchema.extend({
  sessions: countSchema,
  prevSessions: countSchema,
  activeUsers: countSchema,
  prevActiveUsers: countSchema,
});

export const queriesSchema = cacheEvidenceSchema.extend({
  rows: z.array(z.tuple([z.string(), countSchema, countSchema, countSchema])),
});

const authCheckSchema = z.object({
  checkedAt: z.string(),
  revision: z.string().nullable(),
  error: z.string().nullable(),
});

export type AuthCheck = z.infer<typeof authCheckSchema>;

export type GoogleIdentity = {
  key: string;
  providerId: typeof GSC_OAUTH_PROVIDER_ID | typeof GA4_OAUTH_PROVIDER_ID;
  userId: string | null;
  accountId: string | null;
  revision: string | null;
};

export function googleIdentity(
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

export async function readAuthChecks(rows: FleetRow[], organizationId: string) {
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

export function googleCheck(
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

export function connectionTime(value: string) {
  // SQL text timestamps are UTC even on a non-UTC self-hosted process.
  return Date.parse(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value,
  );
}

export function sameReportingDay(fetchedAt: string, timeZone = "UTC") {
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

export function providerEntry<Metrics>({
  property,
  accountId,
  email,
  evidence,
  metrics,
  currentWindow,
  maxAgeMs,
  updatedAt = null,
  auth,
}: {
  property: string | null;
  accountId: string | null;
  email: string | null;
  evidence: unknown;
  metrics: Metrics | null;
  currentWindow: boolean;
  maxAgeMs: number;
  updatedAt?: string | null;
  auth?: AuthCheck;
}): FleetProviderEntry<Metrics> {
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

export function bingAttemptKey(organizationId: string, r: FleetRow) {
  return `fleet-bing-attempt:v1:${organizationId}:${r.projectId}:${r.bingBindingId}`;
}

export async function readFleetEvidence(
  rows: FleetRow[],
  organizationId: string,
) {
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

export function bingMetrics(
  snapshot: BingSnapshot,
): NonNullable<FleetInventoryRow["bing"]["metrics"]> {
  const dates = sortArray(
    snapshot.performance
      .map((r) => r.date)
      .filter((d): d is string => d !== null),
    (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  );
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
    startDate: knownDates ? dates[0] : null,
    endDate: knownDates ? (dates.at(-1) ?? null) : null,
  };
}
