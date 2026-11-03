import { z } from "zod";
import { fleetDashboardSchema } from "./FleetDashboardTypes";
import { windows } from "./PortfolioService";

import { hasBingWorkspaceAccess } from "@/server/features/bing/BingWorkspaceAccess";

import { getCached } from "@/server/lib/r2-cache";

import { setCached } from "@/server/lib/r2-cache";

import { type PortfolioRow } from "./PortfolioService";

import { getAuditSummaries } from "./PortfolioService";

import { type PortfolioGsc } from "./PortfolioService";

import { type PortfolioGa4 } from "./PortfolioService";

import { db } from "@/db";

import { projects } from "@/db/schema";

import { isNull } from "drizzle-orm";

import { type FleetDashboard } from "./FleetDashboardTypes";

import { healthRollup } from "./FleetDashboardRollups";

import {
  ageMs,
  SNAPSHOT_MAX_AGE_MS,
  SNAPSHOT_TTL_SECONDS,
  snapshotKey,
  WARM_BUDGET_DEFAULT,
} from "./FleetDashboardEvidence";

import { buildFleetDashboard } from "./FleetDashboardBuild";

import { warmFleetCaches } from "./FleetDashboardWarm";

function isFreshDashboard(
  snapshot: FleetDashboard | null,
  organizationId: string,
): snapshot is FleetDashboard {
  const w = windows();
  return (
    !!snapshot &&
    Array.isArray(snapshot.inventory) &&
    Array.isArray(snapshot.providerIssues) &&
    ageMs(snapshot.generatedAt) >= 0 &&
    ageMs(snapshot.generatedAt) < SNAPSHOT_MAX_AGE_MS &&
    snapshot.windows?.curStart === w.curStart &&
    snapshot.windows?.end === w.end &&
    (hasBingWorkspaceAccess(organizationId) ||
      snapshot.coverage?.bingLinked === 0)
  );
}

/**
 * Page read: the cached snapshot, or a fresh cache-only build on a miss. The
 * domain health panel is one cheap DB read, so it is always live; otherwise it
 * could disagree with the Domain health page for up to 30 minutes.
 */
export async function getFleetDashboard(
  organizationId: string,
  refresh = false,
) {
  if (!refresh) {
    const cached =
      fleetDashboardSchema.safeParse(
        await getCached(snapshotKey(organizationId)),
      ).data ?? null;
    if (isFreshDashboard(cached, organizationId))
      return { ...cached, health: await healthRollup(organizationId) };
  }
  const fresh = await buildFleetDashboard(organizationId);
  await setCached(snapshotKey(organizationId), fresh, SNAPSHOT_TTL_SECONDS);
  return fresh;
}

/**
 * Site table rows, read from the fleet snapshot: one cache object instead of
 * one cache read per site per provider (3,000+ on this fleet, which queued
 * behind the local R2 emulation and stalled every other request). Audit
 * summaries are a database read. Numbers lag the caches by up to one snapshot
 * rebuild (30 minutes).
 */
