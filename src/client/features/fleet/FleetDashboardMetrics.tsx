import { Link } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  MousePointerClick,
  Search,
} from "lucide-react";
import type { Fleet } from "./FleetDashboardParts";
import { Delta, fmt, Kpi, pct, PROVIDER_LABELS } from "./FleetDashboardParts";
export function FleetDashboardMetrics({ d }: { d: Fleet }) {
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
  return (
    <>
      <div
        role="status"
        className="rounded-lg border border-border bg-card p-4 text-sm"
      >
        <p className="font-medium">
          {fmt(d.coverage.projects)} active websites · totals reflect available
          data, not every linked site
        </p>
        <p className="mt-1 text-muted-foreground">
          Current metrics: Search Console {fmt(d.gsc.sites)}/
          {fmt(d.coverage.gscLinked)} linked sites; GA4 {fmt(d.ga4.sites)}/
          {fmt(d.coverage.ga4Linked)}; Bing {fmt(d.bing.sites)}/
          {fmt(d.coverage.bingLinked)}. Missing, failed and stale data is
          excluded—not treated as zero. All websites and account states are
          listed below.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Providers refresh in the background. Rebuild snapshot only re-reads
          stored data; it does not reconnect Google accounts or fetch the whole
          fleet.
        </p>
      </div>
      {d.providerIssues.length > 0 ? (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
        >
          {d.providerIssues.map((issue) => (
            <div
              key={`${issue.provider}:${issue.error}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1"
            >
              <AlertTriangle
                className="size-4 shrink-0 text-destructive"
                aria-hidden
              />
              <span>
                <strong>{PROVIDER_LABELS[issue.provider]}</strong> data is
                unavailable for {fmt(issue.sites)} sites: {issue.error}
              </span>
              {issue.provider === "bing" ? null : (
                <Link
                  to="/p/$projectId/settings/integrations"
                  params={{ projectId: issue.projectId }}
                  className="font-medium text-primary underline underline-offset-4"
                >
                  Reconnect {PROVIDER_LABELS[issue.provider]}
                </Link>
              )}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Reconnecting a Google account once fixes every site that uses it.
            The dashboard picks the numbers up on its next rebuild.
          </p>
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label="GSC clicks"
          icon={<MousePointerClick className="size-4" />}
          value={d.gsc.sites ? fmt(d.gsc.clicks) : "Unavailable"}
          delta={
            d.gsc.sites ? (
              <Delta value={pct(d.gsc.clicks, d.gsc.prevClicks)} />
            ) : undefined
          }
          sub={
            d.gsc.sites
              ? `From ${fmt(d.gsc.sites)} sites · prior ${fmt(d.gsc.prevClicks)}`
              : "No current Search Console metrics"
          }
        />
        <Kpi
          label="GSC impressions"
          icon={<BarChart3 className="size-4" />}
          value={d.gsc.sites ? fmt(d.gsc.impressions) : "Unavailable"}
          delta={
            d.gsc.sites ? (
              <Delta value={pct(d.gsc.impressions, d.gsc.prevImpressions)} />
            ) : undefined
          }
          sub={
            d.gsc.sites
              ? `From ${fmt(d.gsc.sites)} sites · prior ${fmt(d.gsc.prevImpressions)}`
              : "No current Search Console metrics"
          }
        />
        <Kpi
          label="GSC CTR"
          icon={<Activity className="size-4" />}
          value={
            !d.gsc.sites
              ? "Unavailable"
              : d.gsc.impressions > 0
                ? `${ctr.toFixed(2)}%`
                : "n/a"
          }
          delta={
            d.gsc.impressions > 0 && d.gsc.prevImpressions > 0 ? (
              <Delta value={ctr - prevCtr} suffix=" pts" />
            ) : undefined
          }
          sub={
            d.gsc.sites
              ? d.gsc.prevImpressions > 0
                ? `Prior period ${prevCtr.toFixed(2)}%`
                : "No prior-period impressions"
              : "No current Search Console metrics"
          }
        />
        <Kpi
          label="GSC avg. position"
          icon={<Search className="size-4" />}
          value={
            !d.gsc.sites
              ? "Unavailable"
              : d.gsc.position != null
                ? d.gsc.position.toFixed(1)
                : "n/a"
          }
          delta={
            posDelta !== null ? (
              <Delta value={posDelta} invert suffix="" />
            ) : undefined
          }
          sub={
            d.gsc.prevPosition != null
              ? `Prior period ${d.gsc.prevPosition.toFixed(1)}, lower is better`
              : "Position requires reported impressions"
          }
        />
      </div>
    </>
  );
}
