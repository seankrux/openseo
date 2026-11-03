import {
  getPortfolioOverview,
  queueFleetReaudit,
  refreshPortfolioOverview,
} from "@/serverFunctions/portfolio";
import { type PortfolioOverviewSearch } from "@/types/schemas/portfolio-overview";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { sort as sortArray } from "remeda";
import type { Coverage, Row } from "./SiteOverviewModel";
import {
  COVERAGE_CHIPS,
  PAGE_SIZE,
  matchesCoverage,
  value,
} from "./SiteOverviewModel";

export function useSiteOverview(
  search: PortfolioOverviewSearch,
  onSearchChange: (
    update: Partial<PortfolioOverviewSearch>,
    replace: boolean,
  ) => void,
) {
  const queryClient = useQueryClient();
  // Rows come from the fleet snapshot, rebuilt by the scheduler every 30
  // minutes, so polling faster than that cannot show anything new.
  const query = useQuery({
    queryKey: ["portfolioOverview"],
    queryFn: () => getPortfolioOverview(),
    refetchInterval: (q) =>
      (q.state.data?.pending ?? 0) > 0 ? 5 * 60_000 : false,
    staleTime: 5 * 60_000,
  });
  const refresh = useMutation({
    mutationFn: () => refreshPortfolioOverview({ data: {} }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["portfolioOverview"] }),
  });
  const reauditOne = useMutation({
    mutationFn: (projectId: string) =>
      queueFleetReaudit({ data: { projectIds: [projectId] } }),
    onSuccess: (status) => queryClient.setQueryData(["fleetReaudit"], status),
  });
  const sortKey = search.sort ?? "clicks";
  const desc = search.order !== "asc";
  const filter = search.filter ?? "";
  const coverage = search.coverage ?? "all";
  const [page, setPage] = React.useState(1);
  const updateSearch = (
    update: Partial<PortfolioOverviewSearch>,
    replace = false,
  ) => {
    setPage(1);
    onSearchChange(update, replace);
  };

  const rows = React.useMemo(() => {
    const all = query.data?.rows ?? [];
    const f = filter.trim().toLowerCase();
    const filtered = all.filter(
      (r) =>
        matchesCoverage(r, coverage) &&
        (!f || `${r.name} ${r.domain ?? ""}`.toLowerCase().includes(f)),
    );
    return sortArray([...filtered], (a, b) => {
      const va = value(a, sortKey);
      const vb = value(b, sortKey);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const c = va < vb ? -1 : va > vb ? 1 : 0;
      return desc ? -c : c;
    });
  }, [query.data, sortKey, desc, filter, coverage]);

  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(rows.length / PAGE_SIZE)),
  );
  const visibleRows = rows.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  const counts = React.useMemo(() => {
    const all = query.data?.rows ?? [];
    const out: Partial<Record<Coverage, number>> = {};
    for (const c of COVERAGE_CHIPS)
      out[c.key] = all.filter((r) => matchesCoverage(r, c.key)).length;
    return out;
  }, [query.data]);

  const totals = React.useMemo(() => {
    let clicks = 0,
      prevClicks = 0,
      impressions = 0,
      prevImpressions = 0;
    let sessions = 0,
      prevSessions = 0;
    let gscSites = 0,
      ga4Sites = 0;
    for (const r of rows) {
      // Earlier numbers shown while refreshing stay out of the totals.
      if (r.ga4 && !r.ga4.error && !r.ga4.stale) {
        ga4Sites++;
        sessions += r.ga4.sessions;
        prevSessions += r.ga4.prevSessions;
      }
      if (!r.gsc || r.gsc.error || r.gsc.stale) continue;
      gscSites++;
      clicks += r.gsc.clicks;
      prevClicks += r.gsc.prevClicks;
      impressions += r.gsc.impressions;
      prevImpressions += r.gsc.prevImpressions;
    }
    return {
      clicks,
      prevClicks,
      impressions,
      prevImpressions,
      sessions,
      prevSessions,
      gscSites,
      ga4Sites,
    };
  }, [rows]);

  // One failed Google grant shows up as the same error on every site. Name it
  // once, with the way to fix it, instead of 1,600 "GA4 error" cells.
  const providerIssues = React.useMemo(() => {
    const all = query.data?.rows ?? [];
    const out: Array<{
      provider: "Search Console" | "GA4";
      error: string;
      sites: number;
      projectId: string;
    }> = [];
    for (const [provider, pick] of [
      ["Search Console", (r: Row) => r.gsc?.error],
      ["GA4", (r: Row) => r.ga4?.error],
    ] as const) {
      const byError = new Map<string, { sites: number; projectId: string }>();
      for (const r of all) {
        const error = pick(r);
        if (!error) continue;
        const found = byError.get(error);
        if (found) found.sites++;
        else byError.set(error, { sites: 1, projectId: r.projectId });
      }
      for (const [error, v] of byError)
        if (v.sites >= 5) out.push({ provider, error, ...v });
    }
    return sortArray(out, (a, b) => b.sites - a.sites);
  }, [query.data]);

  // While a provider is failing fleet-wide, its empty cells are not loading.
  const blocked = {
    gsc: providerIssues.some((i) => i.provider === "Search Console"),
    ga4: providerIssues.some((i) => i.provider === "GA4"),
  };

  // The login beside each check mark only earns its space when the fleet uses
  // more than one account for that provider.
  const accounts = React.useMemo(() => {
    const all = query.data?.rows ?? [];
    return {
      gsc: new Set(all.map((r) => r.gscEmail).filter(Boolean)).size > 1,
      ga4: new Set(all.map((r) => r.ga4Email).filter(Boolean)).size > 1,
    };
  }, [query.data]);

  const data = query.data;

  return {
    queryClient,
    query,
    refresh,
    reauditOne,
    sortKey,
    desc,
    filter,
    coverage,
    page,
    setPage,
    updateSearch,
    rows,
    currentPage,
    visibleRows,
    counts,
    totals,
    providerIssues,
    blocked,
    accounts,
    data,
  };
}
export type SiteOverviewView = ReturnType<typeof useSiteOverview>;
