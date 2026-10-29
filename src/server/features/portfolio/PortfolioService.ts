// CityThrive fork: per-project Search Console and GA4 fetchers and the audit
// summary query behind the fleet pages. Results are cached per project in the
// R2 cache (12h TTL); FleetDashboardService warms them on a budget and serves
// the site table and dashboard from one assembled snapshot.
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  gscConnections,
  ga4Connections,
  audits,
  auditIssues,
  auditLighthouseResults,
} from "@/db/schema";
import { GscService } from "@/server/features/gsc/services/GscService";
import { createGa4DataClient } from "@/server/lib/ga4Client";
import { ga4CacheKey } from "./PortfolioCacheKeys";

export { ga4CacheKey } from "./PortfolioCacheKeys";

export const TTL_SECONDS = 12 * 60 * 60;

export type PortfolioGsc = {
  clicks: number;
  impressions: number;
  position: number | null;
  prevClicks: number;
  prevImpressions: number;
  prevPosition: number | null;
  fetchedAt: string;
  /** [date, clicks, impressions] per day over both windows (fleet chart). */
  daily?: Array<[string, number, number]>;
  error?: string;
};

export type PortfolioGa4 = {
  sessions: number;
  activeUsers: number;
  prevSessions: number;
  prevActiveUsers: number;
  fetchedAt: string;
  error?: string;
};

export type PortfolioRow = {
  projectId: string;
  name: string;
  domain: string | null;
  siteUrl: string | null;
  gscEmail: string | null;
  gsc: PortfolioGsc | null;
  ga4PropertyId: string | null;
  ga4Email: string | null;
  ga4: PortfolioGa4 | null;
  audit: {
    status: string;
    completedAt: string | null;
    pagesCrawled: number;
    critical: number;
    warning: number;
    lighthouseSeo: number | null;
    lighthousePerf: number | null;
  } | null;
};

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

export function windows() {
  const end = new Date(Date.now() - 3 * 86400_000); // GSC data lag
  const curStart = new Date(end.getTime() - 27 * 86400_000);
  const prevEnd = new Date(curStart.getTime() - 86400_000);
  const prevStart = new Date(prevEnd.getTime() - 27 * 86400_000);
  return {
    end: isoDay(end),
    curStart: isoDay(curStart),
    prevEnd: isoDay(prevEnd),
    prevStart: isoDay(prevStart),
  };
}

export function cacheKey(projectId: string, siteUrl: string) {
  return `portfolio-gsc:v1:${projectId}:${siteUrl}`;
}

export async function fetchGsc(projectId: string): Promise<PortfolioGsc> {
  const w = windows();
  const fetchedAt = new Date().toISOString();
  try {
    const res = await GscService.getPerformance({
      projectId,
      startDate: w.prevStart,
      endDate: w.end,
      dimensions: ["date"],
      rowLimit: 200,
    } as Parameters<typeof GscService.getPerformance>[0]);
    const agg = (from: string, to: string) => {
      let clicks = 0;
      let impressions = 0;
      let posWeighted = 0;
      for (const r of res.rows) {
        const day = r.keys?.[0] ?? "";
        if (day < from || day > to) continue;
        clicks += r.clicks;
        impressions += r.impressions;
        posWeighted += r.position * r.impressions;
      }
      return {
        clicks,
        impressions,
        position: impressions > 0 ? posWeighted / impressions : null,
      };
    };
    const daily: Array<[string, number, number]> = res.rows
      .map((r): [string, number, number] => [
        r.keys?.[0] ?? "",
        r.clicks,
        r.impressions,
      ])
      .filter((d) => d[0] >= w.prevStart && d[0] <= w.end)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const cur = agg(w.curStart, w.end);
    const prev = agg(w.prevStart, w.prevEnd);
    return {
      clicks: cur.clicks,
      impressions: cur.impressions,
      position: cur.position,
      prevClicks: prev.clicks,
      prevImpressions: prev.impressions,
      prevPosition: prev.position,
      fetchedAt,
      daily,
    };
  } catch (error) {
    return {
      clicks: 0,
      impressions: 0,
      position: null,
      prevClicks: 0,
      prevImpressions: 0,
      prevPosition: null,
      fetchedAt,
      error: error instanceof Error ? error.message.slice(0, 200) : "GSC error",
    };
  }
}

