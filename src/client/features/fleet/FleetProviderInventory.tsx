import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import { CardShell } from "@/client/components/CardShell";
import { Input } from "@/client/components/ui/input";
import { TablePagination } from "@/client/components/table/TablePagination";
import type { getFleetDashboard } from "@/serverFunctions/portfolio";

type Inventory = Awaited<ReturnType<typeof getFleetDashboard>>["inventory"];
type Provider = "gsc" | "ga4" | "bing";
type Entry = Inventory[number][Provider];
const providers = ["gsc", "ga4", "bing"] as const;
const labels = { gsc: "Search Console", ga4: "GA4", bing: "Bing" };
const statusLabels = {
  available: "Available",
  error: "Unavailable · error",
  missing: "Awaiting data",
  stale: "Stale · excluded",
  unlinked: "Not linked",
};
const nf = new Intl.NumberFormat();

function fetchedAt(iso: string | null) {
  if (!iso) return "Not fetched";
  const time = Date.parse(iso);
  return Number.isNaN(time)
    ? "Unknown fetch time"
    : new Date(time).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function ProviderCell({
  entry,
  provider,
}: {
  entry: Entry;
  provider: Provider;
}) {
  let metrics: string | null = null;
  if (entry.status === "available" && entry.metrics) {
    if ("sessions" in entry.metrics) {
      metrics = `${nf.format(entry.metrics.sessions)} sessions · ${nf.format(entry.metrics.users)} users`;
    } else {
      const { clicks, impressions } = entry.metrics;
      metrics =
        clicks !== null && impressions !== null
          ? `${nf.format(clicks)} clicks · ${nf.format(impressions)} impressions`
          : "No dated performance returned";
    }
  }
  return (
    <td className="max-w-72 px-3 py-3 align-top">
      <p
        className={
          entry.status === "error"
            ? "font-medium text-destructive"
            : "font-medium"
        }
      >
        {statusLabels[entry.status]}
      </p>
      {metrics ? <p className="mt-0.5 tabular-nums">{metrics}</p> : null}
      {entry.status === "available" &&
      entry.metrics &&
      "startDate" in entry.metrics ? (
        <p className="mt-0.5 text-xs text-muted-foreground">
          Provider dates: {entry.metrics.startDate ?? "unknown"} to{" "}
          {entry.metrics.endDate ?? "unknown"}
        </p>
      ) : null}
      {entry.property ? (
        <p className="mt-0.5 break-all text-xs text-muted-foreground">
          {entry.property}
        </p>
      ) : null}
      {entry.status !== "unlinked" ? (
        <>
          <p className="mt-0.5 break-all text-xs text-muted-foreground">
            {entry.email ??
              entry.accountId ??
              (provider === "bing"
                ? "Workspace credential"
                : "Account not recorded")}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {fetchedAt(entry.fetchedAt)}
          </p>
        </>
      ) : null}
      {entry.error ? (
        <p className="mt-1 break-words text-xs text-destructive">
          {entry.error}
        </p>
      ) : null}
    </td>
  );
}

export function FleetProviderInventory({
  inventory,
}: {
  inventory: Inventory;
}) {
  const [search, setSearch] = React.useState("");
  const [provider, setProvider] = React.useState<Provider | "all">("all");
  const [status, setStatus] = React.useState<Entry["status"] | "all">("all");
  const [page, setPage] = React.useState(1);
  const pageSize = 25;
  const accounts = React.useMemo(() => {
    const groups = new Map<
      string,
      {
        provider: Provider;
        account: string;
        linked: number;
        available: number;
        error: number;
        missing: number;
        stale: number;
      }
    >();
    for (const row of inventory) {
      for (const key of providers) {
        const entry = row[key];
        if (entry.status === "unlinked") continue;
        // Account identity, not email, determines the group. Never merge grants.
        const identity = entry.accountId ?? entry.email ?? "workspace";
        const groupKey = `${key}:${identity}`;
        let group = groups.get(groupKey);
        if (!group) {
          group = {
            provider: key,
            account:
              entry.email ??
              entry.accountId ??
              (key === "bing"
                ? "Workspace credential"
                : "Legacy account binding"),
            linked: 0,
            available: 0,
            error: 0,
            missing: 0,
            stale: 0,
          };
          groups.set(groupKey, group);
        }
        group.linked++;
        group[entry.status]++;
      }
    }
    return [...groups.entries()];
  }, [inventory]);
  const needle = search.trim().toLowerCase();
  const rows = inventory.filter((row) => {
    const entries =
      provider === "all" ? providers.map((key) => row[key]) : [row[provider]];
    if (status !== "all" && !entries.some((entry) => entry.status === status))
      return false;
    if (!needle) return true;
    return [
      row.name,
      row.domain,
      ...entries.flatMap((entry) => [
        entry.property,
        entry.email,
        entry.accountId,
      ]),
    ].some((value) => value?.toLowerCase().includes(needle));
  });
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(rows.length / pageSize)),
  );
  const visibleRows = rows.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const selectClass =
    "h-10 min-w-0 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <CardShell
      title="All websites & provider accounts"
      icon={<Globe className="size-4" />}
    >
      <p className="mb-4 text-sm text-muted-foreground">
        {nf.format(inventory.length)} active websites, including sites with
        unavailable or unlinked providers. Only available, current data
        contributes to the totals above. Missing, stale and failed data is not
        zero.
      </p>
      <div
        role="region"
        aria-label="Provider account coverage"
        tabIndex={0}
        className="mb-5 overflow-x-auto rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
      >
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-2 pr-3 font-medium">Provider / account</th>
              <th className="px-2 py-2 text-right font-medium">Linked</th>
              <th className="px-2 py-2 text-right font-medium">Available</th>
              <th className="px-2 py-2 text-right font-medium">Errors</th>
              <th className="px-2 py-2 text-right font-medium">
                Awaiting data
              </th>
              <th className="px-2 py-2 text-right font-medium">Stale</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {accounts.map(([key, group]) => (
              <tr key={key}>
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  <span className="font-medium">{labels[group.provider]}</span>
                  <span className="mt-0.5 block break-all text-xs text-muted-foreground">
                    {group.account}
                  </span>
                </th>
                {[
                  group.linked,
                  group.available,
                  group.error,
                  group.missing,
                  group.stale,
                ].map((value, i) => (
                  <td key={i} className="px-2 py-2 text-right tabular-nums">
                    {nf.format(value)}
                  </td>
                ))}
              </tr>
            ))}
            {accounts.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-3 text-muted-foreground">
                  No providers linked.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="mb-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <label className="min-w-0 text-xs font-medium text-muted-foreground">
          Search websites, properties or accounts
          <Input
            type="search"
            className="mt-1"
            value={search}
            placeholder="Domain, property or account email"
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Provider filter
          <select
            className={selectClass}
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value as Provider | "all");
              setPage(1);
            }}
          >
            <option value="all">All providers</option>
            {providers.map((key) => (
              <option key={key} value={key}>
                {labels[key]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Data state
          <select
            className={selectClass}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as Entry["status"] | "all");
              setPage(1);
            }}
          >
            <option value="all">All states</option>
            {Object.entries(statusLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p role="status" className="mb-2 text-xs text-muted-foreground">
        {nf.format(rows.length)} of {nf.format(inventory.length)} websites
        match. Provider and state filters apply to the same connection.
      </p>
      <div
        role="region"
        aria-label="All website provider connections"
        tabIndex={0}
        className="max-h-[36rem] overflow-auto rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
      >
        <table className="w-full min-w-[920px] text-sm">
          <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Website</th>
              {providers.map((key) => (
                <th key={key} className="px-3 py-2 font-medium">
                  {labels[key]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visibleRows.map((row) => (
              <tr key={row.projectId}>
                <th
                  scope="row"
                  className="max-w-56 px-3 py-3 text-left align-top font-medium"
                >
                  <Link
                    to="/p/$projectId"
                    params={{ projectId: row.projectId }}
                    search={{}}
                    className="break-words hover:underline"
                  >
                    {row.domain ?? row.name}
                  </Link>
                </th>
                {providers.map((key) => (
                  <ProviderCell key={key} provider={key} entry={row[key]} />
                ))}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-5 text-muted-foreground">
                  No websites match these filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <TablePagination
        page={currentPage}
        pageSize={pageSize}
        totalCount={rows.length}
        onPageChange={setPage}
      />
    </CardShell>
  );
}
