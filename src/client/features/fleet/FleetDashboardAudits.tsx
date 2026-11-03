import { CardShell } from "@/client/components/CardShell";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/client/components/ui/chart";
import { AlertTriangle, Search } from "lucide-react";
import { Bar, BarChart, LabelList, XAxis, YAxis } from "recharts";
import type { Fleet } from "./FleetDashboardParts";
import { fmt, issuesConfig, SiteLink, when } from "./FleetDashboardParts";
export function FleetDashboardAudits({ d }: { d: Fleet }) {
  const issuesChart = d.audit.issuesByType
    .slice(0, 10)
    .map((t) => ({ ...t, label: t.type.replace(/-/g, " ") }));
  return (
    <>
      <div className="grid gap-5 lg:grid-cols-2">
        <CardShell
          title="Top queries · independently cached sample"
          icon={<Search className="size-4" />}
        >
          {d.topQueries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Top queries are collected in the background, a few sites at a
              time. Check back shortly.
            </p>
          ) : (
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                Top {d.topQueries.length} by clicks, from{" "}
                {fmt(d.coverage.queriesCached)} sites with current query caches.
                This sample has separate coverage and must not be used as the
                fleet metric total.
              </p>
              <div
                role="region"
                aria-label="Top search queries"
                tabIndex={0}
                className="w-full min-w-0 overflow-x-auto rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <table className="w-full min-w-[400px] text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3 text-left font-medium">Query</th>
                      <th className="px-2 py-1 text-right font-medium">
                        Clicks
                      </th>
                      <th className="px-2 py-1 text-right font-medium">
                        Impr.
                      </th>
                      <th className="px-2 py-1 text-right font-medium">Pos.</th>
                      <th className="px-2 py-1 text-right font-medium">
                        Sites
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {d.topQueries.map((q) => (
                      <tr key={q.query}>
                        <td
                          className="max-w-64 truncate py-1.5 pr-3"
                          title={q.query}
                        >
                          {q.query}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {fmt(q.clicks)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                          {fmt(q.impressions)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                          {q.position ?? ""}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                          {q.sites}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardShell>

        <CardShell
          title="Audit health"
          icon={<AlertTriangle className="size-4 text-warning" />}
        >
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-2xl font-semibold tabular-nums text-destructive">
                  {fmt(d.audit.withCritical)}
                </div>
                <div className="text-muted-foreground">
                  sites with critical issues
                </div>
              </div>
              <div>
                <div className="text-2xl font-semibold tabular-nums">
                  {fmt(d.audit.audited)}
                </div>
                <div className="text-muted-foreground">
                  sites audited
                  {d.audit.running ? `, ${d.audit.running} running` : ""}
                </div>
              </div>
              <div>
                <div className="text-base font-semibold">
                  {when(d.audit.lastAuditAt)}
                </div>
                <div className="text-muted-foreground">last audit</div>
              </div>
            </div>
            {issuesChart.length ? (
              <ChartContainer
                config={issuesConfig}
                className="h-72 w-full"
                role="group"
                aria-label={`Top audit issue types: ${issuesChart.map((t) => `${t.label} ${t.count}`).join(", ")}`}
              >
                <BarChart
                  data={issuesChart}
                  layout="vertical"
                  margin={{ top: 0, right: 40, bottom: 0, left: 0 }}
                >
                  <XAxis type="number" hide />
                  <YAxis
                    type="category"
                    dataKey="label"
                    width={160}
                    tick={{ fontSize: 12, fill: "var(--foreground)" }}
                    tickLine={false}
                    axisLine={false}
                    interval={0}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="var(--color-count)" radius={3}>
                    <LabelList
                      dataKey="count"
                      position="right"
                      className="fill-muted-foreground"
                      fontSize={11}
                      formatter={(v: unknown) => fmt(Number(v))}
                    />
                  </Bar>
                </BarChart>
              </ChartContainer>
            ) : null}
            {d.audit.worstSites.length ? (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Most critical issues
                </p>
                <ul className="divide-y divide-border text-sm">
                  {d.audit.worstSites.slice(0, 5).map((s) => (
                    <li
                      key={s.projectId}
                      className="flex justify-between gap-3 py-1.5"
                    >
                      <SiteLink projectId={s.projectId} domain={s.domain} />
                      <span className="tabular-nums text-destructive">
                        {fmt(s.critical)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </CardShell>
      </div>
    </>
  );
}
