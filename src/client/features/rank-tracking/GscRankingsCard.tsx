// CityThrive fork: free rankings from Search Console (no DataForSEO needed).
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { getProjectGscRankings } from "@/serverFunctions/gscRankings";
import { Button } from "@/client/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/client/components/ui/card";
import { Input } from "@/client/components/ui/input";
import { EmptyState } from "@/client/components/EmptyState";
import { formatRelativeTime } from "@/client/lib/relative-time";

type SortKey = "impressions" | "clicks" | "position" | "change";

const BUCKETS: Array<[string, (p: number) => boolean]> = [
  ["Top 3", (p) => p <= 3],
  ["4 to 10", (p) => p > 3 && p <= 10],
  ["11 to 20", (p) => p > 10 && p <= 20],
  ["21 to 50", (p) => p > 20 && p <= 50],
  ["51+", (p) => p > 50],
];

export function GscRankingsCard({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("impressions");
  const [refreshing, setRefreshing] = useState(false);
  const q = useQuery({
    queryKey: ["gscRankings", projectId],
    queryFn: () => getProjectGscRankings({ data: { projectId } }),
    staleTime: 10 * 60_000,
  });
  const data = q.data;
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = (data?.rows ?? []).filter((r) => !f || r.query.includes(f));
    const change = (r: { position: number; prevPosition: number | null }) =>
      r.prevPosition == null ? -Infinity : r.prevPosition - r.position;
    return [...list].sort((a, b) =>
      sort === "position"
        ? a.position - b.position
        : sort === "change"
          ? change(b) - change(a)
          : b[sort] - a[sort],
    );
  }, [data, filter, sort]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await getProjectGscRankings({
        data: { projectId, refresh: true },
      });
      qc.setQueryData(["gscRankings", projectId], fresh);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Search Console rankings (free)</CardTitle>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            <RefreshCw
              className={`size-4 ${refreshing ? "animate-spin" : ""}`}
            />{" "}
            Refresh
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Average Google position per query from Search Console, last 28 days vs
          the 28 days before. SERP checks for keywords you choose (exact
          position, device, location) need a DataForSEO or Semrush key.
        </p>
        {q.isLoading && <p>Loading Search Console data...</p>}
        {data && !data.connected && (
          <p>Search Console is not connected for this project.</p>
        )}
        {data?.error && data.connected && (
          <p className="text-destructive">Search Console error: {data.error}</p>
        )}
        {data?.connected && !data.error ? (
          <p className="text-xs text-muted-foreground">
            Updated{" "}
            <time
              dateTime={data.fetchedAt}
              title={new Date(data.fetchedAt).toLocaleString()}
            >
              {formatRelativeTime(data.fetchedAt)}
            </time>
          </p>
        ) : null}
        {data && data.rows.length > 0 && (
          <>
            <div className="flex flex-wrap gap-2">
              {BUCKETS.map(([label, fn]) => (
                <div key={label} className="rounded border px-3 py-1">
                  <span className="text-muted-foreground">{label}: </span>
                  <span className="font-semibold">
                    {data.rows.filter((r) => fn(r.position)).length}
                  </span>
                </div>
              ))}
              <div className="rounded border px-3 py-1 text-muted-foreground">
                {data.window?.curStart} to {data.window?.end}
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                placeholder="Filter queries"
                aria-label="Filter queries"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="w-full sm:max-w-xs"
              />
              <select
                aria-label="Sort queries"
                className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:w-auto"
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
              >
                <option value="impressions">Sort by impressions</option>
                <option value="clicks">Sort by clicks</option>
                <option value="position">Sort by position</option>
                <option value="change">Sort by biggest gain</option>
              </select>
            </div>
            {rows.length === 0 ? (
              <EmptyState
                kind="filtered"
                variant="plain"
                title="No queries match this filter"
                description="Try a different query or clear the filter to see all rankings."
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setFilter("")}
                  >
                    Clear filter
                  </Button>
                }
              />
            ) : (
              <div
                className="max-h-[420px] overflow-auto rounded-md border border-border outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                tabIndex={0}
                role="region"
                aria-label="Search Console rankings by query"
              >
                <table className="w-full min-w-[520px] text-left">
                  <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="px-3 py-2 font-medium">Query</th>
                      <th className="px-3 py-2 text-right font-medium">
                        Position
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Change
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Clicks
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Impressions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 300).map((r) => {
                      const delta =
                        r.prevPosition == null
                          ? null
                          : r.prevPosition - r.position;
                      return (
                        <tr
                          key={r.query}
                          className="border-b border-border last:border-0"
                        >
                          <td className="px-3 py-1.5">{r.query}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {r.position.toFixed(1)}
                          </td>
                          <td
                            className={
                              "px-3 py-1.5 text-right tabular-nums " +
                              (delta == null
                                ? "text-muted-foreground"
                                : delta > 0
                                  ? "text-success"
                                  : delta < 0
                                    ? "text-destructive"
                                    : "")
                            }
                            title={
                              delta == null
                                ? "Not in the top 500 queries of the prior 28 days"
                                : delta > 0
                                  ? "Moved up"
                                  : delta < 0
                                    ? "Moved down"
                                    : "No change"
                            }
                          >
                            {delta == null
                              ? "new"
                              : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {r.clicks.toLocaleString()}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {r.impressions.toLocaleString()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {rows.length > 300 ? (
              <p className="text-xs text-muted-foreground">
                Showing the top 300 of {rows.length} queries for this sort.
                Filter to find others.
              </p>
            ) : null}
          </>
        )}
        {data && data.connected && !data.error && data.rows.length === 0 && (
          <p>No Search Console queries in this window.</p>
        )}
      </CardContent>
    </Card>
  );
}
