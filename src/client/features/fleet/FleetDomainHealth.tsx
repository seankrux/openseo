import { useQueryClient } from "@tanstack/react-query";

import { useMutation } from "@tanstack/react-query";

import { triggerDomainHealthRun } from "@/serverFunctions/domainHealth";

import * as React from "react";

import { sort as sortArray } from "remeda";

import { CardShell } from "@/client/components/CardShell";

import { ShieldAlert } from "lucide-react";

import { Button } from "@/client/components/ui/button";

import { RefreshCw } from "lucide-react";

import { TablePagination } from "@/client/components/table/TablePagination";

import { Link } from "@tanstack/react-router";

import {
  type Fleet,
  fmt,
  HEALTH_LABELS,
  SiteLink,
  when,
} from "./FleetDashboardParts";

export function DomainsNotAlive({ health }: { health: Fleet["health"] }) {
  const pageSize = 50;
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => triggerDomainHealthRun({ data: {} }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ["fleetDashboard"] }),
  });
  const [filter, setFilter] = React.useState<string>("all");
  const [page, setPage] = React.useState(1);
  const classes = sortArray(
    Object.entries(health.byClass).filter(
      ([c]) => c !== "live_ok" && c !== "redirect_intended",
    ),
    (a, b) => b[1] - a[1],
  );
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
