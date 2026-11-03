import * as React from "react";

import { useQuery } from "@tanstack/react-query";

import { getFleetInventory } from "@/serverFunctions/portfolio";

import { CardShell } from "@/client/components/CardShell";

import { Globe } from "lucide-react";

import { Button } from "@/client/components/ui/button";

import { QueryError } from "@/client/components/QueryState";

import { Skeleton } from "@/client/components/ui/skeleton";

import { Input } from "@/client/components/ui/input";

import { z } from "zod";

import { Link } from "@tanstack/react-router";

import { TablePagination } from "@/client/components/table/TablePagination";

import {
  type Entry,
  type Inventory,
  labels,
  nf,
  type Provider,
  ProviderCell,
  providers,
  statusLabels,
} from "./FleetProviderCell";

/**
 * The per-site provider table is a few megabytes for a large fleet, so it is
 * fetched only when opened; the dashboard above stays light.
 */
export function FleetProviderInventory({
  total,
  inventory,
}: {
  total: number;
  /** Rows already in hand skip the fetch (exports, tests). */
  inventory?: Inventory;
}) {
  const [open, setOpen] = React.useState(false);
  const query = useQuery({
    queryKey: ["fleetInventory"],
    queryFn: () => getFleetInventory(),
    enabled: open && !inventory,
    staleTime: 5 * 60 * 1000,
  });
  if (inventory) return <InventoryTable inventory={inventory} />;
  if (!open)
    return (
      <CardShell
        title="All websites & provider accounts"
        icon={<Globe className="size-4" />}
      >
        <p className="mb-3 text-sm text-muted-foreground">
          Every active website with the state of its Search Console, GA4 and
          Bing connection: available, failing, awaiting data or not linked.
        </p>
        <Button variant="outline" onClick={() => setOpen(true)}>
          Show {nf.format(total)} websites
        </Button>
      </CardShell>
    );
  if (query.isError)
    return (
      <CardShell
        title="All websites & provider accounts"
        icon={<Globe className="size-4" />}
      >
        <QueryError
          error={query.error}
          fallback="Failed to load the website list"
          onRetry={() => void query.refetch()}
          isRetrying={query.isFetching}
        />
      </CardShell>
    );
  if (!query.data)
    return (
      <CardShell
        title="All websites & provider accounts"
        icon={<Globe className="size-4" />}
      >
        <div aria-busy className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-64" />
        </div>
      </CardShell>
    );
  return <InventoryTable inventory={query.data.inventory} />;
}

function InventoryTable({ inventory }: { inventory: Inventory }) {
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
              setProvider(
                z.enum(["all", "gsc", "ga4", "bing"]).parse(event.target.value),
              );
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
              setStatus(
                z
                  .enum([
                    "all",
                    "available",
                    "error",
                    "missing",
                    "stale",
                    "unlinked",
                  ])
                  .parse(event.target.value),
              );
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
