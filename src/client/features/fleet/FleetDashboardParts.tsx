import type { getFleetDashboard } from "@/serverFunctions/portfolio";

import { ArrowUpRight } from "lucide-react";

import { ArrowDownRight } from "lucide-react";

import * as React from "react";

import { type ChartConfig } from "@/client/components/ui/chart";

import { Link } from "@tanstack/react-router";

export type Fleet = Awaited<ReturnType<typeof getFleetDashboard>>;

const nf = new Intl.NumberFormat();

export const fmt = (n: number) => nf.format(Math.round(n));

export function pct(cur: number, prev: number): number | null {
  if (prev === 0) return cur === 0 ? 0 : null;
  return ((cur - prev) / prev) * 100;
}

export function Delta({
  value,
  invert = false,
  suffix = "%",
}: {
  value: number | null;
  invert?: boolean;
  suffix?: string;
}) {
  if (value === null || !Number.isFinite(value))
    return <span className="text-xs text-muted-foreground">new</span>;
  const good = invert ? value < 0 : value > 0;
  const bad = invert ? value > 0 : value < 0;
  return (
    <span
      className={
        "inline-flex items-center gap-0.5 text-xs font-medium " +
        (good
          ? "text-success"
          : bad
            ? "text-destructive"
            : "text-muted-foreground")
      }
    >
      {value > 0 ? (
        <ArrowUpRight className="size-3" />
      ) : value < 0 ? (
        <ArrowDownRight className="size-3" />
      ) : null}
      {value > 0 ? "+" : ""}
      {Math.abs(value) < 10 ? value.toFixed(1) : Math.round(value)}
      {suffix}
    </span>
  );
}

export function Kpi({
  label,
  value,
  delta,
  sub,
  icon,
}: {
  label: string;
  value: string;
  delta?: React.ReactNode;
  sub?: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
        <span className="text-muted-foreground/70">{icon}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {delta}
      </div>
      {sub ? <p className="mt-1 text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

export const trendConfig = {
  clicks: { label: "Clicks (last 28 days)", color: "var(--color-primary)" },
  prevClicks: {
    label: "Clicks (prior 28 days)",
    color: "var(--color-muted-foreground)",
  },
} satisfies ChartConfig;

export const issuesConfig = {
  count: { label: "Issues", color: "var(--color-primary)" },
} satisfies ChartConfig;

export const PROVIDER_LABELS = {
  gsc: "Search Console",
  ga4: "GA4",
  bing: "Bing Webmaster",
} as const;

export const HEALTH_LABELS: Record<string, string> = {
  live_ok: "Live",
  redirect_intended: "Intended redirect",
  dns_fail: "DNS failure",
  http_error: "Non-200 status",
  ssl_error: "SSL error",
  timeout: "Timed out",
  cf_error: "Cloudflare error",
  parked: "Parked page",
  redirect_other_domain: "Redirects to another domain",
};

export function shortDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function when(iso: string | null) {
  if (!iso) return "never";
  const t = Date.parse(
    /^\d{4}-\d{2}-\d{2} /.test(iso) ? `${iso.replace(" ", "T")}Z` : iso,
  );
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function SiteLink({
  projectId,
  domain,
}: {
  projectId: string | null;
  domain: string;
}) {
  if (!projectId) return <span className="truncate">{domain}</span>;
  return (
    <Link
      to="/p/$projectId"
      params={{ projectId }}
      search={{}}
      className="truncate font-medium text-foreground hover:underline"
    >
      {domain}
    </Link>
  );
}

export function MoversList({
  rows,
  kind,
  available,
}: {
  rows: Fleet["gainers"];
  kind: "up" | "down";
  available: boolean;
}) {
  if (!available)
    return (
      <p className="text-sm text-muted-foreground">
        Unavailable · no current GSC metrics.
      </p>
    );
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No sites moved {kind === "up" ? "up" : "down"} yet.
      </p>
    );
  return (
    <ul className="divide-y divide-border text-sm">
      {rows.map((r) => (
        <li
          key={r.projectId}
          className="flex items-center justify-between gap-3 py-2"
        >
          <SiteLink projectId={r.projectId} domain={r.domain} />
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {fmt(r.prevClicks)} to {fmt(r.clicks)}{" "}
            <span
              className={
                kind === "up"
                  ? "font-medium text-success"
                  : "font-medium text-destructive"
              }
            >
              ({r.delta > 0 ? "+" : ""}
              {fmt(r.delta)})
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Coverage({
  label,
  n,
  of,
  hint,
}: {
  label: string;
  n: number;
  of: number;
  hint?: string;
}) {
  const p = of > 0 ? Math.round((n / of) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {fmt(n)} of {fmt(of)} ({p}%)
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${p}%` }}
        />
      </div>
      {hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
