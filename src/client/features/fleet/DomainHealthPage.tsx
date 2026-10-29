// CityThrive fork: Domain health for every project domain. Results come from
// the daily in-app check (a few domains every 5 minutes).
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { PageHeader } from "@/client/components/PageHeader";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import { Skeleton } from "@/client/components/ui/skeleton";
import { QueryError } from "@/client/components/QueryState";
import {
  getDomainHealth,
  triggerDomainHealthRun,
} from "@/serverFunctions/domainHealth";

export const HEALTH_LABELS: Record<string, string> = {
  live_ok: "Live",
  redirect_intended: "Intended redirect",
  redirect_other_domain: "Redirects to another domain",
  dns_fail: "DNS failure",
  http_error: "Non-200 status",
  ssl_error: "SSL error",
  timeout: "Timed out",
  cf_error: "Cloudflare error",
  parked: "Parked page",
};

const OK = new Set(["live_ok", "redirect_intended"]);

const CHANGE_LABELS: Record<string, string> = {
  went_down: "went down",
  came_back: "came back",
  class_changed: "status changed",
  ssl_expiring_soon: "SSL certificate expiring soon",
  ga4_tag_removed: "GA4 tag removed",
  gtm_tag_removed: "GTM tag removed",
};

type Change = { domain: string; kind: string; detectedAt: string };

/**
 * A site going down or coming back is also recorded as a status change; the
 * list shows the event once, keeping the plain status change only when it is
 * the whole story (for example a redirect that became an SSL error).
 */
function dedupeChanges<T extends Change>(changes: T[]): T[] {
  const covered = new Set(
    changes
      .filter((c) => c.kind === "went_down" || c.kind === "came_back")
      .map((c) => `${c.domain}@${c.detectedAt}`),
  );
  return changes.filter(
    (c) =>
      c.kind !== "class_changed" || !covered.has(`${c.domain}@${c.detectedAt}`),
  );
}

