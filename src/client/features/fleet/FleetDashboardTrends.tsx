import { CardShell } from "@/client/components/CardShell";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/client/components/ui/chart";
import { Activity } from "lucide-react";
import { Area, AreaChart, XAxis, YAxis } from "recharts";
import type { Fleet } from "./FleetDashboardParts";
import { Delta, fmt, pct, shortDay, trendConfig } from "./FleetDashboardParts";
export function FleetDashboardTrends({ d }: { d: Fleet }) {
  return (
    <>
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <CardShell title="Search clicks · available sites">
            <p className="mb-3 text-sm text-muted-foreground">
              Daily clicks, current 28 days against the prior 28 days. Based on{" "}
              {fmt(d.dailySites)} of {fmt(d.coverage.gscLinked)} linked Search
              Console sites. This is a partial trend when coverage is
              incomplete.
            </p>
            {d.dailySites === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                No current Search Console trend is available.
              </p>
            ) : (
              <ChartContainer config={trendConfig} className="h-56 w-full">
                <AreaChart
                  data={d.daily}
                  margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
                >
                  <XAxis
                    dataKey="date"
                    tickFormatter={shortDay}
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={32}
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={44}
                    allowDecimals={false}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(l: unknown) =>
                          typeof l === "string" ? shortDay(l) : ""
                        }
                      />
                    }
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Area
                    type="monotone"
                    dataKey="prevClicks"
                    stroke="var(--color-prevClicks)"
                    strokeDasharray="4 4"
                    fill="none"
                    strokeWidth={1.5}
                  />
                  <Area
                    type="monotone"
                    dataKey="clicks"
                    stroke="var(--color-clicks)"
                    fill="var(--color-clicks)"
                    fillOpacity={0.1}
                    strokeWidth={2}
                  />
                </AreaChart>
              </ChartContainer>
            )}
          </CardShell>
        </div>
        <CardShell
          title="GA4 sessions · all channels"
          icon={<Activity className="size-4" />}
        >
          <div className="space-y-3">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums">
                {d.ga4.sites ? fmt(d.ga4.sessions) : "Unavailable"}
              </span>
              {d.ga4.sites ? (
                <Delta value={pct(d.ga4.sessions, d.ga4.prevSessions)} />
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">
              All-channel traffic, not organic-only. Last 28 complete days in
              each property's reporting time zone, from {fmt(d.ga4.sites)} of{" "}
              {fmt(d.coverage.ga4Linked)} linked sites. These dates differ from
              Search Console. Users are summed across properties, not
              deduplicated people.
              {d.ga4.sites
                ? ` Prior period ${fmt(d.ga4.prevSessions)}.`
                : " No current GA4 metrics are available; check the account states below."}
            </p>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">
                  Active users · sum of properties
                </dt>
                <dd className="font-medium tabular-nums">
                  {d.ga4.sites ? fmt(d.ga4.users) : "Unavailable"}{" "}
                  {d.ga4.sites ? (
                    <Delta value={pct(d.ga4.users, d.ga4.prevUsers)} />
                  ) : null}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  Available sites, 0 sessions
                </dt>
                <dd className="font-medium tabular-nums">
                  {d.ga4.sites ? fmt(d.ga4.zeroSessionSites) : "Unavailable"}
                </dd>
              </div>
            </dl>
          </div>
        </CardShell>
      </div>
    </>
  );
}
