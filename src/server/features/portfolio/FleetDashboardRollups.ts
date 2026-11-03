import { sort as sortArray } from "remeda";
import { z } from "zod";

import { db } from "@/db";

import { audits } from "@/db/schema";

import { sql } from "drizzle-orm";

import { auditIssues } from "@/db/schema";

import { inArray } from "drizzle-orm";

import { domainHealthCurrent } from "@/db/schema";

import { eq } from "drizzle-orm";

import {
  type FleetDashboard,
  type FleetDownDomain,
  type FleetInventoryRow,
  type FleetProviderIssue,
} from "./FleetDashboardTypes";

/** The most common failures per provider; one expired grant explains a fleet. */
export function providerIssues(
  inventory: FleetInventoryRow[],
): FleetProviderIssue[] {
  const out: FleetProviderIssue[] = [];
  for (const provider of ["gsc", "ga4", "bing"] as const) {
    const byError = new Map<string, { sites: number; projectId: string }>();
    for (const row of inventory) {
      const entry = row[provider];
      if (entry.status !== "error" || !entry.error) continue;
      const found = byError.get(entry.error);
      if (found) found.sites++;
      else byError.set(entry.error, { sites: 1, projectId: row.projectId });
    }
    out.push(
      ...sortArray([...byError.entries()], (a, b) => b[1].sites - a[1].sites)
        .slice(0, 3)
        .map(([error, v]) => ({ provider, error, ...v })),
    );
  }
  return sortArray(out, (a, b) => b.sites - a.sites);
}

export async function auditRollup(
  projectIds: Set<string>,
  domains: Map<string, string>,
) {
  const latest = await db
    .select({
      id: audits.id,
      projectId: audits.projectId,
      status: audits.status,
      completedAt: audits.completedAt,
    })
    .from(audits)
    .where(
      sql`${audits.startedAt} = (select max(a2.started_at) from audits a2 where a2.project_id = ${audits.projectId})`,
    );
  const mine = latest.filter((a) => projectIds.has(a.projectId));
  const byAudit = new Map(mine.map((a) => [a.id, a]));
  const ids = [...byAudit.keys()];
  const types = new Map<
    string,
    { type: string; severity: string; count: number; sites: number }
  >();
  const critical = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await db
      .select({
        auditId: auditIssues.auditId,
        type: auditIssues.issueType,
        severity: auditIssues.severity,
        n: sql<number>`count(*)`,
      })
      .from(auditIssues)
      .where(inArray(auditIssues.auditId, chunk))
      .groupBy(
        auditIssues.auditId,
        auditIssues.issueType,
        auditIssues.severity,
      );
    for (const r of rows) {
      const k = `${r.type}|${r.severity}`;
      const t = types.get(k) ?? {
        type: r.type,
        severity: r.severity,
        count: 0,
        sites: 0,
      };
      t.count += Number(r.n);
      t.sites += 1;
      types.set(k, t);
      if (r.severity === "critical") {
        const pid = byAudit.get(r.auditId)!.projectId;
        critical.set(pid, (critical.get(pid) ?? 0) + Number(r.n));
      }
    }
  }
  const sevRank: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  let lastAuditAt: string | null = null;
  for (const a of mine)
    if (a.completedAt && (!lastAuditAt || a.completedAt > lastAuditAt))
      lastAuditAt = a.completedAt;
  return {
    audited: mine.filter((a) => a.status === "completed").length,
    running: mine.filter(
      (a) => String(a.status) === "running" || String(a.status) === "pending",
    ).length,
    withCritical: critical.size,
    lastAuditAt,
    issuesByType: sortArray(
      [...types.values()],
      (a, b) =>
        (sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3) ||
        b.count - a.count,
    ),
    worstSites: sortArray([...critical.entries()], (a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([projectId, n]) => ({
        projectId,
        domain: domains.get(projectId) ?? projectId,
        critical: n,
      })),
  };
}

function parseIds(json: string | null | undefined): string[] {
  try {
    const v: unknown = JSON.parse(json ?? "[]");
    return z.array(z.string()).safeParse(v).data ?? [];
  } catch {
    return [];
  }
}

export async function healthRollup(
  organizationId: string,
): Promise<FleetDashboard["health"]> {
  try {
    const rows = await db
      .select()
      .from(domainHealthCurrent)
      .where(eq(domainHealthCurrent.organizationId, organizationId));
    const byClass: Record<string, number> = {};
    let lastCheckedAt: string | null = null;
    let missingTag = 0;
    const down: FleetDownDomain[] = [];
    for (const r of rows) {
      byClass[r.class] = (byClass[r.class] ?? 0) + 1;
      if (!lastCheckedAt || r.checkedAt > lastCheckedAt)
        lastCheckedAt = r.checkedAt;
      if (
        r.class === "live_ok" &&
        parseIds(r.ga4IdsJson).length === 0 &&
        parseIds(r.gtmIdsJson).length === 0
      )
        missingTag += 1;
      if (r.class !== "live_ok" && r.class !== "redirect_intended")
        down.push({
          projectId: r.projectId ?? null,
          domain: r.domain,
          class: r.class,
          httpStatus: r.httpStatus ?? null,
          finalUrl: r.finalUrl ?? null,
          error: r.error ?? null,
          onCloudflare: Boolean(r.onCloudflare),
          sslDaysRemaining: r.sslDaysRemaining ?? null,
          checkedAt: r.checkedAt,
        });
    }
    down.sort(
      (a, b) =>
        a.class.localeCompare(b.class) || a.domain.localeCompare(b.domain),
    );
    return {
      available: true,
      checked: rows.length,
      lastCheckedAt,
      byClass,
      down,
      missingTag,
    };
  } catch (error) {
    // Table not migrated yet: the panel says so instead of failing the page.
    console.error("[fleet] domain health unavailable", error);
    return {
      available: false,
      checked: 0,
      lastCheckedAt: null,
      byClass: {},
      down: [],
      missingTag: 0,
    };
  }
}