function when(iso: string | null) {
  if (!iso) return "never";
  const t = Date.parse(iso);
  return Number.isNaN(t)
    ? iso
    : new Date(t).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

type Filter = "problems" | "all" | "noTag" | string;

export function DomainHealthPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["domainHealth"],
    queryFn: () => getDomainHealth(),
    refetchInterval: 60_000,
  });
  const run = useMutation({
    mutationFn: () => triggerDomainHealthRun({ data: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["domainHealth"] }),
  });
  const [filter, setFilter] = React.useState<Filter>("problems");
  const [text, setText] = React.useState("");
  const d = q.data;
  const counts = React.useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of d?.rows ?? []) c[r.class] = (c[r.class] ?? 0) + 1;
    return c;
  }, [d]);
  const noTag = (d?.rows ?? []).filter(
    (r) => r.class === "live_ok" && !r.ga4Ids.length && !r.gtmIds.length,
  ).length;
  const rows = (d?.rows ?? []).filter((r) => {
    if (text && !r.domain.includes(text.toLowerCase())) return false;
    if (filter === "all") return true;
    if (filter === "problems") return !OK.has(r.class);
    if (filter === "noTag")
      return r.class === "live_ok" && !r.ga4Ids.length && !r.gtmIds.length;
    return r.class === filter;
  });
  const problems = (d?.rows ?? []).filter((r) => !OK.has(r.class)).length;
  const chip = (key: Filter, label: string, n: number) => (
    <button
      key={key}
      type="button"
      onClick={() => setFilter(key)}
      aria-pressed={filter === key}
      className={
        "rounded-full border px-2.5 py-0.5 text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 " +
        (filter === key
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border text-muted-foreground")
      }
    >
      {label} ({n})
    </button>
  );
  return (
    <div className="px-4 py-4 md:px-6 md:py-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <PageHeader
          title="Domain health"
          description={
            d
              ? `${d.progress.checked} of ${d.progress.total} project domains checked, ${d.progress.pending} due now. Last check ${when(d.progress.lastCheckedAt)}. Checks run daily on their own, a few domains every 5 minutes.`
              : "DNS, HTTP status, SSL, redirects, parked pages, Cloudflare errors and GA4 or GTM tags for every site."
          }
          actions={
            <Button
              variant="outline"
              disabled={run.isPending}
              onClick={() => run.mutate()}
            >
              <RefreshCw
                className={run.isPending ? "animate-spin" : undefined}
              />
              {run.isPending ? "Queueing" : "Run now"}
            </Button>
          }
        />
        {run.isSuccess ? (
          <p role="status" className="text-sm text-success">
            Queued {run.data.queued} domains. They are checked a few at a time;
            this page refreshes every minute.
          </p>
        ) : null}
        {run.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not start the check. Try Run now again.
          </p>
        ) : null}
        {q.isError ? (
          <QueryError
            error={q.error}
            fallback="Failed to load domain health"
            onRetry={() => void q.refetch()}
            isRetrying={q.isFetching}
          />
        ) : !d ? (
          <Skeleton className="h-96" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              {chip("problems", "Needs attention", problems)}
              {chip("all", "All", d.rows.length)}
              {Object.entries(counts)
                .sort((a, b) => b[1] - a[1])
                .map(([c, n]) => chip(c, HEALTH_LABELS[c] ?? c, n))}
              {chip("noTag", "Live, no GA4 or GTM tag", noTag)}
              <Input
                className="h-8 w-full sm:ml-auto sm:w-56"
                placeholder="Filter by domain"
                aria-label="Filter by domain"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
            <p role="status" className="sr-only">
              {rows.length} checked domains match the current filters.
            </p>
            <div
              role="region"
              aria-label="Domain health results"
              tabIndex={0}
              className="overflow-auto rounded-md border border-border focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <table className="w-full min-w-[760px] text-sm">
                <thead className="sticky top-0 bg-muted/80 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Domain</th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                    <th className="px-3 py-2 text-left font-medium">HTTP</th>
                    <th className="px-3 py-2 text-left font-medium">
                      Final URL or error
                    </th>
                    <th className="px-3 py-2 text-left font-medium">Tags</th>
                    <th className="px-3 py-2 text-left font-medium">CF</th>
                    <th className="px-3 py-2 text-left font-medium">Checked</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.slice(0, 500).map((r) => (
                    <tr key={r.domain}>
                      <td className="max-w-60 truncate px-3 py-1.5">
                        {r.projectId ? (
                          <Link
                            to="/p/$projectId"
                            params={{ projectId: r.projectId }}
                            search={{}}
                            className="font-medium hover:underline"
                          >
                            {r.domain}
                          </Link>
                        ) : (
                          r.domain
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5">
                        <span
                          className={
                            "rounded px-1.5 py-0.5 text-xs " +
                            (OK.has(r.class)
                              ? "bg-success/10 text-success"
                              : "bg-destructive/10 text-destructive")
                          }
                        >
                          {HEALTH_LABELS[r.class] ?? r.class}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 tabular-nums">
                        {r.httpStatus ?? ""}
                      </td>
                      <td
                        className="max-w-80 truncate px-3 py-1.5 text-muted-foreground"
                        title={r.error ?? r.finalUrl ?? ""}
                      >
                        {r.error ?? r.finalUrl ?? ""}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-xs text-muted-foreground">
                        {[...r.ga4Ids, ...r.gtmIds].join(", ") || "none"}
                      </td>
                      <td className="px-3 py-1.5 text-xs">
                        {r.onCloudflare ? "yes" : ""}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground">
                        {when(r.checkedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  {text
                    ? `No checked domain matches "${text}".`
                    : filter === "problems"
                      ? d.rows.length
                        ? `Nothing needs attention: all ${d.rows.length} checked domains are live or intentionally redirected.${d.progress.pending ? ` ${d.progress.pending} more are queued.` : ""}`
                        : "No domains checked yet. The first results appear within 5 minutes."
                      : "No domains in this group."}
                </p>
              ) : rows.length > 500 ? (
                <p className="border-t border-border p-3 text-xs text-muted-foreground">
                  Showing the first 500 of {rows.length}. Filter by domain or
                  status to narrow, or download the full list from Reports.
                </p>
              ) : null}
            </div>
            {d.changes.length ? (
              <div>
                <h2 className="mb-2 text-sm font-semibold">Recent changes</h2>
                <ul className="divide-y divide-border rounded-md border border-border text-sm">
                  {dedupeChanges(d.changes).slice(0, 30).map((c, i) => (
                    <li
                      key={i}
                      className="flex flex-col gap-1 px-3 py-1.5 sm:flex-row sm:justify-between sm:gap-3"
                    >
                      <span className="min-w-0 break-words">
                        <span className="font-medium">{c.domain}</span>{" "}
                        <span className="text-muted-foreground">
                          {CHANGE_LABELS[c.kind] ?? c.kind.replace(/_/g, " ")}
                          {c.fromClass || c.toClass
                            ? `: ${HEALTH_LABELS[c.fromClass ?? ""] ?? c.fromClass ?? "new"} to ${HEALTH_LABELS[c.toClass ?? ""] ?? c.toClass}`
                            : ""}
                        </span>
                      </span>
                      <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground sm:text-sm">
                        {when(c.detectedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
