import {
  getGa4SetupOverview,
  runGa4SetupBulk,
  runGa4SetupSite,
} from "@/serverFunctions/ga4Setup";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { Result } from "./Ga4SetupModel";
import { ATTENTION, PAGE_SIZE } from "./Ga4SetupModel";

export function useGa4Setup(projectId?: string) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["ga4-setup"],
    queryFn: () => getGa4SetupOverview(),
    refetchInterval: 30_000,
  });
  const [results, setResults] = useState<Result[]>([]);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  // "missing": sites with no GA4 property link yet. "attention": sites whose
  // last setup attempt failed, was blocked or is waiting, which used to be
  // visible only as a count.
  const [view, setView] = useState<"missing" | "attention">("missing");
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
  const scopeAttention = states
    .filter((state) => ATTENTION.has(state.status))
    .map((state) => ({ projectId: state.projectId, domain: state.domain }));
  const needle = filter.trim().toLowerCase();
  const missing = (view === "missing" ? scopeMissing : scopeAttention).filter(
    (entry) => entry.domain.toLowerCase().includes(needle),
  );
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(missing.length / PAGE_SIZE)),
  );
  const start = (currentPage - 1) * PAGE_SIZE;
  const visibleRows = missing.slice(start, start + PAGE_SIZE);
  const busy = site.isPending || bulk.isPending;
  const error = site.error ?? bulk.error ?? q.error;

  function changePage(nextPage: number) {
    setPage(nextPage);
    requestAnimationFrame(() => {
      tableRegion.current?.focus();
      tableRegion.current?.scrollIntoView({ block: "start" });
    });
  }

  return {
    qc,
    q,
    results,
    setResults,
    filter,
    setFilter,
    page,
    setPage,
    view,
    setView,
    tableRegion,
    site,
    bulk,
    data,
    states,
    stateBy,
    counts,
    scopeMissing,
    scopeAttention,
    needle,
    missing,
    currentPage,
    start,
    visibleRows,
    busy,
    error,
    changePage,
    projectId,
  };
}
export type Ga4SetupView = ReturnType<typeof useGa4Setup>;
