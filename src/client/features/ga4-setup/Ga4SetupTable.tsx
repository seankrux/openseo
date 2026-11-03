import { TablePagination } from "@/client/components/table/TablePagination";
import { Button } from "@/client/components/ui/button";
import {
  TableBody,
  TableCaption,
  TableCard,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import { confirmApply, PAGE_SIZE, statusLabel } from "./Ga4SetupModel";

import type { Ga4SetupView } from "./useGa4Setup";
export function Ga4SetupTable({ model }: { model: Ga4SetupView }) {
  const {
    q,
    view,
    tableRegion,
    site,
    data,
    stateBy,
    needle,
    missing,
    currentPage,
    visibleRows,
    busy,
    changePage,
    projectId,
  } = model;
  return (
    <section
      aria-labelledby="ga4-missing-heading"
      className="min-w-0 space-y-3"
    >
      <h2 id="ga4-missing-heading" className="text-lg font-semibold">
        {view === "missing"
          ? "Sites missing a GA4 link"
          : "Sites whose setup needs attention"}
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
                ? "No sites match this domain filter."
                : view === "attention"
                  ? "No setup attempt needs attention."
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
                {view === "missing"
                  ? "Missing GA4 links, with the latest setup attempt and per-site actions."
                  : "Sites whose last GA4 setup attempt failed, was blocked or is waiting, with per-site actions."}
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
                        {state ? statusLabel(state.status) : "Not attempted"}
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
                            ? "No sites match this domain filter."
                            : view === "attention"
                              ? "No setup attempt needs attention."
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
  );
}