export async function getPortfolioOverview(organizationId: string): Promise<{
  rows: PortfolioRow[];
  /** Provider connections with no usable snapshot entry yet (GSC plus GA4). */
  pending: number;
  pendingGsc: number;
  pendingGa4: number;
  /** Connections showing earlier numbers while a refresh is due. */
  refreshingGsc: number;
  refreshingGa4: number;
  generatedAt: string;
}> {
  const snapshot = await getFleetDashboard(organizationId);
  const auditMap = await getAuditSummaries(
    snapshot.inventory.map((r) => r.projectId),
  );
  const fetchedAt = (entry: { fetchedAt: string | null }) =>
    entry.fetchedAt ?? snapshot.generatedAt;
  let pendingGsc = 0;
  let pendingGa4 = 0;
  let refreshingGsc = 0;
  let refreshingGa4 = 0;
  const rows = snapshot.inventory.map((r): PortfolioRow => {
    let gsc: PortfolioGsc | null = null;
    if (r.gsc.status === "available" && r.gsc.metrics)
      gsc = { ...r.gsc.metrics, fetchedAt: fetchedAt(r.gsc) };
    else if (r.gsc.status === "stale" && r.gsc.metrics) {
      gsc = { ...r.gsc.metrics, fetchedAt: fetchedAt(r.gsc), stale: true };
      refreshingGsc++;
    } else if (r.gsc.status === "error")
      gsc = {
        clicks: 0,
        impressions: 0,
        position: null,
        prevClicks: 0,
        prevImpressions: 0,
        prevPosition: null,
        fetchedAt: fetchedAt(r.gsc),
        error: r.gsc.error ?? "GSC error",
      };
    else if (r.gsc.status !== "unlinked") pendingGsc++;
    let ga4: PortfolioGa4 | null = null;
    if (
      (r.ga4.status === "available" || r.ga4.status === "stale") &&
      r.ga4.metrics
    ) {
      ga4 = {
        sessions: r.ga4.metrics.sessions,
        activeUsers: r.ga4.metrics.users,
        prevSessions: r.ga4.metrics.prevSessions,
        prevActiveUsers: r.ga4.metrics.prevUsers,
        fetchedAt: fetchedAt(r.ga4),
        ...(r.ga4.status === "stale" && { stale: true as const }),
      };
      if (r.ga4.status === "stale") refreshingGa4++;
    } else if (r.ga4.status === "error")
      ga4 = {
        sessions: 0,
        activeUsers: 0,
        prevSessions: 0,
        prevActiveUsers: 0,
        fetchedAt: fetchedAt(r.ga4),
        error: r.ga4.error ?? "GA4 error",
      };
    else if (r.ga4.status !== "unlinked") pendingGa4++;
    return {
      projectId: r.projectId,
      name: r.name,
      domain: r.domain,
      siteUrl: r.gsc.property,
      gscEmail: r.gsc.email,
      gsc,
      ga4PropertyId: r.ga4.property,
      ga4Email: r.ga4.email,
      ga4,
      audit: auditMap.get(r.projectId) ?? null,
    };
  });
  return {
    rows,
    pending: pendingGsc + pendingGa4,
    pendingGsc,
    pendingGa4,
    refreshingGsc,
    refreshingGa4,
    generatedAt: snapshot.generatedAt,
  };
}

/**
 * Scheduler hook (every 5 minutes). One organization per turn, round-robin,
 * prevents many workspaces from multiplying the self-hosted request deadline.
 * Each warm turn has a persistent project/provider cursor, a 90-call ceiling
 * (Bing costs two calls), three workers and a 100s awaiting deadline. Coverage
 * is intentionally honest while a large/cold fleet gradually fills in.
 */
const WARM_EVERY_MS = 9.5 * 60 * 1000;

const WARM_BUDGET = WARM_BUDGET_DEFAULT;

// Skip a tick while the previous one is still running (same isolate).
let scheduledStartedAt = 0;

export async function runScheduledFleetDashboard() {
  if (scheduledStartedAt && Date.now() - scheduledStartedAt < 20 * 60 * 1000)
    return;
  scheduledStartedAt = Date.now();
  try {
    await runScheduledFleetDashboardOnce();
  } finally {
    scheduledStartedAt = 0;
  }
}

async function runScheduledFleetDashboardOnce() {
  const orgs = await db
    .selectDistinct({ organizationId: projects.organizationId })
    .from(projects)
    .where(isNull(projects.archivedAt))
    .orderBy(projects.organizationId);
  if (!orgs.length) return;
  const orgCursorKey = "fleet-scheduler-cursor:v1";
  const cursor = await getCached(orgCursorKey);
  const selected =
    orgs.find((o) => typeof cursor !== "string" || o.organizationId > cursor) ??
    orgs[0];
  await setCached(orgCursorKey, selected.organizationId, 7 * 24 * 3600);
  const { organizationId } = selected;
  const guardKey = `fleet-warm:v2:${organizationId}`;
  const guard = z
    .object({ at: z.string() })
    .safeParse(await getCached(guardKey)).data;
  if (!guard || ageMs(guard.at) > WARM_EVERY_MS) {
    await setCached(guardKey, { at: new Date().toISOString() }, 24 * 3600);
    const warm = await warmFleetCaches(organizationId, WARM_BUDGET);
    console.log("[fleet] warmed caches", { organizationId, ...warm });
  }
  const snap =
    fleetDashboardSchema.safeParse(await getCached(snapshotKey(organizationId)))
      .data ?? null;
  if (isFreshDashboard(snap, organizationId)) return;
  const fresh = await buildFleetDashboard(organizationId);
  await setCached(snapshotKey(organizationId), fresh, SNAPSHOT_TTL_SECONDS);
}

export { buildFleetDashboard } from "./FleetDashboardBuild";

export { warmFleetCaches } from "./FleetDashboardWarm";
