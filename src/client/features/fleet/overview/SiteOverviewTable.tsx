import { TablePagination } from "@/client/components/table/TablePagination";
import type { SortKey } from "./SiteOverviewModel";
import { PAGE_SIZE } from "./SiteOverviewModel";

import { SiteOverviewRow } from "./SiteOverviewRow";
import type { SiteOverviewView } from "./useSiteOverview";
export function SiteOverviewTable({ model }: { model: SiteOverviewView }) {
  const {
    visibleRows,
    rows,
    currentPage,
    setPage,
    sortKey,
    desc,
    updateSearch,
    accounts,
    blocked,
    reauditOne,
  } = model;
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

  return (
    <div className="overflow-hidden rounded-md border">
      <div
        role="region"
        aria-label="All sites metrics, scroll horizontally for more columns"
        tabIndex={0}
        className="overflow-x-auto"
      >
        <table className="w-full text-sm">
          <caption className="sr-only">
            Search Console, Google Analytics, and latest audit results for the
            filtered sites.
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
            {visibleRows.map((r) => (
              <SiteOverviewRow
                key={r.projectId}
                r={r}
                accounts={accounts}
                blocked={blocked}
                reauditOne={reauditOne}
              />
            ))}
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
  );
}
