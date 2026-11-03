import { windows } from "./PortfolioService";

import { TTL_SECONDS } from "./PortfolioService";

import { sort as sortArray } from "remeda";

import { reverse as reverseArray } from "remeda";

import {
  type FleetDashboard,
  type FleetInventoryRow,
  type FleetSite,
} from "./FleetDashboardTypes";

import { listFleet } from "./FleetDashboardRepository";

import {
  BING_MAX_AGE_MS,
  bingMetrics,
  cacheEvidenceSchema,
  ga4Schema,
  googleCheck,
  gscSchema,
  providerEntry,
  QUERIES_TTL_SECONDS,
  queriesSchema,
  readAuthChecks,
  readFleetEvidence,
  sameReportingDay,
  TOP_QUERIES_EXPORT,
} from "./FleetDashboardEvidence";

import {
  auditRollup,
  healthRollup,
  providerIssues,
} from "./FleetDashboardRollups";

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
    const e = evidence[i];
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
      gsc: providerEntry({
        property: r.siteUrl,
        accountId: r.gscAccountId,
        email: r.gscEmail,
        evidence: e.gsc,
        metrics: g.success
          ? {
              clicks: g.data.clicks,
              prevClicks: g.data.prevClicks,
              impressions: g.data.impressions,
              prevImpressions: g.data.prevImpressions,
              position: g.data.position,
              prevPosition: g.data.prevPosition,
            }
          : null,
        currentWindow: g.success && sameReportingDay(g.data.fetchedAt),
        maxAgeMs: TTL_SECONDS * 1000,
        updatedAt: r.gscUpdatedAt,
        auth: googleCheck(r, "gsc", organizationId, checks),
      }),
      ga4: providerEntry({
        property: r.ga4PropertyId,
        accountId: r.ga4AccountId,
        email: r.ga4Email,
        evidence: e.ga4,
        metrics: a.success
          ? {
              sessions: a.data.sessions,
              prevSessions: a.data.prevSessions,
              users: a.data.activeUsers,
              prevUsers: a.data.prevActiveUsers,
            }
          : null,
        currentWindow:
          a.success &&
          sameReportingDay(a.data.fetchedAt, r.ga4PropertyTimeZone ?? "UTC"),
        maxAgeMs: TTL_SECONDS * 1000,
        updatedAt: r.ga4UpdatedAt,
        auth: googleCheck(r, "ga4", organizationId, checks),
      }),
      bing: providerEntry({
        property: r.bingSiteUrl,
        accountId: null,
        email: null,
        evidence: bingError ? e.bingAttempt : e.bing,
        metrics: e.bing && !bingError ? bingMetrics(e.bing) : null,
        currentWindow: true,
        maxAgeMs: BING_MAX_AGE_MS,
      }),
    };
  });
  const gscRows = evidence.map((e, i) => {
    const parsed = gscSchema.safeParse(e.gsc);
    return inventory[i].gsc.status === "available" && parsed.success
      ? parsed.data
      : null;
  });
  const ga4Rows = evidence.map((e, i) => {
    const parsed = ga4Schema.safeParse(e.ga4);
    return inventory[i].ga4.status === "available" && parsed.success
      ? parsed.data
      : null;
  });
  const queryRows = evidence.map((e, i) => {
    const r = rows[i];
    const parsed = queriesSchema.safeParse(e.queries);
    if (!parsed.success) return null;
    const q = parsed.data;
    const entry = providerEntry({
      property: r.siteUrl,
      accountId: r.gscAccountId,
      email: r.gscEmail,
      evidence: q,
      metrics: q.rows,
      currentWindow: sameReportingDay(q.fetchedAt),
      maxAgeMs: QUERIES_TTL_SECONDS * 1000,
      updatedAt: r.gscUpdatedAt,
      auth: googleCheck(r, "gsc", organizationId, checks),
    });
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
    const r = rows[i];
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
  const topQueriesExport = sortArray(
    [...qAgg.entries()],
    (a, b) => b[1].clicks - a[1].clicks || b[1].impressions - a[1].impressions,
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
    inventory[i].bing.status === "available" && e.bing ? [e.bing] : [],
  );
  const dateSets = bingSnapshots.map((s) =>
    sortArray(
      s.performance.map((r) => r.date),
      (a, b) => String(a).localeCompare(String(b)),
    ),
  );
  // Never present mixed/unknown provider periods as one fleet reporting window.
  const uniformDates =
    dateSets.length > 0 &&
    dateSets[0].length > 0 &&
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
    startDate: uniformDates ? dateSets[0][0]! : null,
    endDate: uniformDates ? dateSets[0].at(-1)! : null,
    limitations: [
      ...new Set([
        "Bing combines search surfaces and is not comparable to Google Search Console.",
        "Missing provider rows are not zero activity; date coverage and timezone are provider-defined.",
        "Fleet totals require identical known provider-returned dates across all included Bing snapshots; no previous-period comparison is inferred.",
        ...bingSnapshots.flatMap((s) => s.limitations),
      ]),
    ],
  };
  const byDelta = sortArray([...sites], (a, b) => b.delta - a.delta);
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
    losers: reverseArray(byDelta.filter((s) => s.delta < 0)).slice(0, 8),
    topQueries,
    topQueriesExport,
    audit,
    health,
  };
}
