// CityThrive fork: GA4 setup status, with explicit per-site and fleet scopes.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { PageHeader } from "@/client/components/PageHeader";
import { TablePagination } from "@/client/components/table/TablePagination";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import { Label } from "@/client/components/ui/label";
import {
  TableBody,
  TableCaption,
  TableCard,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getGa4SetupOverview,
  runGa4SetupBulk,
  runGa4SetupSite,
} from "@/serverFunctions/ga4Setup";

export const Route = createFileRoute("/_app/ga4-setup")({
  component: Ga4SetupPage,
  validateSearch: (s: Record<string, unknown>) => ({
    projectId: typeof s.projectId === "string" ? s.projectId : undefined,
  }),
});

type Step = { step: string; status: string; detail?: string };
type Result = {
  domain: string;
  final: string;
  steps: Step[];
  measurementId?: string;
};
const PAGE_SIZE = 50;

function Ga4SetupPage() {
  const { projectId } = Route.useSearch();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["ga4-setup"],
    queryFn: () => getGa4SetupOverview(),
    refetchInterval: 30_000,
  });
  const [results, setResults] = useState<Result[]>([]);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const tableRegion = useRef<HTMLDivElement>(null);
  const site = useMutation({
    mutationFn: (v: { projectId: string; apply: boolean }) =>
      runGa4SetupSite({ data: { ...v, confirm: v.apply } }),
    onSuccess: (r) => {
      const result = r as Result;
      setResults((current) => [
        result,
        ...current.filter((entry) => entry.domain !== result.domain),
      ]);
      void qc.invalidateQueries({ queryKey: ["ga4-setup"] });
    },
  });
  const bulk = useMutation({
    mutationFn: (v: { apply: boolean; limit: number }) =>
      runGa4SetupBulk({ data: { ...v, confirm: v.apply } }),
    onSuccess: (r) => {
      setResults((r as { results: Result[] }).results);
      void qc.invalidateQueries({ queryKey: ["ga4-setup"] });
    },
  });
  const data = q.data;
  const states = (data?.state ?? []).filter(
    (state) => !projectId || state.projectId === projectId,
  );
  const stateBy = new Map(states.map((state) => [state.domain, state]));
  const counts: Record<string, number> = {};
  for (const state of states)
    counts[state.status] = (counts[state.status] ?? 0) + 1;
  const scopeMissing = (data?.missing ?? []).filter(
    (entry) => !projectId || entry.projectId === projectId,
  );
  const needle = filter.trim().toLowerCase();
  const missing = scopeMissing.filter((entry) =>
    entry.domain.toLowerCase().includes(needle),
  );
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(missing.length / PAGE_SIZE)),
  );
  const start = (currentPage - 1) * PAGE_SIZE;
  const visibleRows = missing.slice(start, start + PAGE_SIZE);
  const busy = site.isPending || bulk.isPending;
  const error = site.error ?? bulk.error ?? q.error;
  const confirmApply = (what: string) =>
    window.confirm(
      `Apply GA4 setup for ${what}? This creates GA4 properties, installs the tag through Cloudflare and links them.`,
    );

  function changePage(nextPage: number) {
    setPage(nextPage);
    requestAnimationFrame(() => {
      tableRegion.current?.focus();
      tableRegion.current?.scrollIntoView({ block: "start" });
    });
  }

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
              {Object.entries(counts).map(([status, count]) => (
                <span key={status} className="rounded bg-muted px-2 py-1">
                  {status}: {count.toLocaleString()}
                </span>
              ))}
            </div>
          </section>
        ) : null}
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
                  ? `${missing.length.toLocaleString()} ${missing.length === 1 ? "site" : "sites"}${needle ? " match this filter" : " missing a GA4 link"}.`
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
          <Label htmlFor="ga4-domain-filter">
            Filter missing sites by domain
          </Label>
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
        <section
          aria-labelledby="ga4-missing-heading"
          className="min-w-0 space-y-3"
        >
          <h2 id="ga4-missing-heading" className="text-lg font-semibold">
            Sites missing a GA4 link
          </h2>
          {visibleRows.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              Scroll the table horizontally on a small screen to see each site's
              last result and actions.
            </p>
          ) : null}
          <TableCard>
            {!q.isPending && visibleRows.length === 0 ? (
              <p role="status" className="p-6 text-sm text-muted-foreground">
                {q.isError && !data
                  ? "Unable to load sites. Please try again."
                  : needle
                    ? "No missing sites match this domain filter."
                    : projectId
                      ? "This project has no missing GA4 link."
                      : "Every project with a domain has a GA4 link."}
              </p>
            ) : (
              <div
                ref={tableRegion}
                role="region"
                aria-label="GA4 links and setup actions"
                tabIndex={0}
                className="overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              >
                <table
                  id="ga4-missing-sites"
                  className="w-full min-w-[56rem] text-sm"
                >
                  <TableCaption className="sr-only">
                    Missing GA4 links, with the latest setup attempt and
                    per-site actions.
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Site</TableHead>
                      <TableHead scope="col">Latest status</TableHead>
                      <TableHead scope="col">Measurement ID</TableHead>
                      <TableHead scope="col">Last result</TableHead>
                      <TableHead scope="col">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleRows.map((entry) => {
                      const state = stateBy.get(entry.domain);
                      return (
                        <TableRow key={entry.projectId}>
                          <TableCell className="max-w-xs break-words">
                            {entry.domain}
                          </TableCell>
                          <TableCell>
                            {state?.status ?? "Not attempted"}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {state?.measurementId ?? "—"}
                          </TableCell>
                          <TableCell className="min-w-64 max-w-md break-words text-muted-foreground">
                            {state?.detail || "No setup result recorded"}
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                aria-label={`Preview GA4 setup for ${entry.domain}`}
                                onClick={() =>
                                  site.mutate({
                                    projectId: entry.projectId,
                                    apply: false,
                                  })
                                }
                              >
                                Preview
                              </Button>
                              <Button
                                size="sm"
                                disabled={busy}
                                aria-label={`Set up GA4 for ${entry.domain}`}
                                onClick={() =>
                                  confirmApply(entry.domain) &&
                                  site.mutate({
                                    projectId: entry.projectId,
                                    apply: true,
                                  })
                                }
                              >
                                Set up
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {visibleRows.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="py-8 text-center text-muted-foreground"
                        >
                          {q.isPending
                            ? "Loading sites…"
                            : q.isError && !data
                              ? "Unable to load sites. Please try again."
                              : needle
                                ? "No missing sites match this domain filter."
                                : projectId
                                  ? "This project has no missing GA4 link."
                                  : "Every project with a domain has a GA4 link."}
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </table>
              </div>
            )}
            {missing.length > PAGE_SIZE ? (
              <TablePagination
                page={currentPage}
                pageSize={PAGE_SIZE}
                totalCount={missing.length}
                onPageChange={changePage}
              />
            ) : null}
          </TableCard>
        </section>
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
