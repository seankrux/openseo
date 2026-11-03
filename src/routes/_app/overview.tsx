import { PageHeader } from "@/client/components/PageHeader";
import { Button } from "@/client/components/ui/button";
import { SiteOverviewControls } from "@/client/features/fleet/overview/SiteOverviewControls";
import { SiteOverviewTable } from "@/client/features/fleet/overview/SiteOverviewTable";
import { useSiteOverview } from "@/client/features/fleet/overview/useSiteOverview";
import {
  fleetChartsLabel,
  fleetSiteTableLabel,
} from "@/client/navigation/fleetNav";
import { portfolioOverviewSearchSchema } from "@/types/schemas/portfolio-overview";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
export const Route = createFileRoute("/_app/overview")({
  validateSearch: portfolioOverviewSearchSchema,
  component: OverviewPage,
});
function OverviewPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const model = useSiteOverview(search, (update, replace) => {
    void navigate({
      search: (prev) => ({ ...prev, ...update }),
      replace,
      resetScroll: false,
    });
  });
  const { query, refresh, data } = model;
  return (
    <div className="h-full overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <PageHeader
          title={fleetSiteTableLabel}
          description="Search Console last 28 days vs the previous 28 days (ending 3 days ago), GA4 sessions/users (all channels, last 28 days ending yesterday vs previous 28), plus the latest site audit. GSC and GA4 data are cached for 12 hours."
          actions={
            <>
              <Button
                variant="outline"
                nativeButton={false}
                render={<Link to="/dashboard" />}
              >
                {fleetChartsLabel}
              </Button>
              <Button
                variant="outline"
                disabled={refresh.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Clear the cached Search Console and GA4 numbers for ${(data?.rows.length ?? 0).toLocaleString()} sites? They refill in the background, about 90 sites every 10 minutes, and this table shows them on its next rebuild. The full fleet takes a few hours.`,
                    )
                  )
                    refresh.mutate();
                }}
              >
                {refresh.isPending ? "Clearing…" : "Refresh GSC/GA4 data"}
              </Button>
            </>
          }
        />
        {query.isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 text-sm text-destructive"
          >
            <p>Failed to load overview.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              {query.isFetching ? "Retrying…" : "Retry"}
            </Button>
          </div>
        ) : null}
        {!data ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading overview…
          </p>
        ) : (
          <>
            <SiteOverviewControls model={model} />
            <SiteOverviewTable model={model} />
            <p className="text-xs text-muted-foreground">
              Δ pos. is positive when ranking improved.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
