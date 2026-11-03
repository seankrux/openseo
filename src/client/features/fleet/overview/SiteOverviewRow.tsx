import { RowActionsMenu } from "@/client/components/RowActionsMenu";
import { DropdownMenuItem } from "@/client/components/ui/dropdown-menu";
import {
  googleCidConverterToolUrl,
  googleMapsSearchUrl,
  googleReviewLinkToolUrl,
  mapsSearchQuery,
} from "@/client/lib/local-operator-links";
import { Link } from "@tanstack/react-router";
import type { Row } from "./SiteOverviewModel";
import { Delta, ga4Zero, login, staleCell } from "./SiteOverviewModel";

import type { SiteOverviewView } from "./useSiteOverview";
export function SiteOverviewRow({
  r,
  accounts,
  blocked,
  reauditOne,
}: { r: Row } & Pick<SiteOverviewView, "accounts" | "blocked" | "reauditOne">) {
  const g = r.gsc;
  const gscCell = staleCell(g);
  const ga4Cell = staleCell(r.ga4);
  const mapsQuery = mapsSearchQuery(r.domain, r.name);
  const mapsUrl = googleMapsSearchUrl(mapsQuery);
  const siteLabel = r.domain ?? r.name;
  return (
    <tr key={r.projectId} className="border-t hover:bg-muted/30">
      <td className="px-2 py-1.5">
        <Link
          to="/p/$projectId"
          params={{ projectId: r.projectId }}
          className="font-medium hover:underline"
        >
          {r.domain ?? r.name}
        </Link>
      </td>
      <td
        className="whitespace-nowrap px-2"
        title={
          r.siteUrl ? `${r.siteUrl} via ${r.gscEmail ?? "?"}` : "Not linked"
        }
      >
        <span
          aria-hidden
          className={r.siteUrl ? "text-success" : "text-destructive"}
        >
          {r.siteUrl ? "✓" : "✗"}
        </span>
        <span className="sr-only">
          {r.siteUrl ? "GSC connected" : "GSC not connected"}
        </span>
        {r.gscEmail && accounts.gsc ? (
          <span className="ml-1 text-xs text-muted-foreground">
            {login(r.gscEmail)}
          </span>
        ) : null}
      </td>
      <td
        className="whitespace-nowrap px-2"
        title={
          r.ga4PropertyId
            ? `${r.ga4PropertyId} via ${r.ga4Email ?? "?"}`
            : "Not linked"
        }
      >
        <span
          aria-hidden
          className={r.ga4PropertyId ? "text-success" : "text-destructive"}
        >
          {r.ga4PropertyId ? "✓" : "✗"}
        </span>
        <span className="sr-only">
          {r.ga4PropertyId ? "GA4 connected" : "GA4 not connected"}
        </span>
        {r.ga4Email && accounts.ga4 ? (
          <span className="ml-1 text-xs text-muted-foreground">
            {login(r.ga4Email)}
          </span>
        ) : null}
        {ga4Zero(r) ? (
          <span
            className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-800"
            title="GA4 is linked with 0 sessions in the cached reporting period."
          >
            0 sess
          </span>
        ) : null}
      </td>
      {!r.siteUrl ? (
        <td colSpan={6} className="px-2 text-muted-foreground">
          Not connected to GSC
        </td>
      ) : !g ? (
        <td colSpan={6} className="px-2 text-muted-foreground">
          {blocked.gsc ? "Unavailable" : "Loading…"}
        </td>
      ) : g.error ? (
        <td colSpan={6} className="px-2 text-red-600" title={g.error}>
          GSC error
        </td>
      ) : (
        <>
          <td {...gscCell}>{g.clicks.toLocaleString()}</td>
          <td {...gscCell}>
            <Delta v={g.clicks - g.prevClicks} />
          </td>
          <td {...gscCell}>{g.impressions.toLocaleString()}</td>
          <td {...gscCell}>
            <Delta v={g.impressions - g.prevImpressions} />
          </td>
          <td {...gscCell}>
            {g.position == null ? "–" : g.position.toFixed(1)}
          </td>
          <td {...gscCell}>
            <Delta
              v={
                g.position != null && g.prevPosition != null
                  ? g.prevPosition - g.position
                  : null
              }
            />
          </td>
        </>
      )}
      {!r.ga4PropertyId ? (
        <td colSpan={3} className="px-2 text-muted-foreground">
          No GA4
        </td>
      ) : !r.ga4 ? (
        <td colSpan={3} className="px-2 text-muted-foreground">
          {blocked.ga4 ? "Unavailable" : "Loading…"}
        </td>
      ) : r.ga4.error ? (
        <td colSpan={3} className="px-2 text-red-600" title={r.ga4.error}>
          GA4 error
        </td>
      ) : (
        <>
          <td {...ga4Cell}>{r.ga4.sessions.toLocaleString()}</td>
          <td {...ga4Cell}>
            <Delta v={r.ga4.sessions - r.ga4.prevSessions} />
          </td>
          <td {...ga4Cell}>{r.ga4.activeUsers.toLocaleString()}</td>
        </>
      )}
      <td className="px-2">
        {r.audit ? (
          <Link
            to="/p/$projectId/audit"
            params={{ projectId: r.projectId }}
            className="hover:underline"
          >
            {r.audit.status === "completed"
              ? `${r.audit.critical} / ${r.audit.warning}`
              : r.audit.status}
          </Link>
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
      </td>
      <td className="whitespace-nowrap px-2 text-xs">
        {r.audit?.completedAt ? r.audit.completedAt.slice(0, 10) : "–"}
      </td>
      <td className="px-2">
        {r.audit?.lighthouseSeo != null
          ? `${r.audit.lighthouseSeo} / ${r.audit.lighthousePerf ?? "–"}`
          : "–"}
      </td>
      <td className="whitespace-nowrap px-2 py-1">
        <RowActionsMenu label={`Actions for ${siteLabel}`}>
          <DropdownMenuItem
            disabled={reauditOne.isPending}
            onClick={() => reauditOne.mutate(r.projectId)}
          >
            Re-audit this site
          </DropdownMenuItem>
          <DropdownMenuItem
            render={
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer" />
            }
          >
            Search on Maps
          </DropdownMenuItem>
          <DropdownMenuItem
            render={
              <a
                href={googleReviewLinkToolUrl()}
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            Review link tool
          </DropdownMenuItem>
          <DropdownMenuItem
            render={
              <a
                href={googleCidConverterToolUrl()}
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            CID converter
          </DropdownMenuItem>
        </RowActionsMenu>
      </td>
    </tr>
  );
}
