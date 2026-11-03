import type { getFleetInventory } from "@/serverFunctions/portfolio";

export type Inventory = Awaited<
  ReturnType<typeof getFleetInventory>
>["inventory"];

export type Provider = "gsc" | "ga4" | "bing";

export type Entry = Inventory[number][Provider];

export const providers = ["gsc", "ga4", "bing"] as const;

export const labels = { gsc: "Search Console", ga4: "GA4", bing: "Bing" };

export const statusLabels = {
  available: "Available",
  error: "Unavailable · error",
  missing: "Awaiting data",
  stale: "Stale · excluded",
  unlinked: "Not linked",
};

export const nf = new Intl.NumberFormat();

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

export function ProviderCell({
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