// GA4 is near real time: last 28 complete days (ending yesterday) vs the
// previous 28, all channels, in one runReport call (two date ranges).
// Relative dates are resolved by GA4 in the property's reporting time zone.
export async function fetchGa4(conn: {
  projectId: string;
  propertyId: string;
  userId: string;
  ga4AccountId: string;
}): Promise<PortfolioGa4> {
  const fetchedAt = new Date().toISOString();
  try {
    const client = createGa4DataClient({
      userId: conn.userId,
      ga4AccountId: conn.ga4AccountId,
      propertyId: conn.propertyId,
    });
    const res = await client.runReport({
      dateRanges: [
        { startDate: "28daysAgo", endDate: "yesterday" },
        { startDate: "56daysAgo", endDate: "29daysAgo" },
      ],
      dimensions: [],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }],
      offset: "0",
      limit: "10",
      orderBys: [],
      keepEmptyRows: false,
      returnPropertyQuota: true,
    });
    const out = { sessions: 0, activeUsers: 0, prevSessions: 0, prevActiveUsers: 0 };
    for (const row of res.rows ?? []) {
      const range = row.dimensionValues?.[0]?.value ?? "date_range_0";
      const sessions = Number(row.metricValues?.[0]?.value ?? 0);
      const users = Number(row.metricValues?.[1]?.value ?? 0);
      if (range === "date_range_1") {
        out.prevSessions = sessions;
        out.prevActiveUsers = users;
      } else {
        out.sessions = sessions;
        out.activeUsers = users;
      }
    }
    return { ...out, fetchedAt };
  } catch (error) {
    return {
      sessions: 0,
      activeUsers: 0,
      prevSessions: 0,
      prevActiveUsers: 0,
      fetchedAt,
      error: error instanceof Error ? error.message.slice(0, 200) : "GA4 error",
    };
  }
}

export async function getAuditSummaries(projectIds: string[]) {
  const out = new Map<string, PortfolioRow["audit"]>();
  if (projectIds.length === 0) return out;
  // Latest audit per project.
  const latest = await db
    .select({
      id: audits.id,
      projectId: audits.projectId,
      status: audits.status,
      completedAt: audits.completedAt,
      pagesCrawled: audits.pagesCrawled,
      startedAt: audits.startedAt,
    })
    .from(audits)
    .where(
      sql`${audits.startedAt} = (select max(a2.started_at) from audits a2 where a2.project_id = ${audits.projectId})`,
    );
  const byAudit = new Map(latest.map((a) => [a.id, a]));
  const auditIds = [...byAudit.keys()];
  const issueCounts = new Map<string, { critical: number; warning: number }>();
  const lh = new Map<string, { seo: number | null; perf: number | null }>();
  for (let i = 0; i < auditIds.length; i += 90) {
    const chunk = auditIds.slice(i, i + 90);
    const issues = await db
      .select({
        auditId: auditIssues.auditId,
        severity: auditIssues.severity,
        n: sql<number>`count(*)`,
      })
      .from(auditIssues)
      .where(inArray(auditIssues.auditId, chunk))
      .groupBy(auditIssues.auditId, auditIssues.severity);
    for (const r of issues) {
      const c = issueCounts.get(r.auditId) ?? { critical: 0, warning: 0 };
      if (r.severity === "critical") c.critical = Number(r.n);
      if (r.severity === "warning") c.warning = Number(r.n);
      issueCounts.set(r.auditId, c);
    }
    const scores = await db
      .select({
        auditId: auditLighthouseResults.auditId,
        seo: sql<number | null>`avg(${auditLighthouseResults.seoScore})`,
        perf: sql<number | null>`avg(${auditLighthouseResults.performanceScore})`,
      })
      .from(auditLighthouseResults)
      .where(inArray(auditLighthouseResults.auditId, chunk))
      .groupBy(auditLighthouseResults.auditId);
    for (const r of scores)
      lh.set(r.auditId, {
        seo: r.seo == null ? null : Math.round(Number(r.seo)),
        perf: r.perf == null ? null : Math.round(Number(r.perf)),
      });
  }
  const wanted = new Set(projectIds);
  for (const a of latest) {
    if (!wanted.has(a.projectId)) continue;
    const c = issueCounts.get(a.id) ?? { critical: 0, warning: 0 };
    const s = lh.get(a.id) ?? { seo: null, perf: null };
    out.set(a.projectId, {
      status: a.status,
      completedAt: a.completedAt,
      pagesCrawled: a.pagesCrawled,
      critical: c.critical,
      warning: c.warning,
      lighthouseSeo: s.seo,
      lighthousePerf: s.perf,
    });
  }
  return out;
}

async function clearCache(organizationId: string) {
  const rows = await db
    .select({ projectId: gscConnections.projectId, siteUrl: gscConnections.siteUrl })
    .from(gscConnections)
    .where(eq(gscConnections.organizationId, organizationId));
  const { env } = await import("cloudflare:workers");
  const ga4Rows = await db
    .select({ projectId: ga4Connections.projectId, propertyId: ga4Connections.propertyId })
    .from(ga4Connections)
    .where(eq(ga4Connections.organizationId, organizationId));
  const keys = [
    ...rows.map((r) => cacheKey(r.projectId, r.siteUrl)),
    ...ga4Rows.map((r) => ga4CacheKey(r.projectId, r.propertyId)),
  ];
  for (let i = 0; i < keys.length; i += 500) {
    await env.R2.delete(
      keys.slice(i, i + 500).map((k) => `dataforseo-cache/${k}`),
    );
  }
}

export const PortfolioService = { clearCache };
