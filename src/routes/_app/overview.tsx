// CityThrive fork: all-sites overview (GSC last 28 days vs previous 28 days,
// plus latest audit). Data is cached server-side and filled progressively.
import * as React from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/client/components/PageHeader";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import { TablePagination } from "@/client/components/table/TablePagination";
import { buildCsv } from "@/client/lib/csv";
import {
  portfolioOverviewSearchSchema,
  type PortfolioOverviewSearch,
} from "@/types/schemas/portfolio-overview";
import {
  getPortfolioOverview,
  queueFleetReaudit,
  refreshPortfolioOverview,
} from "@/serverFunctions/portfolio";
import { FleetReauditPanel } from "@/client/features/fleet/FleetReauditPanel";
import {
  fleetChartsLabel,
  fleetSiteTableLabel,
} from "@/client/navigation/fleetNav";
import { AlertTriangle } from "lucide-react";
import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import { DropdownMenuItem } from "@/client/components/ui/dropdown-menu";
import {
  googleCidConverterToolUrl,
  googleMapsSearchUrl,
  googleReviewLinkToolUrl,
  mapsSearchQuery,
} from "@/client/lib/local-operator-links";

export const Route = createFileRoute("/_app/overview")({
  validateSearch: portfolioOverviewSearchSchema,
  component: OverviewPage,
});

type Row = Awaited<ReturnType<typeof getPortfolioOverview>>["rows"][number];
type SortKey = NonNullable<PortfolioOverviewSearch["sort"]>;
type Coverage = NonNullable<PortfolioOverviewSearch["coverage"]>;
const PAGE_SIZE = 50;

const COVERAGE_CHIPS: Array<{ key: Coverage; label: string }> = [
  { key: "all", label: "All" },
  { key: "gscYes", label: "GSC ✓" },
  { key: "gscNo", label: "GSC ✗" },
  { key: "ga4Yes", label: "GA4 ✓" },
  { key: "ga4No", label: "GA4 ✗" },
  { key: "ga4Zero", label: "GA4 linked, 0 sessions" },
  { key: "noGoogle", label: "No GSC and no GA4" },
  { key: "noAudit", label: "Never audited" },
  { key: "staleAudit", label: "Audit older than 7 days" },
  { key: "critical", label: "Has critical issues" },
];

function ga4Zero(r: Row): boolean {
  return !!r.ga4PropertyId && !!r.ga4 && !r.ga4.error && r.ga4.sessions === 0;
}

function matchesCoverage(r: Row, c: Coverage): boolean {
  switch (c) {
    case "all":
      return true;
    case "gscYes":
      return !!r.siteUrl;
    case "gscNo":
      return !r.siteUrl;
    case "ga4Yes":
      return !!r.ga4PropertyId;
    case "ga4No":
      return !r.ga4PropertyId;
    case "ga4Zero":
      return ga4Zero(r);
    case "noGoogle":
      return !r.siteUrl && !r.ga4PropertyId;
    case "noAudit":
      return !r.audit;
    case "staleAudit":
      return isStaleAudit(r);
    case "critical":
      return (r.audit?.critical ?? 0) > 0;
    default: {
      const unreachable: never = c;
      throw new Error(`Unknown coverage filter: ${unreachable}`);
    }
  }
}

// Matches the server's re-audit rule (FLEET_REAUDIT_STALE_DAYS).
const STALE_AUDIT_MS = 7 * 86_400_000;
function isStaleAudit(r: Row): boolean {
  if (!r.audit) return true;
  if (r.audit.status === "running") return false;
  const at = r.audit.completedAt ? Date.parse(r.audit.completedAt) : NaN;
  return !(Date.now() - at <= STALE_AUDIT_MS);
}

/** Props for a metric cell; earlier numbers shown while refreshing are greyed. */
function staleCell(m: { stale?: true; fetchedAt: string } | null) {
  return m?.stale
    ? {
        className: "px-2 text-muted-foreground",
        title: `From ${m.fetchedAt.slice(0, 10)}; refreshing`,
      }
    : { className: "px-2" };
}

