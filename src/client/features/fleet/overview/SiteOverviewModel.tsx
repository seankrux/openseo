import { buildCsv } from "@/client/lib/csv";
import type { getPortfolioOverview } from "@/serverFunctions/portfolio";
import { type PortfolioOverviewSearch } from "@/types/schemas/portfolio-overview";
export type Row = Awaited<
  ReturnType<typeof getPortfolioOverview>
>["rows"][number];

export type SortKey = NonNullable<PortfolioOverviewSearch["sort"]>;

export type Coverage = NonNullable<PortfolioOverviewSearch["coverage"]>;

export const PAGE_SIZE = 50;

export const COVERAGE_CHIPS: Array<{ key: Coverage; label: string }> = [
  { key: "all", label: "All" },
  { key: "gscYes", label: "GSC ✓" },
  { key: "gscNo", label: "GSC ✗" },
  { key: "ga4Yes", label: "GA4 ✓" },
  { key: "ga4No", label: "GA4 ✗" },
  { key: "ga4Zero", label: "GA4 linked, 0 sessions" },
  { key: "noGoogle", label: "No GSC and no GA4" },
  { key: "noAudit", label: "Never audited" },
  { key: "staleAudit", label: "Audit older than 7 days" },
  { key: "critical", label: "Has critical issues" },
];

export function ga4Zero(r: Row): boolean {
  return !!r.ga4PropertyId && !!r.ga4 && !r.ga4.error && r.ga4.sessions === 0;
}

export function matchesCoverage(r: Row, c: Coverage): boolean {
  switch (c) {
    case "all":
      return true;
    case "gscYes":
      return !!r.siteUrl;
    case "gscNo":
      return !r.siteUrl;
    case "ga4Yes":
      return !!r.ga4PropertyId;
    case "ga4No":
      return !r.ga4PropertyId;
    case "ga4Zero":
      return ga4Zero(r);
    case "noGoogle":
      return !r.siteUrl && !r.ga4PropertyId;
    case "noAudit":
      return !r.audit;
    case "staleAudit":
      return isStaleAudit(r);
    case "critical":
      return (r.audit?.critical ?? 0) > 0;
    default: {
      const unreachable: never = c;
      throw new Error("Unknown coverage filter", { cause: unreachable });
    }
  }
}

const STALE_AUDIT_MS = 7 * 86_400_000;

function isStaleAudit(r: Row): boolean {
  if (!r.audit) return true;
  if (r.audit.status === "running") return false;
  const at = r.audit.completedAt ? Date.parse(r.audit.completedAt) : NaN;
  return !(Date.now() - at <= STALE_AUDIT_MS);
}

export function staleCell(m: { stale?: true; fetchedAt: string } | null) {
  return m?.stale
    ? {
        className: "px-2 text-muted-foreground",
        title: `From ${m.fetchedAt.slice(0, 10)}; refreshing`,
      }
    : { className: "px-2" };
}

export function login(email: string | null | undefined): string {
  return email ? email.split("@")[0] : "";
}

export function exportCsv(rows: Row[], filename: string) {
  const head = [
    "domain",
    "name",
    "projectId",
    "gsc_linked",
    "gsc_property",
    "gsc_login",
    "ga4_linked",
    "ga4_property",
    "ga4_login",
    "clicks_28d",
    "clicks_prev28d",
    "impressions_28d",
    "impressions_prev28d",
    "avg_position",
    "ga4_sessions_28d",
    "ga4_sessions_prev28d",
    "ga4_users_28d",
    "ga4_zero_sessions",
    "gsc_error",
    "ga4_error",
    "gsc_fetched_at",
    "ga4_fetched_at",
    "audit_status",
    "audit_completed_at",
    "audit_pages",
    "audit_critical",
    "audit_warning",
  ];
  const records = rows.map((r) => {
    const g = r.gsc;
    const a = r.ga4;
    return [
      r.domain,
      r.name,
      r.projectId,
      r.siteUrl ? "yes" : "no",
      r.siteUrl,
      r.gscEmail,
      r.ga4PropertyId ? "yes" : "no",
      r.ga4PropertyId,
      r.ga4Email,
      g && !g.error ? g.clicks : "",
      g && !g.error ? g.prevClicks : "",
      g && !g.error ? g.impressions : "",
      g && !g.error ? g.prevImpressions : "",
      g?.position != null ? g.position.toFixed(2) : "",
      a && !a.error ? a.sessions : "",
      a && !a.error ? a.prevSessions : "",
      a && !a.error ? a.activeUsers : "",
      ga4Zero(r) ? "yes" : "",
      g?.error ?? "",
      a?.error ?? "",
      g?.fetchedAt ?? "",
      a?.fetchedAt ?? "",
      r.audit?.status,
      r.audit?.completedAt,
      r.audit?.pagesCrawled,
      r.audit?.critical,
      r.audit?.warning,
    ];
  });
  const blob = new Blob([buildCsv(head, records)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const el = document.createElement("a");
  el.href = url;
  el.download = filename;
  el.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function pct(cur: number, prev: number): number | null {
  if (prev === 0) return cur === 0 ? 0 : null;
  return ((cur - prev) / prev) * 100;
}

export function value(row: Row, key: SortKey): number | string | null {
  const g = row.gsc && !row.gsc.error ? row.gsc : null;
  const a = row.ga4 && !row.ga4.error ? row.ga4 : null;
  switch (key) {
    case "name":
      return (row.domain ?? row.name).toLowerCase();
    case "clicks":
      return g ? g.clicks : null;
    case "clicksDelta":
      return g ? g.clicks - g.prevClicks : null;
    case "impressions":
      return g ? g.impressions : null;
    case "impressionsDelta":
      return g ? g.impressions - g.prevImpressions : null;
    case "position":
      return g?.position ?? null;
    case "positionDelta":
      return g?.position != null && g.prevPosition != null
        ? g.prevPosition - g.position
        : null;
    case "sessions":
      return a ? a.sessions : null;
    case "sessionsDelta":
      return a ? a.sessions - a.prevSessions : null;
    case "users":
      return a ? a.activeUsers : null;
    case "critical":
      return row.audit ? row.audit.critical : null;
    case "lastAudit":
      return row.audit?.completedAt ?? null;
    case "lighthouseSeo":
      return row.audit?.lighthouseSeo ?? null;
    default: {
      const unreachable: never = key;
      throw new Error("Unknown sort key", { cause: unreachable });
    }
  }
}

export function Delta({
  v,
  suffix = "",
  invert = false,
}: {
  v: number | null;
  suffix?: string;
  invert?: boolean;
}) {
  if (v == null) return <span className="text-muted-foreground">–</span>;
  const good = invert ? v < 0 : v > 0;
  const cls =
    v === 0
      ? "text-muted-foreground"
      : good
        ? "text-success"
        : "text-destructive";
  return (
    <span className={cls}>
      {v > 0 ? "+" : ""}
      {Math.abs(v) < 10 && v % 1 !== 0
        ? v.toFixed(1)
        : Math.round(v).toLocaleString()}
      {suffix}
    </span>
  );
}
