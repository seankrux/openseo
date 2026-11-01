// CityThrive fork: all-sites dashboard. Reads one cached snapshot that the
// scheduler rebuilds every 30 minutes; the page itself never calls Google.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Globe,
  MousePointerClick,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  LabelList,
  XAxis,
  YAxis,
} from "recharts";
import { CardShell } from "@/client/components/CardShell";
import { Button } from "@/client/components/ui/button";
import { Skeleton } from "@/client/components/ui/skeleton";
import { TablePagination } from "@/client/components/table/TablePagination";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/client/components/ui/chart";
import { QueryError } from "@/client/components/QueryState";
import { getFleetDashboard } from "@/serverFunctions/portfolio";
import { triggerDomainHealthRun } from "@/serverFunctions/domainHealth";
import { getLastProjectId } from "@/client/lib/active-project";
import { DashboardScopeTabs } from "./DashboardScopeTabs";
import {
  fleetChartsLabel,
  fleetSiteTableLabel,
} from "@/client/navigation/fleetNav";

type Fleet = Awaited<ReturnType<typeof getFleetDashboard>>;

const nf = new Intl.NumberFormat();
const fmt = (n: number) => nf.format(Math.round(n));

function pct(cur: number, prev: number): number | null {
  if (prev === 0) return cur === 0 ? 0 : null;
  return ((cur - prev) / prev) * 100;
}

function Delta({
  value,
  invert = false,
  suffix = "%",
}: {
  value: number | null;
  invert?: boolean;
  suffix?: string;
}) {
  if (value === null || !Number.isFinite(value))
    return <span className="text-xs text-muted-foreground">new</span>;
  const good = invert ? value < 0 : value > 0;
  const bad = invert ? value > 0 : value < 0;
  return (
    <span
      className={
        "inline-flex items-center gap-0.5 text-xs font-medium " +
        (good
          ? "text-success"
          : bad
            ? "text-destructive"
            : "text-muted-foreground")
      }
    >
      {value > 0 ? (
        <ArrowUpRight className="size-3" />
      ) : value < 0 ? (
        <ArrowDownRight className="size-3" />
      ) : null}
      {value > 0 ? "+" : ""}
      {Math.abs(value) < 10 ? value.toFixed(1) : Math.round(value)}
      {suffix}
    </span>
  );
}

