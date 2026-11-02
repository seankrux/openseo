import { z } from "zod";
import type { GscService } from "@/server/features/gsc/services/GscService";
import type { Ga4RunReportResponse } from "@/server/lib/ga4Client";
import {
  gscProvenanceSchema,
  ga4ProvenanceSchema,
  type StoredGscProvenance,
  type StoredGa4Provenance,
} from "@/server/features/project-alerts/GoogleSnapshotProvenance";

const count = z.number().finite().nonnegative();
const gscCacheSchema = z.object({
  clicks: count,
  impressions: count,
  position: count.nullable(),
  prevClicks: count,
  prevImpressions: count,
  prevPosition: count.nullable(),
  fetchedAt: z.string().datetime(),
  provenance: gscProvenanceSchema.optional(),
  error: z.string().optional(),
});
const ga4CacheSchema = z.object({
  sessions: count,
  activeUsers: count,
  prevSessions: count,
  prevActiveUsers: count,
  fetchedAt: z.string().datetime(),
  provenance: ga4ProvenanceSchema.optional(),
  error: z.string().optional(),
});
export type PortfolioGsc = z.infer<typeof gscCacheSchema>;
export type PortfolioGa4 = z.infer<typeof ga4CacheSchema>;
export function readPortfolioGscCache(value: unknown): PortfolioGsc | null {
  const parsed = gscCacheSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function readPortfolioGa4Cache(value: unknown): PortfolioGa4 | null {
  const parsed = ga4CacheSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

type Scope = { projectId: string; organizationId: string };
type BoundConnection = Scope & {
  id: string;
  connectedByUserId: string;
  updatedAt: string;
};
type GscBinding = BoundConnection & {
  siteUrl: string;
  gscAccountId: string | null;
};
type Ga4Binding = BoundConnection & {
  propertyId: string;
  ga4AccountId: string;
};
function sameBinding(before: BoundConnection, after: BoundConnection | null) {
  return (
    !!after &&
    before.id === after.id &&
    before.projectId === after.projectId &&
    before.organizationId === after.organizationId &&
    before.connectedByUserId === after.connectedByUserId &&
    before.updatedAt === after.updatedAt
  );
}
export function sameGscConnection(
  before: GscBinding,
  after: GscBinding | null,
) {
  return (
    sameBinding(before, after) &&
    before.siteUrl === after?.siteUrl &&
    before.gscAccountId === after?.gscAccountId
  );
}
export function sameGa4Connection(
  before: Ga4Binding,
  after: Ga4Binding | null,
) {
  return (
    sameBinding(before, after) &&
    before.propertyId === after?.propertyId &&
    before.ga4AccountId === after?.ga4AccountId
  );
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
export function googleSnapshotWindows(lagDays: number) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - lagDays);
  const curStart = new Date(end);
  curStart.setUTCDate(curStart.getUTCDate() - 27);
  const prevEnd = new Date(curStart);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - 27);
  return {
    current: { startDate: isoDay(curStart), endDate: isoDay(end) },
    previous: { startDate: isoDay(prevStart), endDate: isoDay(prevEnd) },
  };
}

type SnapshotInput<
  Provenance extends StoredGscProvenance | StoredGa4Provenance,
> = Scope & {
  property: string;
  binding: Omit<Provenance["binding"], "accountId"> & {
    accountId: string | null;
  };
  periods: Provenance["periods"];
  fetchedAt: string;
};
export function aggregateGscSnapshot(
  input: SnapshotInput<StoredGscProvenance>,
  response: Awaited<ReturnType<typeof GscService.getPerformance>>,
): PortfolioGsc {
  if (
    response.siteUrl !== input.property ||
    response.request.dataState !== "final"
  )
    throw new Error("GSC response scope did not match collection");
  const rows = z
    .array(
      z.object({
        keys: z.tuple([z.string().date()]),
        clicks: count,
        impressions: count,
        position: count,
      }),
    )
    .max(56)
    .parse(response.rows);
  if (
    rows.some(
      (row) =>
        row.keys[0] < input.periods.previous.startDate ||
        row.keys[0] > input.periods.current.endDate,
    ) ||
    new Set(rows.map((row) => row.keys[0])).size !== rows.length
  )
    throw new Error("Invalid GSC response rows");
  const aggregate = (period: StoredGscProvenance["periods"]["current"]) => {
    let clicks = 0;
    let impressions = 0;
    let posWeighted = 0;
    for (const row of rows) {
      if (row.keys[0] < period.startDate || row.keys[0] > period.endDate)
        continue;
      clicks += row.clicks;
      impressions += row.impressions;
      posWeighted += row.position * row.impressions;
    }
    return {
      clicks,
      impressions,
      position: impressions > 0 ? posWeighted / impressions : null,
    };
  };
  const current = aggregate(input.periods.current);
  const previous = aggregate(input.periods.previous);
  const snapshot = {
    ...current,
    prevClicks: previous.clicks,
    prevImpressions: previous.impressions,
    prevPosition: previous.position,
    fetchedAt: input.fetchedAt,
  };
  // Legacy OAuth fallback can collect totals, but cannot establish account identity.
  if (input.binding.accountId === null) return snapshot;
  return {
    ...snapshot,
    provenance: gscProvenanceSchema.parse({
      version: 1,
      kind: "gsc",
      projectId: input.projectId,
      organizationId: input.organizationId,
      property: response.siteUrl,
      binding: input.binding,
      periods: input.periods,
      dateBasis: {
        timeZone: "America/Los_Angeles",
        windowAnchor: "utc-date",
        lagDays: 3,
      },
      request: response.request,
      quality: {
        complete: rows.length < (response.request.rowLimit ?? 0),
        requestVerified: true,
        rowsValid: true,
        rowCount: rows.length,
      },
    }),
  };
}

