/**
 * Persistence for fleet domain health. Agent wires this to the shared db
 * client (same pattern as RankTrackingRepository). Methods are sketched so
 * the scheduled runner and MCP tools compile once copied into open-seo.
 */
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  domainHealthChanges,
  domainHealthChecks,
  domainHealthCurrent,
} from "@/db/schema";
import type { DomainHealthClass } from "@/shared/domain-health";
import type { DomainHealthResult } from "@/server/lib/domain-health";
import {
  detectStatusChanges,
  type DetectedChange,
} from "@/server/features/domain-health/services/detectStatusChanges";

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function parseIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export const DomainHealthRepository = {
  async listCurrent(
    organizationId: string,
    opts?: { class?: DomainHealthClass; limit?: number },
  ) {
    const limit = opts?.limit ?? 500;
    const rows = await db
      .select()
      .from(domainHealthCurrent)
      .where(
        opts?.class
          ? and(
              eq(domainHealthCurrent.organizationId, organizationId),
              eq(domainHealthCurrent.class, opts.class),
            )
          : eq(domainHealthCurrent.organizationId, organizationId),
      )
      .orderBy(asc(domainHealthCurrent.domain))
      .limit(limit);
    return rows;
  },

  async getCurrent(organizationId: string, domain: string) {
    const rows = await db
      .select()
      .from(domainHealthCurrent)
      .where(
        and(
          eq(domainHealthCurrent.organizationId, organizationId),
          eq(domainHealthCurrent.domain, domain),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async listChanges(
    organizationId: string,
    opts?: { limit?: number; domain?: string },
  ) {
    const limit = opts?.limit ?? 50;
    return db
      .select()
      .from(domainHealthChanges)
      .where(
        opts?.domain
          ? and(
              eq(domainHealthChanges.organizationId, organizationId),
              eq(domainHealthChanges.domain, opts.domain),
            )
          : eq(domainHealthChanges.organizationId, organizationId),
      )
      .orderBy(desc(domainHealthChanges.detectedAt))
      .limit(limit);
  },

  async listDueProblemDomains(nowIso: string, limit = 200) {
    return db
      .select()
      .from(domainHealthCurrent)
      .where(
        and(
          lte(domainHealthCurrent.nextCheckAt, nowIso),
          inArray(domainHealthCurrent.class, [
            "dns_fail",
            "http_error",
            "ssl_error",
            "timeout",
            "cf_error",
            "parked",
            "blank_page",
          ]),
        ),
      )
      .limit(limit);
  },

  async listAllDomainsForOrg(organizationId: string) {
    return db
      .select({
        domain: domainHealthCurrent.domain,
        projectId: domainHealthCurrent.projectId,
      })
      .from(domainHealthCurrent)
      .where(eq(domainHealthCurrent.organizationId, organizationId));
  },

  /**
   * Upsert current row, append history, insert change-feed events.
   * Returns detected changes for logging / workflow steps.
   */
  async recordCheck(input: {
    organizationId: string;
    projectId?: string | null;
    result: DomainHealthResult;
    trigger: "scheduled_full" | "scheduled_problem" | "recheck" | "manual";
    /** Hours until next problem recheck when not live_ok (default 4). */
    problemRecheckHours?: number;
    /** Hours until next full-pass slot when live_ok (default 24). */
    healthyRecheckHours?: number;
  }): Promise<DetectedChange[]> {
    const { organizationId, result, trigger } = input;
    const prev = await this.getCurrent(organizationId, result.domain);
    const changes = detectStatusChanges(
      prev
        ? {
            class: prev.class as DomainHealthClass,
            sslDaysRemaining: prev.sslDaysRemaining,
            ga4Ids: parseIds(prev.ga4IdsJson),
            gtmIds: parseIds(prev.gtmIdsJson),
          }
        : null,
      {
        class: result.class,
        sslDaysRemaining: result.sslDaysRemaining,
        ga4Ids: result.ga4Ids,
        gtmIds: result.gtmIds,
      },
    );

    const problemHours = input.problemRecheckHours ?? 4;
    const healthyHours = input.healthyRecheckHours ?? 24;
    const hours = result.class === "live_ok" ? healthyHours : problemHours;
    const nextCheckAt = new Date(
      Date.now() + hours * 60 * 60 * 1000,
    ).toISOString();

    const currentId = prev?.id ?? newId("dhc");
    const row = {
      id: currentId,
      organizationId,
      projectId: input.projectId ?? prev?.projectId ?? null,
      domain: result.domain,
      class: result.class,
      httpStatus: result.httpStatus,
      finalUrl: result.finalUrl,
      redirectHops: result.redirectHops,
      redirectedOtherDomain: result.redirectedOtherDomain,
      responseTimeMs: result.responseTimeMs,
      dnsOk: result.dnsOk,
      aRecordsJson: JSON.stringify(result.aRecords),
      aaaaRecordsJson: JSON.stringify(result.aaaaRecords),
      nsRecordsJson: JSON.stringify(result.nsRecords),
      onCloudflare: result.onCloudflare,
      sslValid: result.sslValid,
      sslExpiresAt: result.sslExpiresAt,
      sslDaysRemaining: result.sslDaysRemaining,
      parked: result.parked,
      ga4IdsJson: JSON.stringify(result.ga4Ids),
      gtmIdsJson: JSON.stringify(result.gtmIds),
      error: result.error,
      checkedAt: result.checkedAt,
      nextCheckAt,
      updatedAt: new Date().toISOString(),
    };

    if (prev) {
      await db
        .update(domainHealthCurrent)
        .set(row)
        .where(eq(domainHealthCurrent.id, currentId));
    } else {
      await db.insert(domainHealthCurrent).values({
        ...row,
        createdAt: new Date().toISOString(),
      });
    }

    await db.insert(domainHealthChecks).values({
      id: newId("dhk"),
      organizationId,
      domain: result.domain,
      class: result.class,
      httpStatus: result.httpStatus,
      finalUrl: result.finalUrl,
      sslDaysRemaining: result.sslDaysRemaining,
      onCloudflare: result.onCloudflare,
      ga4IdsJson: JSON.stringify(result.ga4Ids),
      gtmIdsJson: JSON.stringify(result.gtmIds),
      error: result.error,
      trigger,
      checkedAt: result.checkedAt,
    });

    if (changes.length > 0) {
      await db.insert(domainHealthChanges).values(
        changes.map((c) => ({
          id: newId("dhn"),
          organizationId,
          domain: result.domain,
          kind: c.kind,
          fromClass: c.fromClass,
          toClass: c.toClass,
          detailJson: JSON.stringify(c.detail),
          detectedAt: result.checkedAt,
        })),
      );
    }

    return changes;
  },

  async countsByClass(organizationId: string) {
    const rows = await db
      .select({
        class: domainHealthCurrent.class,
        count: sql<number>`count(*)`,
      })
      .from(domainHealthCurrent)
      .where(eq(domainHealthCurrent.organizationId, organizationId))
      .groupBy(domainHealthCurrent.class);
    return rows;
  },
};
