import { z } from "zod";

const windowsSchema = z.object({
  curStart: z.string(),
  end: z.string(),
  prevStart: z.string(),
  prevEnd: z.string(),
});

const siteQueriesSchema = z.object({
  fetchedAt: z.string(),
  rows: z.array(z.tuple([z.string(), z.number(), z.number(), z.number()])),
  error: z.string().optional(),
});
export type SiteQueries = z.infer<typeof siteQueriesSchema>;
const fleetSiteSchema = z.object({
  projectId: z.string(),
  domain: z.string(),
  clicks: z.number(),
  prevClicks: z.number(),
  impressions: z.number(),
  delta: z.number(),
});
export type FleetSite = z.infer<typeof fleetSiteSchema>;
const fleetQuerySchema = z.object({
  query: z.string(),
  clicks: z.number(),
  impressions: z.number(),
  position: z.number().nullable(),
  sites: z.number(),
});
const fleetDownDomainSchema = z.object({
  projectId: z.string().nullable(),
  domain: z.string(),
  class: z.string(),
  httpStatus: z.number().nullable(),
  finalUrl: z.string().nullable(),
  error: z.string().nullable(),
  onCloudflare: z.boolean(),
  sslDaysRemaining: z.number().nullable(),
  checkedAt: z.string(),
});
export type FleetDownDomain = z.infer<typeof fleetDownDomainSchema>;
function providerSchema<T extends z.ZodType>(metrics: T) {
  return z.object({
    status: z.enum(["available", "error", "missing", "stale", "unlinked"]),
    property: z.string().nullable(),
    accountId: z.string().nullable(),
    email: z.string().nullable(),
    fetchedAt: z.string().nullable(),
    error: z.string().nullable(),
    metrics: metrics.nullable(),
  });
}
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
const fleetInventoryRowSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  gsc: providerSchema(
    z.object({
      clicks: z.number(),
      prevClicks: z.number(),
      impressions: z.number(),
      prevImpressions: z.number(),
      position: z.number().nullable(),
      prevPosition: z.number().nullable(),
    }),
  ),
  ga4: providerSchema(
    z.object({
      sessions: z.number(),
      prevSessions: z.number(),
      users: z.number(),
      prevUsers: z.number(),
    }),
  ),
  bing: providerSchema(
    z.object({
      clicks: z.number().nullable(),
      impressions: z.number().nullable(),
      ctr: z.number().nullable(),
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
    }),
  ),
});
export type FleetInventoryRow = z.infer<typeof fleetInventoryRowSchema>;
const fleetProviderIssueSchema = z.object({
  provider: z.union([z.literal("gsc"), z.literal("ga4"), z.literal("bing")]),
  error: z.string(),
  sites: z.number(),
  projectId: z.string(),
});
export type FleetProviderIssue = z.infer<typeof fleetProviderIssueSchema>;
export const fleetDashboardSchema = z.object({
  generatedAt: z.string(),
  inventory: z.array(fleetInventoryRowSchema),
  providerIssues: z.array(fleetProviderIssueSchema),
  windows: windowsSchema,
  coverage: z.object({
    projects: z.number(),
    gscLinked: z.number(),
    ga4Linked: z.number(),
    gscCached: z.number(),
    ga4Cached: z.number(),
    bingLinked: z.number(),
    bingCached: z.number(),
    queriesCached: z.number(),
    audited: z.number(),
    neither: z.number(),
  }),
  gsc: z.object({
    sites: z.number(),
    clicks: z.number(),
    prevClicks: z.number(),
    impressions: z.number(),
    prevImpressions: z.number(),
    position: z.number().nullable(),
    prevPosition: z.number().nullable(),
    errors: z.number(),
  }),
  daily: z.array(
    z.object({
      day: z.number(),
      date: z.string(),
      clicks: z.number(),
      impressions: z.number(),
      prevClicks: z.number(),
      prevImpressions: z.number(),
    }),
  ),
  dailySites: z.number(),
  ga4: z.object({
    sites: z.number(),
    sessions: z.number(),
    prevSessions: z.number(),
    users: z.number(),
    prevUsers: z.number(),
    zeroSessionSites: z.number(),
    errors: z.number(),
  }),
  bing: z.object({
    sites: z.number(),
    clicks: z.number().nullable(),
    impressions: z.number().nullable(),
    errors: z.number(),
    dateBasis: z.literal("provider-returned"),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    limitations: z.array(z.string()),
  }),
  gainers: z.array(fleetSiteSchema),
  losers: z.array(fleetSiteSchema),
  topQueries: z.array(fleetQuerySchema),
  topQueriesExport: z.array(fleetQuerySchema).optional(),
  audit: z.object({
    audited: z.number(),
    withCritical: z.number(),
    lastAuditAt: z.string().nullable(),
    running: z.number(),
    issuesByType: z.array(
      z.object({
        type: z.string(),
        severity: z.string(),
        count: z.number(),
        sites: z.number(),
      }),
    ),
    worstSites: z.array(
      z.object({
        projectId: z.string(),
        domain: z.string(),
        critical: z.number(),
      }),
    ),
  }),
  health: z.object({
    available: z.boolean(),
    checked: z.number(),
    lastCheckedAt: z.string().nullable(),
    byClass: z.record(z.string(), z.number()),
    down: z.array(fleetDownDomainSchema),
    missingTag: z.number(),
  }),
});
export type FleetDashboard = z.infer<typeof fleetDashboardSchema>;
