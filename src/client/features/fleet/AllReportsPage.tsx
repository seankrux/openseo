// CityThrive fork: all-sites exports. Every file is built in the browser from
// data the app already stores (no extra Google or crawler calls).
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Download, LayoutList } from "lucide-react";
import { Button } from "@/client/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/client/components/ui/card";
import { buildCsv, type CsvValue } from "@/client/lib/csv";
import { getDomainHealth } from "@/serverFunctions/domainHealth";
import { getFleetDashboard } from "@/serverFunctions/portfolio";

function download(name: string, headers: string[], rows: CsvValue[][]) {
  const blob = new Blob([buildCsv(headers, rows)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  // Firefox only downloads from an anchor in the document, and revoking the
  // URL in the same tick can cancel the download in Safari and Firefox.
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

type Exporter = {
  key: string;
  title: string;
  description: string;
  run: () => Promise<void>;
};

const EXPORTS: Exporter[] = [
  {
    key: "domain-health",
    title: "Domain health",
    description:
      "Every checked project domain with its latest status, HTTP code, final URL, GA4 and GTM tags. SSL days left is blank where the in-app check cannot read certificates.",
    run: async () => {
      const d = await getDomainHealth();
      download(
        "domain-health",
        [
          "Domain",
          "Status",
          "HTTP",
          "Final URL",
          "Redirect hops",
          "Response ms",
          "Cloudflare",
          "SSL days left",
          "GA4",
          "GTM",
          "Error",
          "Checked",
        ],
        d.rows.map((r) => [
          r.domain,
          r.class,
          r.httpStatus,
          r.finalUrl,
          r.redirectHops,
          r.responseTimeMs,
          r.onCloudflare ? "yes" : "no",
          r.sslDaysRemaining,
          r.ga4Ids.join(" "),
          r.gtmIds.join(" "),
          r.error,
          r.checkedAt,
        ]),
      );
    },
  },
  {
    key: "domain-health-changes",
    title: "Domain status changes",
    description:
      "Recent status changes: sites that went down, came back, lost a tag or have SSL expiring.",
    run: async () => {
      const d = await getDomainHealth();
      download(
        "domain-health-changes",
        ["Domain", "Change", "From", "To", "Detected"],
        d.changes.map((c) => [
          c.domain,
          c.kind,
          c.fromClass,
          c.toClass,
          c.detectedAt,
        ]),
      );
    },
  },
  {
    key: "top-queries",
    title: "Top search queries, all sites",
    description:
      "Up to 1,000 Search Console queries across the fleet by clicks, last 28 days, from each site's top 25 queries.",
    run: async () => {
      const d = await getFleetDashboard({ data: {} });
      const list = d.topQueriesExport ?? d.topQueries;
      download(
        "fleet-top-queries",
        ["Query", "Clicks", "Impressions", "Avg position", "Sites"],
        list.map((q) => [
          q.query,
          q.clicks,
          q.impressions,
          q.position,
          q.sites,
        ]),
      );
    },
  },
  {
    key: "audit-issues",
    title: "Audit issues by type",
    description:
      "Issue counts by type and severity across every site's latest audit.",
    run: async () => {
      const d = await getFleetDashboard({ data: {} });
      download(
        "fleet-audit-issues",
        ["Issue", "Severity", "Count", "Sites"],
        d.audit.issuesByType.map((i) => [i.type, i.severity, i.count, i.sites]),
      );
    },
  },
  {
    key: "critical-sites",
    title: "Sites with the most critical issues",
    description:
      "The 50 sites whose latest audit has the most critical issues.",
    run: async () => {
      const d = await getFleetDashboard({ data: {} });
      download(
        "fleet-most-critical-sites",
        ["Domain", "Critical issues", "Project ID"],
        d.audit.worstSites.map((w) => [w.domain, w.critical, w.projectId]),
      );
    },
  },
];

export function AllReportsPage() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  return (
    <div className="mx-auto max-w-7xl space-y-4 px-4 py-4 md:px-6 md:py-6">
      <div>
        <p className="text-xs font-semibold uppercase text-muted-foreground">
          All sites
        </p>
        <h1 className="text-2xl font-semibold">Reports and CSV export</h1>
        <p className="text-sm text-muted-foreground">
          Fleet wide CSV files built from data OpenSEO already stores.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <p
        role="status"
        aria-atomic="true"
        className={status ? "text-sm text-muted-foreground" : "sr-only"}
      >
        {status}
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>All sites table</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Per site Search Console, GA4 and audit numbers. Export CSV and
              Export all are on the site table, with filters.
            </p>
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link to="/overview" />}
            >
              <LayoutList className="size-4" /> Open site table
            </Button>
          </CardContent>
        </Card>
        {EXPORTS.map((e) => (
          <Card key={e.key}>
            <CardHeader>
              <CardTitle>
                <h2>{e.title}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground">{e.description}</p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                aria-label={
                  busy === e.key
                    ? `Preparing CSV for ${e.title}`
                    : `Download CSV for ${e.title}`
                }
                aria-busy={busy === e.key}
                onClick={() => {
                  setBusy(e.key);
                  setError(null);
                  setStatus(`Preparing ${e.title} CSV...`);
                  e.run()
                    .then(() =>
                      setStatus(
                        `${e.title} CSV is ready. Your browser has started the download.`,
                      ),
                    )
                    .catch((err: unknown) => {
                      setStatus("");
                      setError(
                        err instanceof Error ? err.message : String(err),
                      );
                    })
                    .finally(() => setBusy(null));
                }}
              >
                <Download className="size-4" />{" "}
                {busy === e.key ? "Preparing CSV" : "Download CSV"}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
