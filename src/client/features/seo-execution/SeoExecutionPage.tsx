import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ClipboardCheck,
  Copy,
  Download,
  Gauge,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/client/components/ui/button";
import { Skeleton } from "@/client/components/ui/skeleton";
import { QueryError } from "@/client/components/QueryState";
import { getSeoExecutionPlan } from "@/serverFunctions/seoExecution";
import { ActionRow, Kpi } from "./SeoExecutionCards";
import {
  buildSeoReviewPacket,
  type SeoExecutionPlan,
} from "@/shared/seo-execution/plan";

type QueueFilter = "all" | "scored" | "measurement";

function downloadPacket(plan: SeoExecutionPlan, selectedIds: string[]) {
  const packet = buildSeoReviewPacket(plan, selectedIds);
  const json = JSON.stringify(packet, null, 2);
  const url = URL.createObjectURL(
    new Blob([json], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "openseo-review-packet.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function SeoExecutionPage({ projectId }: { projectId: string }) {
  const [filter, setFilter] = React.useState<QueueFilter>("all");
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const query = useQuery({
    queryKey: ["seoExecutionPlan", projectId],
    queryFn: () => getSeoExecutionPlan({ data: { projectId } }),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const plan = query.data;
  const selected = React.useMemo(() => new Set(selectedIds), [selectedIds]);
  const filtered = React.useMemo(
    () =>
      plan?.actions.filter(
        (action) =>
          filter === "all" ||
          (filter === "scored" && action.score !== null) ||
          (filter === "measurement" && action.score === null),
      ) ?? [],
    [plan, filter],
  );

  function select(id: string, checked: boolean) {
    setSelectedIds((current) =>
      checked
        ? [...new Set([...current, id])]
        : current.filter((item) => item !== id),
    );
  }

  async function copyReviewPacket() {
    if (!plan) return;
    const packet = buildSeoReviewPacket(plan, selectedIds);
    if (packet.actions.length === 0) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(packet, null, 2));
      toast.success(`Copied ${packet.actions.length} review actions`);
    } catch {
      toast.error("Clipboard access unavailable. Use Download JSON instead.");
    }
  }

  const selectedCount =
    plan?.actions.filter((action) => selected.has(action.id)).length ?? 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-14">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            SEO execution
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Action planner
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Turn first-party search signals into prioritized work. Every action
            carries evidence and requires review before changes.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw
            className={`mr-2 size-4 ${query.isFetching ? "animate-spin" : ""}`}
            aria-hidden
          />
          Refresh signals
        </Button>
      </header>

      <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/30 p-4">
        <ShieldCheck className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div>
          <p className="text-sm font-medium">
            Review-only — no automatic publishing or site changes
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Scores rank opportunities relative to other pages in this project.
            They do not predict clicks, revenue or ranking outcomes.
          </p>
        </div>
      </div>

      {query.isPending ? (
        <div
          className="space-y-4"
          aria-busy="true"
          aria-label="Loading SEO actions"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            {[0, 1, 2].map((n) => (
              <Skeleton key={n} className="h-28 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
        </div>
      ) : query.isError ? (
        <div className="space-y-4 rounded-xl border border-border bg-card p-6">
          <QueryError
            error={query.error}
            fallback="Couldn't build the execution plan"
          />
          <p className="text-sm text-muted-foreground">
            This view requires connected Search Console and Google Analytics
            data. A missing connection is not treated as zero opportunity.
          </p>
          <Button
            variant="outline"
            nativeButton={false}
            render={
              <Link
                to="/p/$projectId/settings/integrations"
                params={{ projectId }}
              />
            }
          >
            Check integrations
          </Button>
        </div>
      ) : plan ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Kpi
              title="Scored opportunities"
              value={plan.summary.scored}
              description="Supported by GSC and GA4"
            />
            <Kpi
              title="Measurement gaps"
              value={plan.summary.measurementGaps}
              description="GSC pages without usable scores"
            />
            <Kpi
              title="Candidates"
              value={plan.summary.totalCandidates}
              description={
                plan.summary.totalCandidates > plan.summary.displayed
                  ? `Showing ${plan.summary.displayed} reviewed candidates`
                  : "All identified candidates displayed"
              }
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Gauge className="size-4" aria-hidden />
            <span>
              Reporting period: {plan.source.period.startDate} to{" "}
              {plan.source.period.endDate}
            </span>
            <span aria-hidden>·</span>
            <span>Priority is a relative score, not a forecast</span>
          </div>

          {plan.summary.warnings.length > 0 && (
            <div
              className="rounded-xl border border-border bg-muted/40 px-4 py-3"
              role="status"
            >
              <p className="text-sm font-medium">Data coverage limits</p>
              <ul className="mt-2 list-inside list-disc space-y-1 text-xs text-muted-foreground">
                {plan.summary.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">
                Prioritized action queue
              </h2>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["all", "All"],
                    ["scored", "Scored"],
                    ["measurement", "Needs data"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    className={
                      "rounded-lg px-3 py-1.5 text-xs font-medium transition " +
                      (filter === value
                        ? "bg-foreground text-background"
                        : "border border-border bg-card hover:bg-muted")
                    }
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {filtered.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-10 text-center">
                <ClipboardCheck
                  className="mx-auto size-7 text-muted-foreground"
                  aria-hidden
                />
                <p className="mt-3 font-medium">
                  {plan.actions.length === 0
                    ? "No pages currently match the 4–20 position opportunity band."
                    : "No actions match this filter."}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Review your Search Console coverage or refresh the plan when
                  new performance data is available.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {filtered.map((action) => (
                  <ActionRow
                    key={action.id}
                    action={action}
                    selected={selected.has(action.id)}
                    onSelect={select}
                  />
                ))}
              </div>
            )}
          </div>

          {plan.actions.length > 0 && (
            <footer className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-3 shadow-lg">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setSelectedIds((current) =>
                      filtered.every((action) => current.includes(action.id))
                        ? current.filter(
                            (id) =>
                              !filtered.some((action) => action.id === id),
                          )
                        : [
                            ...new Set([
                              ...current,
                              ...filtered.map((action) => action.id),
                            ]),
                          ],
                    )
                  }
                >
                  {filtered.length > 0 &&
                  filtered.every((action) => selected.has(action.id))
                    ? "Deselect visible"
                    : "Select visible"}
                </Button>
                <span className="text-sm text-muted-foreground">
                  {selectedCount} selected
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selectedCount === 0}
                  onClick={() => void copyReviewPacket()}
                >
                  <Copy className="mr-1.5 size-4" aria-hidden />
                  Copy review packet
                </Button>
                <Button
                  size="sm"
                  disabled={selectedCount === 0}
                  onClick={() => downloadPacket(plan, selectedIds)}
                >
                  <Download className="mr-1.5 size-4" aria-hidden />
                  Download JSON
                </Button>
              </div>
            </footer>
          )}
        </>
      ) : null}
    </div>
  );
}
