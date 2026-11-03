// CityThrive fork: domain health MCP tools (Scanner module, org scoped).
import { DomainHealthRepository } from "@/server/features/domain-health/repositories/DomainHealthRepository";
import {
  applyRedirectAllowlist,
  domainHealthProgress,
  normalizeFleetDomain,
  queueDomainHealthRunNow,
  redirectAllowlist,
  resolveFleetProject,
} from "@/server/features/domain-health/services/domainHealthTick";
import { checkDomainHealth } from "@/server/lib/domain-health";
import { type ToolContext } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import {
  DOMAIN_HEALTH_CLASSES,
  type DomainHealthClass,
} from "@/shared/domain-health";
import { z } from "zod";

const out = z.looseObject({ ...optionalMetaOutputSchema });
const fail = (e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  return mcpResponse({
    text: `Error: ${message}`,
    structuredContent: { ok: false, error: message },
  });
};

export const domainHealthTool = {
  name: "domain_health",
  config: {
    title: "Domain health",
    description:
      "Read-only fleet domain health from the daily scheduled check: counts by class, current rows, and the status-change feed (went down, came back, SSL expiring, GA4/GTM tag removed). Does not trigger checks.",
    inputSchema: {
      domain: z
        .string()
        .min(1)
        .optional()
        .describe("Only this domain's current row and changes."),
      class: z
        .enum(DOMAIN_HEALTH_CLASSES)
        .optional()
        .describe("Filter current rows to this health class."),
      includeChanges: z
        .boolean()
        .optional()
        .describe("Include the recent status-change feed (default true)."),
      limit: z.number().int().min(1).max(500).optional(),
    },
    outputSchema: out,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: async (
    a: {
      domain?: string;
      class?: DomainHealthClass;
      includeChanges?: boolean;
      limit?: number;
    },
    c: ToolContext,
  ) => {
    try {
      const org = c.auth.organizationId;
      const domain = a.domain
        ? (normalizeFleetDomain(a.domain) ?? a.domain.toLowerCase())
        : undefined;
      const counts = await DomainHealthRepository.countsByClass(org);
      const current = domain
        ? [await DomainHealthRepository.getCurrent(org, domain)].filter(
            (r) => r != null,
          )
        : await DomainHealthRepository.listCurrent(org, {
            class: a.class,
            limit: a.limit ?? 100,
          });
      const changes =
        a.includeChanges === false
          ? []
          : await DomainHealthRepository.listChanges(org, {
              domain,
              limit: 50,
            });
      const progress = await domainHealthProgress(org);
      const lines = [
        `Domain health: ${counts.map((x) => `${x.class} ${x.count}`).join(", ") || "no rows yet"}`,
        `Checked ${progress.checked} of ${progress.total} domains, due now ${progress.pending}, last check ${progress.lastCheckedAt ?? "never"}`,
        ...current.map(
          (r) =>
            `  ${r.domain}: ${r.class}${r.httpStatus != null ? ` HTTP ${r.httpStatus}` : ""}${r.sslDaysRemaining != null ? ` SSL ${r.sslDaysRemaining}d` : ""} (${r.checkedAt})`,
        ),
        a.includeChanges === false ? "" : `Recent changes: ${changes.length}`,
      ];
      return mcpResponse({
        text: lines.join("\n"),
        structuredContent: { ok: true, counts, progress, current, changes },
      });
    } catch (e) {
      return fail(e);
    }
  },
};

export const recheckDomainTool = {
  name: "recheck_domain",
  config: {
    title: "Recheck domain health",
    description:
      "Runs an on-demand health check for one domain (DNS, HTTPS status, SSL, redirects, parked page, Cloudflare error, GA4/GTM tag), applies the intended-redirect allowlist. For project domains it stores the result and records status changes; other domains are checked but not stored. Private or internal addresses are never fetched.",
    inputSchema: {
      domain: z
        .string()
        .min(1)
        .describe("Hostname to recheck, for example example.com"),
      projectId: z
        .string()
        .optional()
        .describe(
          "Optional; must be a project in this organization. Defaults to the project that owns the domain.",
        ),
    },
    outputSchema: out,
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: async (
    a: { domain: string; projectId?: string },
    c: ToolContext,
  ) => {
    try {
      const domain = normalizeFleetDomain(a.domain);
      if (!domain) throw new Error(`"${a.domain}" is not a valid domain name.`);
      const owner = await resolveFleetProject(
        c.auth.organizationId,
        domain,
        a.projectId,
      );
      if ("error" in owner) throw new Error(owner.error);
      // Only fleet domains (or an explicit project of this org) are stored, so
      // one-off lookups do not inflate the fleet counts.
      const store = owner.inFleet || owner.projectId !== null;
      const result = applyRedirectAllowlist(
        await checkDomainHealth(domain, { timeoutMs: 10_000 }),
        await redirectAllowlist(),
      );
      const changes = store
        ? await DomainHealthRepository.recordCheck({
            organizationId: c.auth.organizationId,
            projectId: owner.projectId,
            result,
            trigger: "recheck",
          })
        : [];
      const lines = [
        `Rechecked ${result.domain}: ${result.class}`,
        result.httpStatus != null ? `HTTP ${result.httpStatus}` : null,
        result.finalUrl ? `Final URL: ${result.finalUrl}` : null,
        result.ga4Ids.length ? `GA4: ${result.ga4Ids.join(", ")}` : "GA4: none",
        result.gtmIds.length ? `GTM: ${result.gtmIds.join(", ")}` : "GTM: none",
        store
          ? changes.length
            ? `Changes: ${changes.map((x) => x.kind).join(", ")}`
            : "No status changes"
          : "Not a project domain: result not stored",
      ].filter(Boolean);
      return mcpResponse({
        text: lines.join("\n"),
        structuredContent: { ok: true, stored: store, result, changes },
      });
    } catch (e) {
      return fail(e);
    }
  },
};

export const runDomainHealthTool = {
  name: "run_domain_health",
  config: {
    title: "Run domain health now",
    description:
      "Queues a fresh domain health pass over every project domain. The scheduler checks about 40 domains every 5 minutes, so a full pass takes a few hours. Set onlyProgress=true to just report progress.",
    inputSchema: { onlyProgress: z.boolean().optional() },
    outputSchema: out,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: async (a: { onlyProgress?: boolean }, c: ToolContext) => {
    try {
      const org = c.auth.organizationId;
      const queued = a.onlyProgress ? null : await queueDomainHealthRunNow(org);
      const progress = await domainHealthProgress(org);
      return mcpResponse({
        text: [
          queued
            ? `Queued ${queued.queued} domains for a fresh check.`
            : "Progress only.",
          `Domains ${progress.total}, checked at least once ${progress.checked}, due now ${progress.pending}, last check ${progress.lastCheckedAt ?? "never"}`,
        ].join("\n"),
        structuredContent: { ok: true, queued, progress },
      });
    } catch (e) {
      return fail(e);
    }
  },
};
