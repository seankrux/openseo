import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import { FleetReauditPanel } from "@/client/features/fleet/FleetReauditPanel";
import { Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { COVERAGE_CHIPS, Delta, exportCsv, pct } from "./SiteOverviewModel";

import type { SiteOverviewView } from "./useSiteOverview";
export function SiteOverviewControls({ model }: { model: SiteOverviewView }) {
  const {
    filter,
    coverage,
    updateSearch,
    rows,
    counts,
    totals,
    providerIssues,
    data,
  } = model;
  if (!data) return null;
  return (
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
            Reconnecting the Google account once fixes every site that uses it.
            Numbers refill in the background afterwards.
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
            {(counts.critical ?? 0).toLocaleString()} sites have critical audit
            issues.
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
            <Delta v={pct(totals.sessions, totals.prevSessions)} suffix="%" />)
          </span>
        ) : (
          <span className="text-muted-foreground">
            GA4 sessions unavailable
          </span>
        )}
        {data.pending + data.refreshingGsc + data.refreshingGa4 > 0 ? (
          <span role="status" className="text-amber-800 dark:text-amber-300">
            {[
              data.pendingGsc > 0
                ? providerIssues.some((i) => i.provider === "Search Console")
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
    </>
  );
}
