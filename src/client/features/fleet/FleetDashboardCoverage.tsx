import { CardShell } from "@/client/components/CardShell";
import { ArrowDownRight, ArrowUpRight, Globe, Search } from "lucide-react";
import type { Fleet } from "./FleetDashboardParts";
import { Coverage, fmt, MoversList, shortDay } from "./FleetDashboardParts";
import { FleetProviderInventory } from "./FleetProviderInventory";
export function FleetDashboardCoverage({ d }: { d: Fleet }) {
  return (
    <>
      <CardShell
        title="Bing Webmaster · separate reporting scope"
        icon={<Search className="size-4" />}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">Clicks</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {d.bing.clicks === null ? "Unavailable" : fmt(d.bing.clicks)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Impressions</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {d.bing.impressions === null
                ? "Unavailable"
                : fmt(d.bing.impressions)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">
              Current stored snapshots
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {fmt(d.bing.sites)} / {fmt(d.coverage.bingLinked)}
            </p>
          </div>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          Combined Bing surfaces, using provider-returned dates
          {d.bing.startDate && d.bing.endDate
            ? ` (${shortDay(d.bing.startDate)} to ${shortDay(d.bing.endDate)})`
            : " (no dated performance available)"}
          . Not a matched 28-day window and not added to Search Console totals.
        </p>
        {d.bing.limitations.map((limitation) => (
          <p key={limitation} className="mt-1 text-xs text-muted-foreground">
            {limitation}
          </p>
        ))}
      </CardShell>
      <FleetProviderInventory total={d.coverage.projects} />
      <div className="grid gap-5 lg:grid-cols-3">
        <CardShell
          title="Top gaining sites"
          icon={<ArrowUpRight className="size-4 text-success" />}
        >
          <MoversList rows={d.gainers} kind="up" available={d.gsc.sites > 0} />
        </CardShell>
        <CardShell
          title="Top losing sites"
          icon={<ArrowDownRight className="size-4 text-destructive" />}
        >
          <MoversList rows={d.losers} kind="down" available={d.gsc.sites > 0} />
        </CardShell>
        <CardShell title="Coverage" icon={<Globe className="size-4" />}>
          <div className="space-y-4">
            <Coverage
              label="Search Console linked"
              n={d.coverage.gscLinked}
              of={d.coverage.projects}
              hint={`${fmt(d.coverage.gscCached)} with current metrics included`}
            />
            <Coverage
              label="GA4 linked"
              n={d.coverage.ga4Linked}
              of={d.coverage.projects}
              hint={`${fmt(d.coverage.ga4Cached)} with current metrics included`}
            />
            <Coverage
              label="Bing linked"
              n={d.coverage.bingLinked}
              of={d.coverage.projects}
              hint={`${fmt(d.coverage.bingCached)} current snapshots`}
            />
            <Coverage
              label="Audited"
              n={d.coverage.audited}
              of={d.coverage.projects}
            />
            <p className="text-xs text-muted-foreground">
              {fmt(d.coverage.neither)} sites have no linked GSC, GA4 or Bing
              provider.
            </p>
          </div>
        </CardShell>
      </div>
    </>
  );
}
