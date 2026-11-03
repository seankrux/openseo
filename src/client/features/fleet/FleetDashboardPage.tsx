import { useQueryClient } from "@tanstack/react-query";

import { useQuery } from "@tanstack/react-query";

import { getFleetDashboard } from "@/serverFunctions/portfolio";

import { useMutation } from "@tanstack/react-query";

import * as React from "react";

import { ActiveProjectContext } from "@/client/lib/active-project";

import { DashboardScopeTabs } from "./DashboardScopeTabs";

import { fleetChartsLabel } from "@/client/navigation/fleetNav";

import { Button } from "@/client/components/ui/button";

import { Link } from "@tanstack/react-router";

import { Globe } from "lucide-react";

import { fleetSiteTableLabel } from "@/client/navigation/fleetNav";

import { RefreshCw } from "lucide-react";

import { QueryError } from "@/client/components/QueryState";

import { Skeleton } from "@/client/components/ui/skeleton";

import { shortDay, when } from "./FleetDashboardParts";

import { FleetBody } from "./FleetDashboardBody";

export function FleetDashboardPage() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["fleetDashboard"],
    queryFn: () => getFleetDashboard({ data: {} }),
    staleTime: 5 * 60 * 1000,
  });
  const refresh = useMutation({
    mutationFn: () => getFleetDashboard({ data: { refresh: true } }),
    onSuccess: (data) => qc.setQueryData(["fleetDashboard"], data),
  });
  // Share the shell's validated selection, including async fallback/healing.
  const projectId = React.useContext(ActiveProjectContext);
  const d = query.data;

  return (
    <div className="px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        {projectId ? (
          <DashboardScopeTabs current="fleet" projectId={projectId} />
        ) : null}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              All sites
            </p>
            <h1 className="text-2xl font-semibold">{fleetChartsLabel}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {d
                ? `Search Console: last 28 days (${shortDay(d.windows.curStart)} to ${shortDay(d.windows.end)}) vs the prior 28 days. Dashboard updated ${when(d.generatedAt)}.`
                : "Search, traffic, audit and uptime health across every project."}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link to="/overview" />}
            >
              <Globe />
              {fleetSiteTableLabel}
            </Button>
            <Button
              variant="outline"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              <RefreshCw
                className={refresh.isPending ? "animate-spin" : undefined}
              />
              {refresh.isPending ? "Rebuilding..." : "Rebuild"}
            </Button>
          </div>
        </div>

        {refresh.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not rebuild the dashboard. Try Rebuild again.
          </p>
        ) : null}
        {refresh.isSuccess ? (
          <p role="status" className="text-sm text-success">
            Dashboard updated from the latest cached data.
          </p>
        ) : null}

        {query.isError ? (
          <QueryError
            error={query.error}
            fallback="Failed to load the dashboard"
            onRetry={() => void query.refetch()}
            isRetrying={query.isFetching}
          />
        ) : !d ? (
          <div className="flex flex-col gap-5" aria-busy>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-28" />
              ))}
            </div>
            <Skeleton className="h-64" />
          </div>
        ) : (
          <FleetBody d={d} />
        )}
      </div>
    </div>
  );
}