function Kpi({
  label,
  value,
  delta,
  sub,
  icon,
}: {
  label: string;
  value: string;
  delta?: React.ReactNode;
  sub?: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
        <span className="text-muted-foreground/70">{icon}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {delta}
      </div>
      {sub ? <p className="mt-1 text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

const trendConfig = {
  clicks: { label: "Clicks (last 28 days)", color: "var(--color-primary)" },
  prevClicks: {
    label: "Clicks (prior 28 days)",
    color: "var(--color-muted-foreground)",
  },
} satisfies ChartConfig;

const issuesConfig = {
  count: { label: "Issues", color: "var(--color-primary)" },
} satisfies ChartConfig;

const HEALTH_LABELS: Record<string, string> = {
  live_ok: "Live",
  redirect_intended: "Intended redirect",
  dns_fail: "DNS failure",
  http_error: "Non-200 status",
  ssl_error: "SSL error",
  timeout: "Timed out",
  cf_error: "Cloudflare error",
  parked: "Parked page",
  redirect_other_domain: "Redirects to another domain",
};

function shortDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function when(iso: string | null) {
  if (!iso) return "never";
  const t = Date.parse(
    /^\d{4}-\d{2}-\d{2} /.test(iso) ? `${iso.replace(" ", "T")}Z` : iso,
  );
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function SiteLink({
  projectId,
  domain,
}: {
  projectId: string | null;
  domain: string;
}) {
  if (!projectId) return <span className="truncate">{domain}</span>;
  return (
    <Link
      to="/p/$projectId"
      params={{ projectId }}
      search={{}}
      className="truncate font-medium text-foreground hover:underline"
    >
      {domain}
    </Link>
  );
}

function MoversList({
  rows,
  kind,
}: {
  rows: Fleet["gainers"];
  kind: "up" | "down";
}) {
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No sites moved {kind === "up" ? "up" : "down"} yet.
      </p>
    );
  return (
    <ul className="divide-y divide-border text-sm">
      {rows.map((r) => (
        <li
          key={r.projectId}
          className="flex items-center justify-between gap-3 py-2"
        >
          <SiteLink projectId={r.projectId} domain={r.domain} />
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {fmt(r.prevClicks)} to {fmt(r.clicks)}{" "}
            <span
              className={
                kind === "up"
                  ? "font-medium text-success"
                  : "font-medium text-destructive"
              }
            >
              ({r.delta > 0 ? "+" : ""}
              {fmt(r.delta)})
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Coverage({
  label,
  n,
  of,
  hint,
}: {
  label: string;
  n: number;
  of: number;
  hint?: string;
}) {
  const p = of > 0 ? Math.round((n / of) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {fmt(n)} of {fmt(of)} ({p}%)
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${p}%` }}
        />
      </div>
      {hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function DomainsNotAlive({ health }: { health: Fleet["health"] }) {
  const pageSize = 50;
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => triggerDomainHealthRun({ data: {} }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ["fleetDashboard"] }),
  });
  const [filter, setFilter] = React.useState<string>("all");
  const [page, setPage] = React.useState(1);
  const classes = Object.entries(health.byClass)
    .filter(([c]) => c !== "live_ok" && c !== "redirect_intended")
    .sort((a, b) => b[1] - a[1]);
  const rows = health.down.filter(
    (d) => filter === "all" || d.class === filter,
  );
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(rows.length / pageSize)),
  );
  const offset = (currentPage - 1) * pageSize;
  const visibleRows = rows.slice(offset, offset + pageSize);
  return (
    <CardShell
      title="Domains not alive"
      icon={<ShieldAlert className="size-4 text-destructive" />}
      action={
        <Button
          size="sm"
          variant="outline"
          disabled={run.isPending}
          onClick={() => run.mutate()}
        >
          <RefreshCw className={run.isPending ? "animate-spin" : undefined} />
          {run.isPending ? "Queueing" : "Run now"}
        </Button>
      }
    >
      {run.isSuccess ? (
        <p role="status" className="mb-3 text-sm text-success">
          Queued. Domains are checked a few at a time; open Domain health to
          follow progress.
        </p>
      ) : null}
      {run.isError ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          Could not start the check. Try Run now again.
        </p>
      ) : null}
      {!health.available ? (
        <p className="text-sm text-muted-foreground">
          Domain health has not run yet. The daily check starts on its own
          within minutes of deploy.
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {fmt(health.down.length)} of {fmt(health.checked)} domains need
            attention. Last check {when(health.lastCheckedAt)}.
            {health.missingTag > 0
              ? ` ${fmt(health.missingTag)} live sites have no GA4 or GTM tag.`
              : ""}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => {
                setFilter("all");
                setPage(1);
              }}
              aria-pressed={filter === "all"}
              className={
                "rounded-full border px-2.5 py-0.5 text-xs " +
                (filter === "all"
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground")
              }
            >
              All issues ({fmt(health.down.length)})
            </button>
            {classes.map(([c, n]) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setFilter(c);
                  setPage(1);
                }}
                aria-pressed={filter === c}
                className={
                  "rounded-full border px-2.5 py-0.5 text-xs " +
                  (filter === c
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground")
                }
              >
                {HEALTH_LABELS[c] ?? c} ({fmt(n)})
              </button>
            ))}
          </div>
          <p role="status" className="sr-only">
            {rows.length
              ? `Showing ${fmt(offset + 1)} to ${fmt(offset + visibleRows.length)} of ${fmt(rows.length)} domains matching the selected issue filter.`
              : "No domains match the selected issue filter."}
          </p>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {filter === "all"
                ? "Every checked domain is live or intentionally redirected."
                : "No domains match this issue filter."}
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border border-border">
              <div
                role="region"
                aria-label="Domains needing attention"
                tabIndex={0}
                className="max-h-80 overflow-auto focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/80 text-xs text-muted-foreground backdrop-blur">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">
                        Domain
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        Problem
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        Detail
                      </th>
                      <th className="px-3 py-2 text-left font-medium">
                        Checked
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {visibleRows.map((d) => (
                      <tr key={d.domain}>
                        <td className="max-w-56 truncate px-3 py-1.5">
                          <SiteLink projectId={d.projectId} domain={d.domain} />
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5">
                          <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                            {HEALTH_LABELS[d.class] ?? d.class}
                          </span>
                        </td>
                        <td
                          className="max-w-72 truncate px-3 py-1.5 text-muted-foreground"
                          title={d.error ?? d.finalUrl ?? ""}
                        >
                          {d.httpStatus ? `HTTP ${d.httpStatus}` : ""}
                          {d.class === "redirect_other_domain" && d.finalUrl
                            ? `to ${d.finalUrl}`
                            : ""}
                          {d.class !== "redirect_other_domain" && d.error
                            ? `${d.httpStatus ? ", " : ""}${d.error}`
                            : ""}
                          {d.onCloudflare ? " (Cloudflare)" : ""}
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">
                          {when(d.checkedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <TablePagination
                page={currentPage}
                pageSize={pageSize}
                totalCount={rows.length}
                onPageChange={setPage}
              />
            </div>
          )}
          <Link
            to="/domain-health"
            className="text-xs text-primary underline underline-offset-4"
          >
            View all domain health results
          </Link>
        </div>
      )}
    </CardShell>
  );
}

export function FleetDashboardPage() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["fleetDashboard"],
    queryFn: () => getFleetDashboard({ data: {} }),
    staleTime: 5 * 60 * 1000,
  });
  const refresh = useMutation({
    mutationFn: () => getFleetDashboard({ data: { refresh: true } }),
    onSuccess: (data) => qc.setQueryData(["fleetDashboard"], data),
  });
  // Read after mount: localStorage is not available during SSR, and reading it
  // in render made the server and client markup differ (hydration mismatch).
  const [projectId, setProjectId] = React.useState<string | null>(null);
  React.useEffect(() => setProjectId(getLastProjectId()), []);
  const d = query.data;

  return (
    <div className="px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        {projectId ? (
          <DashboardScopeTabs current="fleet" projectId={projectId} />
        ) : null}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              All sites
            </p>
            <h1 className="text-2xl font-semibold">{fleetChartsLabel}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {d
                ? `Search Console: last 28 days (${shortDay(d.windows.curStart)} to ${shortDay(d.windows.end)}) vs the prior 28 days. Dashboard updated ${when(d.generatedAt)}.`
                : "Search, traffic, audit and uptime health across every project."}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link to="/overview" />}
            >
              <Globe />
              {fleetSiteTableLabel}
            </Button>
            <Button
              variant="outline"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              <RefreshCw
                className={refresh.isPending ? "animate-spin" : undefined}
              />
              {refresh.isPending ? "Rebuilding..." : "Rebuild"}
            </Button>
          </div>
        </div>

        {refresh.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not rebuild the dashboard. Try Rebuild again.
          </p>
        ) : null}
        {refresh.isSuccess ? (
          <p role="status" className="text-sm text-success">
            Dashboard updated from the latest cached data.
          </p>
        ) : null}

        {query.isError ? (
          <QueryError
            error={query.error}
            fallback="Failed to load the dashboard"
            onRetry={() => void query.refetch()}
            isRetrying={query.isFetching}
          />
        ) : !d ? (
          <div className="flex flex-col gap-5" aria-busy>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-28" />
              ))}
            </div>
            <Skeleton className="h-64" />
          </div>
        ) : (
          <FleetBody d={d} />
        )}
      </div>
    </div>
  );
}

function FleetBody({ d }: { d: Fleet }) {
  const ctr =
    d.gsc.impressions > 0 ? (d.gsc.clicks / d.gsc.impressions) * 100 : 0;
  const prevCtr =
    d.gsc.prevImpressions > 0
      ? (d.gsc.prevClicks / d.gsc.prevImpressions) * 100
      : 0;
  const posDelta =
    d.gsc.position != null && d.gsc.prevPosition != null
      ? d.gsc.position - d.gsc.prevPosition
      : null;
  const issuesChart = d.audit.issuesByType
    .slice(0, 10)
    .map((t) => ({ ...t, label: t.type.replace(/-/g, " ") }));
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label="Clicks"
          icon={<MousePointerClick className="size-4" />}
          value={fmt(d.gsc.clicks)}
          delta={<Delta value={pct(d.gsc.clicks, d.gsc.prevClicks)} />}
          sub={`Prior period ${fmt(d.gsc.prevClicks)}`}
        />
        <Kpi
          label="Impressions"
          icon={<BarChart3 className="size-4" />}
          value={fmt(d.gsc.impressions)}
          delta={
            <Delta value={pct(d.gsc.impressions, d.gsc.prevImpressions)} />
          }
          sub={`Prior period ${fmt(d.gsc.prevImpressions)}`}
        />
        <Kpi
          label="CTR"
          icon={<Activity className="size-4" />}
          value={`${ctr.toFixed(2)}%`}
          delta={<Delta value={ctr - prevCtr} suffix=" pts" />}
          sub={`Prior period ${prevCtr.toFixed(2)}%`}
        />
        <Kpi
          label="Avg. position"
          icon={<Search className="size-4" />}
          value={d.gsc.position != null ? d.gsc.position.toFixed(1) : "n/a"}
          delta={<Delta value={posDelta} invert suffix="" />}
          sub={
            d.gsc.prevPosition != null
              ? `Prior period ${d.gsc.prevPosition.toFixed(1)}, lower is better`
              : undefined
          }
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <CardShell title="Search clicks, all sites">
            <p className="mb-3 text-sm text-muted-foreground">
              Daily clicks, current 28 days against the prior 28 days. Based on{" "}
              {fmt(d.dailySites)} of {fmt(d.coverage.gscLinked)} Search Console
              sites
              {d.dailySites < d.gsc.sites
                ? "; the rest fill in over the next hours"
                : ""}
              .
            </p>
            <ChartContainer config={trendConfig} className="h-56 w-full">
              <AreaChart
                data={d.daily}
                margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
              >
                <XAxis
                  dataKey="date"
                  tickFormatter={shortDay}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={32}
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={44}
                  allowDecimals={false}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(l: unknown) =>
                        typeof l === "string" ? shortDay(l) : ""
                      }
                    />
                  }
                />
                <ChartLegend content={<ChartLegendContent />} />
                <Area
                  type="monotone"
                  dataKey="prevClicks"
                  stroke="var(--color-prevClicks)"
                  strokeDasharray="4 4"
                  fill="none"
                  strokeWidth={1.5}
                />
                <Area
                  type="monotone"
                  dataKey="clicks"
                  stroke="var(--color-clicks)"
                  fill="var(--color-clicks)"
                  fillOpacity={0.1}
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartContainer>
          </CardShell>
        </div>
        <CardShell title="GA4 sessions" icon={<Activity className="size-4" />}>
          <div className="space-y-3">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums">
                {fmt(d.ga4.sessions)}
              </span>
              <Delta value={pct(d.ga4.sessions, d.ga4.prevSessions)} />
            </div>
            <p className="text-sm text-muted-foreground">
              Sessions, all channels, for the last 28 complete days in each
              property's reporting time zone, across {fmt(d.ga4.sites)} GA4
              sites. These dates differ from the Search Console window. Prior
              period {fmt(d.ga4.prevSessions)}.
            </p>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Active users</dt>
                <dd className="font-medium tabular-nums">
                  {fmt(d.ga4.users)}{" "}
                  <Delta value={pct(d.ga4.users, d.ga4.prevUsers)} />
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Linked, 0 sessions</dt>
                <dd className="font-medium tabular-nums">
                  {fmt(d.ga4.zeroSessionSites)}
                </dd>
              </div>
            </dl>
          </div>
        </CardShell>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <CardShell
          title="Top gaining sites"
          icon={<ArrowUpRight className="size-4 text-success" />}
        >
          <MoversList rows={d.gainers} kind="up" />
        </CardShell>
        <CardShell
          title="Top losing sites"
          icon={<ArrowDownRight className="size-4 text-destructive" />}
        >
          <MoversList rows={d.losers} kind="down" />
        </CardShell>
        <CardShell title="Coverage" icon={<Globe className="size-4" />}>
          <div className="space-y-4">
            <Coverage
              label="Search Console linked"
              n={d.coverage.gscLinked}
              of={d.coverage.projects}
              hint={`${fmt(d.coverage.gscCached)} with cached data`}
            />
            <Coverage
              label="GA4 linked"
              n={d.coverage.ga4Linked}
              of={d.coverage.projects}
              hint={`${fmt(d.coverage.ga4Cached)} with cached data`}
            />
            <Coverage
              label="Audited"
              n={d.coverage.audited}
              of={d.coverage.projects}
            />
            <p className="text-xs text-muted-foreground">
              {fmt(d.coverage.neither)} sites have neither GSC nor GA4.
            </p>
          </div>
        </CardShell>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <CardShell
          title="Top queries, all sites"
          icon={<Search className="size-4" />}
        >
          {d.topQueries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Top queries are collected in the background, a few sites at a
              time. Check back shortly.
            </p>
          ) : (
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                Top {d.topQueries.length} by clicks, from{" "}
                {fmt(d.coverage.queriesCached)} sites so far.
              </p>
              <div
                role="region"
                aria-label="Top search queries"
                tabIndex={0}
                className="w-full min-w-0 overflow-x-auto rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <table className="w-full min-w-[400px] text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3 text-left font-medium">Query</th>
                      <th className="px-2 py-1 text-right font-medium">
                        Clicks
                      </th>
                      <th className="px-2 py-1 text-right font-medium">
                        Impr.
                      </th>
                      <th className="px-2 py-1 text-right font-medium">Pos.</th>
                      <th className="px-2 py-1 text-right font-medium">
                        Sites
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {d.topQueries.map((q) => (
                      <tr key={q.query}>
                        <td
                          className="max-w-64 truncate py-1.5 pr-3"
                          title={q.query}
                        >
                          {q.query}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {fmt(q.clicks)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                          {fmt(q.impressions)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                          {q.position ?? ""}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                          {q.sites}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardShell>

        <CardShell
          title="Audit health"
          icon={<AlertTriangle className="size-4 text-warning" />}
        >
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-2xl font-semibold tabular-nums text-destructive">
                  {fmt(d.audit.withCritical)}
                </div>
                <div className="text-muted-foreground">
                  sites with critical issues
                </div>
              </div>
              <div>
                <div className="text-2xl font-semibold tabular-nums">
                  {fmt(d.audit.audited)}
                </div>
                <div className="text-muted-foreground">
                  sites audited
                  {d.audit.running ? `, ${d.audit.running} running` : ""}
                </div>
              </div>
              <div>
                <div className="text-base font-semibold">
                  {when(d.audit.lastAuditAt)}
                </div>
                <div className="text-muted-foreground">last audit</div>
              </div>
            </div>
            {issuesChart.length ? (
              <ChartContainer
                config={issuesConfig}
                className="h-72 w-full"
                role="group"
                aria-label={`Top audit issue types: ${issuesChart.map((t) => `${t.label} ${t.count}`).join(", ")}`}
              >
                <BarChart
                  data={issuesChart}
                  layout="vertical"
                  margin={{ top: 0, right: 40, bottom: 0, left: 0 }}
                >
                  <XAxis type="number" hide />
                  <YAxis
                    type="category"
                    dataKey="label"
                    width={160}
                    tick={{ fontSize: 12, fill: "var(--foreground)" }}
                    tickLine={false}
                    axisLine={false}
                    interval={0}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="var(--color-count)" radius={3}>
                    <LabelList
                      dataKey="count"
                      position="right"
                      className="fill-muted-foreground"
                      fontSize={11}
                      formatter={(v: unknown) => fmt(Number(v))}
                    />
                  </Bar>
                </BarChart>
              </ChartContainer>
            ) : null}
            {d.audit.worstSites.length ? (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Most critical issues
                </p>
                <ul className="divide-y divide-border text-sm">
                  {d.audit.worstSites.slice(0, 5).map((s) => (
                    <li
                      key={s.projectId}
                      className="flex justify-between gap-3 py-1.5"
                    >
                      <SiteLink projectId={s.projectId} domain={s.domain} />
                      <span className="tabular-nums text-destructive">
                        {fmt(s.critical)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </CardShell>
      </div>

      <DomainsNotAlive health={d.health} />
    </>
  );
}
