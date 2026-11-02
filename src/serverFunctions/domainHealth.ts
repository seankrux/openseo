// CityThrive fork: Domain health server functions (page + Run now button).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { waitUntil } from "cloudflare:workers";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import { DomainHealthRepository } from "@/server/features/domain-health/repositories/DomainHealthRepository";
import {
  domainHealthProgress,
  queueDomainHealthRunNow,
  runDomainHealthTick,
} from "@/server/features/domain-health/services/domainHealthTick";

export const getDomainHealth = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) => {
    const [rows, changes, progress] = await Promise.all([
      DomainHealthRepository.listCurrent(context.organizationId, { limit: 5000 }),
      DomainHealthRepository.listChanges(context.organizationId, { limit: 100 }),
      domainHealthProgress(context.organizationId),
    ]);
    return {
      progress,
      rows: rows.map((r) => ({
        domain: r.domain,
        projectId: r.projectId,
        class: r.class,
        httpStatus: r.httpStatus,
        finalUrl: r.finalUrl,
        redirectHops: r.redirectHops,
        responseTimeMs: r.responseTimeMs,
        onCloudflare: r.onCloudflare,
        sslDaysRemaining: r.sslDaysRemaining,
        ga4Ids: safeIds(r.ga4IdsJson),
        gtmIds: safeIds(r.gtmIdsJson),
        error: r.error,
        checkedAt: r.checkedAt,
      })),
      changes: changes.map((c) => ({
        domain: c.domain,
        kind: c.kind,
        fromClass: c.fromClass,
        toClass: c.toClass,
        detectedAt: c.detectedAt,
      })),
    };
  });

export const triggerDomainHealthRun = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(z.object({}).optional())
  .handler(async ({ context }) => {
    const res = await queueDomainHealthRunNow(context.organizationId);
    // Start the first chunk right away; later ticks continue at the usual pace.
    waitUntil(runDomainHealthTick().catch((e) => console.error("[domain-health] run now", e)));
    return res;
  });

function safeIds(json: string | null): string[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
