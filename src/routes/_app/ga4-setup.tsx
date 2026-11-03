import { PageHeader } from "@/client/components/PageHeader";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import { Label } from "@/client/components/ui/label";
import {
  ATTENTION,
  confirmApply,
  statusLabel,
} from "@/client/features/ga4-setup/Ga4SetupModel";
import { Ga4SetupTable } from "@/client/features/ga4-setup/Ga4SetupTable";
import { useGa4Setup } from "@/client/features/ga4-setup/useGa4Setup";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { createFileRoute, Link } from "@tanstack/react-router";
import { sort as sortArray } from "remeda";
export const Route = createFileRoute("/_app/ga4-setup")({
  component: Ga4SetupPage,
  validateSearch: (s: Record<string, unknown>) => ({
    projectId: typeof s.projectId === "string" ? s.projectId : undefined,
  }),
});
function Ga4SetupPage() {
  const { projectId } = Route.useSearch();
  const model = useGa4Setup(projectId);
  const {
    q,
    results,
    filter,
    setFilter,
    setPage,
    view,
    setView,
    bulk,
    data,
    states,
    counts,
    scopeMissing,
    scopeAttention,
    needle,
    missing,
    busy,
    error,
  } = model;
  return (
    <div className="h-full overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6">
      <div className="mx-auto min-w-0 max-w-7xl space-y-6">
        <PageHeader
          title="GA4 setup status"
          description="Review GA4 property links and previous setup attempts. Preview a site before applying setup; applying can create a property, install its tag, and link it to the project."
        />
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <p className="font-medium">
            {projectId ? "This project" : "All sites"}
          </p>
          {projectId ? (
            <Link
              to="/ga4-setup"
              search={{ projectId: undefined }}
              className="text-primary underline underline-offset-4"
            >
              View all sites
            </Link>
          ) : null}
          {data ? (
            <p>
              Missing GA4 links:{" "}
              <strong>{scopeMissing.length.toLocaleString()}</strong>
            </p>
          ) : null}
        </div>
        {data && states.length > 0 ? (
          <section
            aria-labelledby="ga4-attempt-status"
            className="space-y-2 text-sm"
          >
            <h2 id="ga4-attempt-status" className="font-medium">
              Previous setup attempts
              {projectId ? " for this project" : " across all sites"}
            </h2>
            <p className="text-muted-foreground">
              These are the latest recorded setup outcomes. The table below
              shows only sites still missing a GA4 property link.
            </p>
            <div className="flex flex-wrap gap-2">
              {sortArray(Object.entries(counts), (a, b) => b[1] - a[1]).map(
                ([status, count]) => (
                  <span
                    key={status}
                    className={
                      "rounded px-2 py-1 " +
                      (ATTENTION.has(status)
                        ? "bg-destructive/10 text-destructive"
                        : "bg-muted")
                    }
                  >
                    {statusLabel(status)}: {count.toLocaleString()}
                  </span>
                ),
              )}
            </div>
          </section>
        ) : null}
        <div
          role="group"
          aria-label="Which sites to list"
          className="flex flex-wrap gap-2 text-sm"
        >
          <Button
            size="sm"
            variant={view === "missing" ? "default" : "outline"}
            aria-pressed={view === "missing"}
            onClick={() => {
              setView("missing");
              setPage(1);
            }}
          >
            Missing a GA4 link ({scopeMissing.length.toLocaleString()})
          </Button>
          <Button
            size="sm"
            variant={view === "attention" ? "default" : "outline"}
            aria-pressed={view === "attention"}
            onClick={() => {
              setView("attention");
              setPage(1);
            }}
          >
            Setup needs attention ({scopeAttention.length.toLocaleString()})
          </Button>
        </div>
        {error ? (
          <p role="alert" className="break-words text-sm text-destructive">
            {getStandardErrorMessage(error)}
          </p>
        ) : null}
        <p
          role="status"
          aria-atomic="true"
          className="text-sm text-muted-foreground"
        >
          {q.isPending
            ? "Loading GA4 setup status…"
            : busy
              ? "Working on GA4 setup. Other setup actions are paused until this finishes…"
              : results.length > 0
                ? `Setup finished for ${results.length.toLocaleString()} ${results.length === 1 ? "site" : "sites"}. Review the results below.`
                : data
                  ? `${missing.length.toLocaleString()} ${missing.length === 1 ? "site" : "sites"}${needle ? " match this filter" : view === "missing" ? " missing a GA4 link" : " with a failed, blocked or waiting setup"}.`
                  : ""}
        </p>
        {!projectId ? (
          <section aria-label="All sites batch setup" className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={
                  busy || !data || scopeMissing.length === 0 || Boolean(needle)
                }
                onClick={() => bulk.mutate({ apply: false, limit: 10 })}
              >
                Preview next 10 missing sites
              </Button>
              <Button
                disabled={
                  busy || !data || scopeMissing.length === 0 || Boolean(needle)
                }
                onClick={() =>
                  confirmApply("the next 10 missing sites across all sites") &&
                  bulk.mutate({ apply: true, limit: 10 })
                }
              >
                Set up next 10 missing sites
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Batch actions cover all sites.{" "}
              {needle
                ? "Clear the domain filter to use them."
                : "Use the row actions to preview or set up one site."}
            </p>
          </section>
        ) : null}
        <div className="max-w-md space-y-2">
          <Label htmlFor="ga4-domain-filter">Filter sites by domain</Label>
          <Input
            id="ga4-domain-filter"
            type="search"
            placeholder="Search domains"
            value={filter}
            aria-controls="ga4-missing-sites"
            onChange={(event) => {
              setFilter(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <Ga4SetupTable model={model} />
        {results.length > 0 ? (
          <section
            aria-labelledby="ga4-last-run"
            className="space-y-3 rounded-xl border border-border bg-card p-4 text-sm"
          >
            <h2 id="ga4-last-run" className="font-semibold">
              Last setup results
            </h2>
            {results.map((result) => (
              <div key={result.domain} className="space-y-1 break-words">
                <p>
                  <strong>{result.domain}</strong>: {result.final}
                  {result.measurementId ? ` · ${result.measurementId}` : ""}
                </p>
                <ul className="ml-4 list-disc text-muted-foreground">
                  {result.steps.map((step, index) => (
                    <li key={index}>
                      {step.step}: {step.status}
                      {step.detail ? ` · ${step.detail}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ) : null}
        {data && data.log.length > 0 ? (
          <details className="rounded-xl border border-border bg-card p-4 text-sm">
            <summary className="cursor-pointer font-medium">
              Recent setup activity (all sites)
            </summary>
            <div
              role="region"
              aria-label="GA4 setup activity log"
              tabIndex={0}
              className="mt-3 max-h-64 space-y-1 overflow-y-auto break-words font-mono text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              {data.log.map((line, index) => (
                <p key={index}>{line}</p>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}