function login(email: string | null | undefined): string {
  return email ? email.split("@")[0]! : "";
}

function exportCsv(rows: Row[], filename: string) {
  const head = [
    "domain",
    "name",
    "projectId",
    "gsc_linked",
    "gsc_property",
    "gsc_login",
    "ga4_linked",
    "ga4_property",
    "ga4_login",
    "clicks_28d",
    "clicks_prev28d",
    "impressions_28d",
    "impressions_prev28d",
    "avg_position",
    "ga4_sessions_28d",
    "ga4_sessions_prev28d",
    "ga4_users_28d",
    "ga4_zero_sessions",
    "gsc_error",
    "ga4_error",
    "gsc_fetched_at",
    "ga4_fetched_at",
    "audit_status",
    "audit_completed_at",
    "audit_pages",
    "audit_critical",
    "audit_warning",
  ];
  const records = rows.map((r) => {
    const g = r.gsc;
    const a = r.ga4;
    return [
      r.domain,
      r.name,
      r.projectId,
      r.siteUrl ? "yes" : "no",
      r.siteUrl,
      r.gscEmail,
      r.ga4PropertyId ? "yes" : "no",
      r.ga4PropertyId,
      r.ga4Email,
      g && !g.error ? g.clicks : "",
      g && !g.error ? g.prevClicks : "",
      g && !g.error ? g.impressions : "",
      g && !g.error ? g.prevImpressions : "",
      g?.position != null ? g.position.toFixed(2) : "",
      a && !a.error ? a.sessions : "",
      a && !a.error ? a.prevSessions : "",
      a && !a.error ? a.activeUsers : "",
      ga4Zero(r) ? "yes" : "",
      g?.error ?? "",
      a?.error ?? "",
      g?.fetchedAt ?? "",
      a?.fetchedAt ?? "",
      r.audit?.status,
      r.audit?.completedAt,
      r.audit?.pagesCrawled,
      r.audit?.critical,
      r.audit?.warning,
    ];
  });
  const blob = new Blob([buildCsv(head, records)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const el = document.createElement("a");
  el.href = url;
  el.download = filename;
  el.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function pct(cur: number, prev: number): number | null {
  if (prev === 0) return cur === 0 ? 0 : null;
  return ((cur - prev) / prev) * 100;
}

function value(row: Row, key: SortKey): number | string | null {
  const g = row.gsc && !row.gsc.error ? row.gsc : null;
  const a = row.ga4 && !row.ga4.error ? row.ga4 : null;
  switch (key) {
    case "name":
      return (row.domain ?? row.name).toLowerCase();
    case "clicks":
      return g ? g.clicks : null;
    case "clicksDelta":
      return g ? g.clicks - g.prevClicks : null;
    case "impressions":
      return g ? g.impressions : null;
    case "impressionsDelta":
      return g ? g.impressions - g.prevImpressions : null;
    case "position":
      return g?.position ?? null;
    case "positionDelta":
      return g?.position != null && g.prevPosition != null
        ? g.prevPosition - g.position
        : null;
    case "sessions":
      return a ? a.sessions : null;
    case "sessionsDelta":
      return a ? a.sessions - a.prevSessions : null;
    case "users":
      return a ? a.activeUsers : null;
    case "critical":
      return row.audit ? row.audit.critical : null;
    case "lastAudit":
      return row.audit?.completedAt ?? null;
    case "lighthouseSeo":
      return row.audit?.lighthouseSeo ?? null;
    default: {
      const unreachable: never = key;
      throw new Error(`Unknown sort key: ${unreachable}`);
    }
  }
}

function Delta({
  v,
  suffix = "",
  invert = false,
}: {
  v: number | null;
  suffix?: string;
  invert?: boolean;
}) {
  if (v == null) return <span className="text-muted-foreground">–</span>;
  const good = invert ? v < 0 : v > 0;
  const cls =
    v === 0
      ? "text-muted-foreground"
      : good
        ? "text-success"
        : "text-destructive";
  return (
    <span className={cls}>
      {v > 0 ? "+" : ""}
      {Math.abs(v) < 10 && v % 1 !== 0
        ? v.toFixed(1)
        : Math.round(v).toLocaleString()}
      {suffix}
    </span>
  );
}

function OverviewPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();
  // Rows come from the fleet snapshot, rebuilt by the scheduler every 30
  // minutes, so polling faster than that cannot show anything new.
  const query = useQuery({
    queryKey: ["portfolioOverview"],
    queryFn: () => getPortfolioOverview(),
    refetchInterval: (q) =>
      (q.state.data?.pending ?? 0) > 0 ? 5 * 60_000 : false,
    staleTime: 5 * 60_000,
  });
  const refresh = useMutation({
    mutationFn: () => refreshPortfolioOverview({ data: {} }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["portfolioOverview"] }),
  });
  const reauditOne = useMutation({
    mutationFn: (projectId: string) =>
      queueFleetReaudit({ data: { projectIds: [projectId] } }),
    onSuccess: (status) => queryClient.setQueryData(["fleetReaudit"], status),
  });
  const sortKey = search.sort ?? "clicks";
  const desc = search.order !== "asc";
  const filter = search.filter ?? "";
  const coverage = search.coverage ?? "all";
  const [page, setPage] = React.useState(1);
  const updateSearch = (
    update: Partial<PortfolioOverviewSearch>,
    replace = false,
  ) => {
    setPage(1);
    void navigate({
      search: (prev) => ({ ...prev, ...update }),
      replace,
      resetScroll: false,
    });
  };

  const rows = React.useMemo(() => {
    const all = query.data?.rows ?? [];
    const f = filter.trim().toLowerCase();
    const filtered = all.filter(
      (r) =>
        matchesCoverage(r, coverage) &&
        (!f || `${r.name} ${r.domain ?? ""}`.toLowerCase().includes(f)),
    );
    return [...filtered].sort((a, b) => {
      const va = value(a, sortKey);
      const vb = value(b, sortKey);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const c = va < vb ? -1 : va > vb ? 1 : 0;
      return desc ? -c : c;
    });
  }, [query.data, sortKey, desc, filter, coverage]);

  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(rows.length / PAGE_SIZE)),
  );
  const visibleRows = rows.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  const counts = React.useMemo(() => {
    const all = query.data?.rows ?? [];
    const out = {} as Record<Coverage, number>;
    for (const c of COVERAGE_CHIPS)
      out[c.key] = all.filter((r) => matchesCoverage(r, c.key)).length;
    return out;
  }, [query.data]);

  const totals = React.useMemo(() => {
    let clicks = 0,
      prevClicks = 0,
      impressions = 0,
      prevImpressions = 0;
    let sessions = 0,
      prevSessions = 0;
    let gscSites = 0,
      ga4Sites = 0;
    for (const r of rows) {
      // Earlier numbers shown while refreshing stay out of the totals.
      if (r.ga4 && !r.ga4.error && !r.ga4.stale) {
        ga4Sites++;
        sessions += r.ga4.sessions;
        prevSessions += r.ga4.prevSessions;
      }
      if (!r.gsc || r.gsc.error || r.gsc.stale) continue;
      gscSites++;
      clicks += r.gsc.clicks;
      prevClicks += r.gsc.prevClicks;
      impressions += r.gsc.impressions;
      prevImpressions += r.gsc.prevImpressions;
    }
    return {
      clicks,
      prevClicks,
      impressions,
      prevImpressions,
      sessions,
      prevSessions,
      gscSites,
      ga4Sites,
    };
  }, [rows]);

  // One failed Google grant shows up as the same error on every site. Name it
  // once, with the way to fix it, instead of 1,600 "GA4 error" cells.
  const providerIssues = React.useMemo(() => {
    const all = query.data?.rows ?? [];
    const out: Array<{
      provider: "Search Console" | "GA4";
      error: string;
      sites: number;
      projectId: string;
    }> = [];
    for (const [provider, pick] of [
      ["Search Console", (r: Row) => r.gsc?.error],
      ["GA4", (r: Row) => r.ga4?.error],
    ] as const) {
      const byError = new Map<string, { sites: number; projectId: string }>();
      for (const r of all) {
        const error = pick(r);
        if (!error) continue;
        const found = byError.get(error);
        if (found) found.sites++;
        else byError.set(error, { sites: 1, projectId: r.projectId });
      }
      for (const [error, v] of byError)
        if (v.sites >= 5) out.push({ provider, error, ...v });
    }
    return out.sort((a, b) => b.sites - a.sites);
  }, [query.data]);

  // While a provider is failing fleet-wide, its empty cells are not loading.
  const blocked = {
    gsc: providerIssues.some((i) => i.provider === "Search Console"),
    ga4: providerIssues.some((i) => i.provider === "GA4"),
  };

  // The login beside each check mark only earns its space when the fleet uses
  // more than one account for that provider.
  const accounts = React.useMemo(() => {
    const all = query.data?.rows ?? [];
    return {
      gsc: new Set(all.map((r) => r.gscEmail).filter(Boolean)).size > 1,
      ga4: new Set(all.map((r) => r.ga4Email).filter(Boolean)).size > 1,
    };
  }, [query.data]);

  const header = (key: SortKey, label: string) => (
    <th
      scope="col"
      aria-sort={
        sortKey === key ? (desc ? "descending" : "ascending") : undefined
      }
      className="whitespace-nowrap px-2 text-left font-medium"
    >
      <button
        type="button"
        className="min-h-9 cursor-pointer rounded-sm py-2 text-left hover:underline"
        onClick={() => {
          const nextDesc =
            sortKey === key
              ? !desc
              : key !== "name" && key !== "position" && key !== "critical";
          updateSearch({ sort: key, order: nextDesc ? "desc" : "asc" });
        }}
      >
        {label}
        <span aria-hidden>{sortKey === key ? (desc ? " ↓" : " ↑") : ""}</span>
      </button>
    </th>
  );

  const data = query.data;
  return (
    <div className="h-full overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <PageHeader
          title={fleetSiteTableLabel}
          description="Search Console last 28 days vs the previous 28 days (ending 3 days ago), GA4 sessions/users (all channels, last 28 days ending yesterday vs previous 28), plus the latest site audit. GSC and GA4 data are cached for 12 hours."
          actions={
            <>
              <Button
                variant="outline"
                nativeButton={false}
                render={<Link to="/dashboard" />}
              >
                {fleetChartsLabel}
              </Button>
              <Button
                variant="outline"
                disabled={refresh.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Clear the cached Search Console and GA4 numbers for ${(data?.rows.length ?? 0).toLocaleString()} sites? They refill in the background, about 90 sites every 10 minutes, and this table shows them on its next rebuild. The full fleet takes a few hours.`,
                    )
                  )
                    refresh.mutate();
                }}
              >
                {refresh.isPending ? "Clearing…" : "Refresh GSC/GA4 data"}
              </Button>
            </>
          }
        />
        {query.isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 text-sm text-destructive"
          >
            <p>Failed to load overview.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              {query.isFetching ? "Retrying…" : "Retry"}
            </Button>
          </div>
        ) : null}
        {!data ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading overview…
          </p>
        ) : (
          <>
            {providerIssues.length > 0 ? (
              <div
                role="alert"
                className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
              >
                {providerIssues.map((issue) => (
                  <div
                    key={`${issue.provider}:${issue.error}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1"
                  >
                    <AlertTriangle
                      className="size-4 shrink-0 text-destructive"
                      aria-hidden
                    />
                    <span>
                      <strong>{issue.provider}</strong> data is unavailable for{" "}
                      {issue.sites.toLocaleString()} sites: {issue.error}
                    </span>
                    <Link
                      to="/p/$projectId/settings/integrations"
                      params={{ projectId: issue.projectId }}
                      className="font-medium text-primary underline underline-offset-4"
                    >
                      Reconnect {issue.provider}
                    </Link>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">
                  Reconnecting the Google account once fixes every site that
                  uses it. Numbers refill in the background afterwards.
                </p>
              </div>
            ) : null}
            <FleetReauditPanel viewProjectIds={rows.map((r) => r.projectId)} />
            {(counts.critical ?? 0) > 0 && coverage !== "critical" ? (
              <div
                role="status"
                className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
              >
                <AlertTriangle
                  className="size-4 shrink-0 text-destructive"
                  aria-hidden
                />
                <span>
                  {(counts.critical ?? 0).toLocaleString()} sites have critical
                  audit issues.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => updateSearch({ coverage: "critical" })}
                >
                  Show affected sites
                </Button>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <Input
                className="w-full sm:w-64"
                aria-label="Filter by name or domain"
                placeholder="Filter by name or domain"
                value={filter}
                onChange={(e) => updateSearch({ filter: e.target.value }, true)}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  exportCsv(
                    rows,
                    `openseo-sites-${coverage}-${new Date().toISOString().slice(0, 10)}.csv`,
                  )
                }
              >
                Export CSV ({rows.length.toLocaleString()})
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  exportCsv(
                    data.rows,
                    `openseo-sites-all-${new Date().toISOString().slice(0, 10)}.csv`,
                  )
                }
              >
                Export all ({data.rows.length.toLocaleString()})
              </Button>
              <span role="status">{rows.length.toLocaleString()} sites</span>
              <span
                className="text-muted-foreground"
                title="Rows come from the fleet snapshot, rebuilt every 30 minutes."
              >
                Updated{" "}
                {new Date(data.generatedAt).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
              <span>
                Clicks {totals.clicks.toLocaleString()} (
                <Delta v={pct(totals.clicks, totals.prevClicks)} suffix="%" />)
              </span>
              <span>
                Impressions {totals.impressions.toLocaleString()} (
                <Delta
                  v={pct(totals.impressions, totals.prevImpressions)}
                  suffix="%"
                />
                )
              </span>
              {totals.ga4Sites > 0 ? (
                <span>
                  GA4 sessions {totals.sessions.toLocaleString()} (
                  <Delta
                    v={pct(totals.sessions, totals.prevSessions)}
                    suffix="%"
                  />
                  )
                </span>
              ) : (
                <span className="text-muted-foreground">
                  GA4 sessions unavailable
                </span>
              )}
              {data.pending + data.refreshingGsc + data.refreshingGa4 > 0 ? (
                <span
                  role="status"
                  className="text-amber-800 dark:text-amber-300"
                >
                  {[
                    data.pendingGsc > 0
                      ? providerIssues.some(
                          (i) => i.provider === "Search Console",
                        )
                        ? `Search Console for ${data.pendingGsc.toLocaleString()} sites is blocked until it is reconnected`
                        : `Search Console for ${data.pendingGsc.toLocaleString()} sites is still being collected`
                      : null,
                    data.pendingGa4 > 0
                      ? providerIssues.some((i) => i.provider === "GA4")
                        ? `GA4 for ${data.pendingGa4.toLocaleString()} sites is blocked until it is reconnected`
                        : `GA4 for ${data.pendingGa4.toLocaleString()} sites is still being collected`
                      : null,
                    data.refreshingGsc + data.refreshingGa4 > 0
                      ? `${Math.max(data.refreshingGsc, data.refreshingGa4).toLocaleString()} sites show earlier numbers in grey while they refresh, and are left out of the totals`
                      : null,
                  ]
                    .filter(Boolean)
                    .join("; ")}
                  . This table refreshes with each snapshot.
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              {COVERAGE_CHIPS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={coverage === c.key}
                  onClick={() => updateSearch({ coverage: c.key })}
                  className={`min-h-8 rounded-full border px-3 py-1 ${coverage === c.key ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                >
                  {c.label} ({(counts[c.key] ?? 0).toLocaleString()})
                </button>
              ))}
            </div>
            <div className="overflow-hidden rounded-md border">
              <div
                role="region"
                aria-label="All sites metrics, scroll horizontally for more columns"
                tabIndex={0}
                className="overflow-x-auto"
              >
                <table className="w-full text-sm">
                  <caption className="sr-only">
                    Search Console, Google Analytics, and latest audit results
                    for the filtered sites.
                  </caption>
                  <thead className="bg-muted/50">
                    <tr>
                      {header("name", "Site")}
                      <th className="whitespace-nowrap px-2 py-2 text-left font-medium">
                        GSC
                      </th>
                      <th className="whitespace-nowrap px-2 py-2 text-left font-medium">
                        GA4
                      </th>
                      {header("clicks", "Clicks")}
                      {header("clicksDelta", "Δ clicks")}
                      {header("impressions", "Impr.")}
                      {header("impressionsDelta", "Δ impr.")}
                      {header("position", "Avg pos.")}
                      {header("positionDelta", "Δ pos.")}
                      {header("sessions", "GA4 sessions")}
                      {header("sessionsDelta", "Δ sess.")}
                      {header("users", "GA4 users")}
                      {header("critical", "Audit issues (crit/warn)")}
                      {header("lastAudit", "Last audit")}
                      {header("lighthouseSeo", "Lighthouse SEO / Perf")}
                      <th className="whitespace-nowrap px-2 py-2 text-left font-medium">
                        Local
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((r) => {
                      const g = r.gsc;
                      const gscCell = staleCell(g);
                      const ga4Cell = staleCell(r.ga4);
                      const mapsQuery = mapsSearchQuery(r.domain, r.name);
                      const mapsUrl = googleMapsSearchUrl(mapsQuery);
                      const siteLabel = r.domain ?? r.name;
                      return (
                        <tr
                          key={r.projectId}
                          className="border-t hover:bg-muted/30"
                        >
                          <td className="px-2 py-1.5">
                            <Link
                              to="/p/$projectId"
                              params={{ projectId: r.projectId }}
                              className="font-medium hover:underline"
                            >
                              {r.domain ?? r.name}
                            </Link>
                          </td>
                          <td
                            className="whitespace-nowrap px-2"
                            title={
                              r.siteUrl
                                ? `${r.siteUrl} via ${r.gscEmail ?? "?"}`
                                : "Not linked"
                            }
                          >
                            <span
                              aria-hidden
                              className={
                                r.siteUrl ? "text-success" : "text-destructive"
                              }
                            >
                              {r.siteUrl ? "✓" : "✗"}
                            </span>
                            <span className="sr-only">
                              {r.siteUrl
                                ? "GSC connected"
                                : "GSC not connected"}
                            </span>
                            {r.gscEmail && accounts.gsc ? (
                              <span className="ml-1 text-xs text-muted-foreground">
                                {login(r.gscEmail)}
                              </span>
                            ) : null}
                          </td>
                          <td
                            className="whitespace-nowrap px-2"
                            title={
                              r.ga4PropertyId
                                ? `${r.ga4PropertyId} via ${r.ga4Email ?? "?"}`
                                : "Not linked"
                            }
                          >
                            <span
                              aria-hidden
                              className={
                                r.ga4PropertyId
                                  ? "text-success"
                                  : "text-destructive"
                              }
                            >
                              {r.ga4PropertyId ? "✓" : "✗"}
                            </span>
                            <span className="sr-only">
                              {r.ga4PropertyId
                                ? "GA4 connected"
                                : "GA4 not connected"}
                            </span>
                            {r.ga4Email && accounts.ga4 ? (
                              <span className="ml-1 text-xs text-muted-foreground">
                                {login(r.ga4Email)}
                              </span>
                            ) : null}
                            {ga4Zero(r) ? (
                              <span
                                className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-800"
                                title="GA4 is linked with 0 sessions in the cached reporting period."
                              >
                                0 sess
                              </span>
                            ) : null}
                          </td>
                          {!r.siteUrl ? (
                            <td
                              colSpan={6}
                              className="px-2 text-muted-foreground"
                            >
                              Not connected to GSC
                            </td>
                          ) : !g ? (
                            <td
                              colSpan={6}
                              className="px-2 text-muted-foreground"
                            >
                              {blocked.gsc ? "Unavailable" : "Loading…"}
                            </td>
                          ) : g.error ? (
                            <td
                              colSpan={6}
                              className="px-2 text-red-600"
                              title={g.error}
                            >
                              GSC error
                            </td>
                          ) : (
                            <>
                              <td {...gscCell}>{g.clicks.toLocaleString()}</td>
                              <td {...gscCell}>
                                <Delta v={g.clicks - g.prevClicks} />
                              </td>
                              <td {...gscCell}>
                                {g.impressions.toLocaleString()}
                              </td>
                              <td {...gscCell}>
                                <Delta v={g.impressions - g.prevImpressions} />
                              </td>
                              <td {...gscCell}>
                                {g.position == null
                                  ? "–"
                                  : g.position.toFixed(1)}
                              </td>
                              <td {...gscCell}>
                                <Delta
                                  v={
                                    g.position != null && g.prevPosition != null
                                      ? g.prevPosition - g.position
                                      : null
                                  }
                                />
                              </td>
                            </>
                          )}
                          {!r.ga4PropertyId ? (
                            <td
                              colSpan={3}
                              className="px-2 text-muted-foreground"
                            >
                              No GA4
                            </td>
                          ) : !r.ga4 ? (
                            <td
                              colSpan={3}
                              className="px-2 text-muted-foreground"
                            >
                              {blocked.ga4 ? "Unavailable" : "Loading…"}
                            </td>
                          ) : r.ga4.error ? (
                            <td
                              colSpan={3}
                              className="px-2 text-red-600"
                              title={r.ga4.error}
                            >
                              GA4 error
                            </td>
                          ) : (
                            <>
                              <td {...ga4Cell}>
                                {r.ga4.sessions.toLocaleString()}
                              </td>
                              <td {...ga4Cell}>
                                <Delta
                                  v={r.ga4.sessions - r.ga4.prevSessions}
                                />
                              </td>
                              <td {...ga4Cell}>
                                {r.ga4.activeUsers.toLocaleString()}
                              </td>
                            </>
                          )}
                          <td className="px-2">
                            {r.audit ? (
                              <Link
                                to="/p/$projectId/audit"
                                params={{ projectId: r.projectId }}
                                className="hover:underline"
                              >
                                {r.audit.status === "completed"
                                  ? `${r.audit.critical} / ${r.audit.warning}`
                                  : r.audit.status}
                              </Link>
                            ) : (
                              <span className="text-muted-foreground">–</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-2 text-xs">
                            {r.audit?.completedAt
                              ? r.audit.completedAt.slice(0, 10)
                              : "–"}
                          </td>
                          <td className="px-2">
                            {r.audit?.lighthouseSeo != null
                              ? `${r.audit.lighthouseSeo} / ${r.audit.lighthousePerf ?? "–"}`
                              : "–"}
                          </td>
                          <td className="whitespace-nowrap px-2 py-1">
                            <RowActionsMenu label={`Actions for ${siteLabel}`}>
                              <DropdownMenuItem
                                disabled={reauditOne.isPending}
                                onClick={() => reauditOne.mutate(r.projectId)}
                              >
                                Re-audit this site
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                render={
                                  <a
                                    href={mapsUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  />
                                }
                              >
                                Search on Maps
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                render={
                                  <a
                                    href={googleReviewLinkToolUrl()}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  />
                                }
                              >
                                Review link tool
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                render={
                                  <a
                                    href={googleCidConverterToolUrl()}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  />
                                }
                              >
                                CID converter
                              </DropdownMenuItem>
                            </RowActionsMenu>
                          </td>
                        </tr>
                      );
                    })}
                    {rows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={16}
                          className="px-4 py-8 text-center text-muted-foreground"
                        >
                          No sites match these filters.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              <TablePagination
                page={currentPage}
                pageSize={PAGE_SIZE}
                totalCount={rows.length}
                onPageChange={setPage}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Δ pos. is positive when ranking improved.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