function ga4ResponseQuality(response: Ga4RunReportResponse, rowCount: number) {
  const metadata = response.metadata;
  const sampleCount = z.string().regex(/^\d+$/);
  const sampling = z
    .array(
      z
        .object({
          samplesReadCount: sampleCount,
          samplingSpaceSize: sampleCount,
        })
        .refine(
          (sample) =>
            BigInt(sample.samplingSpaceSize) > 0n &&
            BigInt(sample.samplesReadCount) <= BigInt(sample.samplingSpaceSize),
        ),
    )
    .optional()
    .parse(metadata?.samplingMetadatas);
  const sampled =
    sampling?.some(
      (sample) =>
        BigInt(sample.samplesReadCount) < BigInt(sample.samplingSpaceSize),
    ) ?? null;
  const thresholded = metadata?.subjectToThresholding ?? null;
  const otherRowLoss = metadata?.dataLossFromOtherRow ?? null;
  const restrictions =
    metadata?.schemaRestrictionResponse?.activeMetricRestrictions;
  const restricted = restrictions ? restrictions.length > 0 : null;
  return {
    complete:
      response.metricHeaders?.length === 2 &&
      response.rowCount === rowCount &&
      [sampled, thresholded, otherRowLoss, restricted].every(
        (flag) => flag === false,
      ),
    rowsValid: true,
    rowCount: response.rowCount ?? null,
    sampled,
    thresholded,
    otherRowLoss,
    restricted,
  };
}
export function aggregateGa4Snapshot(
  input: SnapshotInput<StoredGa4Provenance>,
  request: unknown,
  response: Ga4RunReportResponse,
): PortfolioGa4 {
  const metricValue = z.object({
    value: z.string().regex(/^\d+$/).transform(Number).pipe(count),
  });
  const rows = z
    .array(
      z.object({
        dimensionValues: z.tuple([
          z.object({ value: z.enum(["date_range_0", "date_range_1"]) }),
        ]),
        metricValues: z.tuple([metricValue, metricValue]),
      }),
    )
    .max(2)
    .parse(response.rows ?? []);
  if (
    new Set(rows.map((row) => row.dimensionValues[0].value)).size !==
    rows.length
  )
    throw new Error("Duplicate GA4 date-range rows");
  if (response.rowCount !== undefined && response.rowCount !== rows.length)
    throw new Error("GA4 row count did not match the response");
  if (
    response.metricHeaders &&
    (response.metricHeaders.length !== 2 ||
      response.metricHeaders[0]?.name !== "sessions" ||
      response.metricHeaders[1]?.name !== "activeUsers")
  )
    throw new Error("GA4 metric headers did not match the request");
  const totals = {
    sessions: 0,
    activeUsers: 0,
    prevSessions: 0,
    prevActiveUsers: 0,
  };
  for (const row of rows) {
    if (row.dimensionValues[0].value === "date_range_1") {
      totals.prevSessions = row.metricValues[0].value;
      totals.prevActiveUsers = row.metricValues[1].value;
    } else {
      totals.sessions = row.metricValues[0].value;
      totals.activeUsers = row.metricValues[1].value;
    }
  }
  return {
    ...totals,
    fetchedAt: input.fetchedAt,
    provenance: ga4ProvenanceSchema.parse({
      version: 1,
      kind: "ga4",
      projectId: input.projectId,
      organizationId: input.organizationId,
      property: input.property,
      binding: input.binding,
      periods: input.periods,
      dateBasis: {
        timeZone: response.metadata?.timeZone ?? null,
        windowAnchor: "utc-date",
        lagDays: 1,
      },
      request,
      quality: ga4ResponseQuality(response, rows.length),
    }),
  };
}
