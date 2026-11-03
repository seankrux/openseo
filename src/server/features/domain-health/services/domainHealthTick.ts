// CityThrive fork: Domain health scheduling inside OpenSEO. The 5-minute
// scheduler tick checks a small chunk of due domains (never-checked first,
// then the oldest), at low concurrency with short timeouts, so a full daily
// pass of ~1,600 sites is spread over a couple of hours and never spikes
// tokyo. Every project domain is in scope (seeded from projects.domain).
// Healthy domains come due again after 24h, problem domains after 4h.
import { db } from "@/db";
import { domainHealthChecks, domainHealthCurrent, projects } from "@/db/schema";
import { DomainHealthRepository } from "@/server/features/domain-health/repositories/DomainHealthRepository";
import type { DomainHealthResult } from "@/server/lib/domain-health";
import { checkDomainHealth } from "@/server/lib/domain-health";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";

const CHUNK_PER_TICK = 40;
const CONCURRENCY = 3;
const TIMEOUT_MS = 10_000;
/** A transient failure is confirmed once, with more patience, before it is recorded. */
const CONFIRM_TIMEOUT_MS = 20_000;

/** A slow or aborted answer; one of these alone is not evidence of an outage. */
function isTransientFailure(result: DomainHealthResult): boolean {
  return (
    result.class === "timeout" ||
    (result.class === "dns_fail" &&
      /timeout|timed out|aborted/i.test(result.error ?? ""))
  );
}

/**
 * Intended cross-domain redirects (Sean: atlanticbeachfoundationrepair.com is
 * meant to land on solidfoundations.com). Extend with
 * DOMAIN_HEALTH_REDIRECT_ALLOWLIST="from.com>to.com,other.com>*".
 */
const BUILTIN_REDIRECT_ALLOWLIST = [
  "atlanticbeachfoundationrepair.com>solidfoundations.com",
];

function bare(host: string) {
  return host
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

export function normalizeFleetDomain(
  input: string | null | undefined,
): string | null {
  if (!input) return null;
  let d = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "");
  d = d.split("/")[0].split("?")[0].replace(/\.$/, "");
  d = d.replace(/^www\./, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

export async function redirectAllowlist(): Promise<Array<[string, string]>> {
  const extra =
    (await getOptionalEnvValue("DOMAIN_HEALTH_REDIRECT_ALLOWLIST")) ?? "";
  return [...BUILTIN_REDIRECT_ALLOWLIST, ...extra.split(",")]
    .map((e) => e.trim())
    .filter((e) => e.includes(">"))
    .map((e) => {
      const [from, to] = e.split(">");
      return [bare(from), bare(to)] as [string, string];
    });
}

/** Reclassify an intended redirect so it does not count as a problem. */
export function applyRedirectAllowlist(
  result: DomainHealthResult,
  allow: Array<[string, string]>,
): DomainHealthResult {
  if (result.class !== "redirect_other_domain" || !result.finalUrl)
    return result;
  let host = "";
  try {
    host = bare(new URL(result.finalUrl).hostname);
  } catch {
    return result;
  }
  const from = bare(result.domain);
  const ok = allow.some(
    ([f, t]) =>
      f === from && (t === "*" || t === host || host.endsWith(`.${t}`)),
  );
  return ok ? { ...result, class: "redirect_intended" } : result;
}

async function fleetDomains(organizationId: string) {
  const rows = await db
    .select({ projectId: projects.id, domain: projects.domain })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
        isNotNull(projects.domain),
      ),
    );
  const out = new Map<string, string>();
  for (const r of rows) {
    const d = normalizeFleetDomain(r.domain);
    if (d && !out.has(d)) out.set(d, r.projectId);
  }
  return out;
}

/**
 * The fleet project for a domain, if any. A caller-supplied projectId is only
 * accepted when it is one of this org's active projects.
 */
export async function resolveFleetProject(
  organizationId: string,
  domain: string,
  projectId?: string | null,
): Promise<{ projectId: string | null; inFleet: boolean } | { error: string }> {
  const fleet = await fleetDomains(organizationId);
  const fleetProject = fleet.get(domain) ?? null;
  if (!projectId)
    return { projectId: fleetProject, inFleet: fleetProject !== null };
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .limit(1);
  if (!row)
    return {
      error: `Project ${projectId} was not found in this organization.`,
    };
  return { projectId: row.id, inFleet: fleetProject !== null };
}

/** Domains due now: never checked first, then by oldest next_check_at. */
async function dueDomains(organizationId: string, limit: number) {
  const fleet = await fleetDomains(organizationId);
  const current = await db
    .select({
      domain: domainHealthCurrent.domain,
      nextCheckAt: domainHealthCurrent.nextCheckAt,
    })
    .from(domainHealthCurrent)
    .where(eq(domainHealthCurrent.organizationId, organizationId));
  const known = new Map(current.map((c) => [c.domain, c.nextCheckAt]));
  const now = new Date().toISOString();
  const never: string[] = [];
  const due: Array<[string, string]> = [];
  for (const d of fleet.keys()) {
    const next = known.get(d);
    if (next === undefined) never.push(d);
    else if (!next || next <= now) due.push([d, next ?? ""]);
  }
  due.sort((a, b) => (a[1] < b[1] ? -1 : 1));
  const picked = [...never, ...due.map((d) => d[0])].slice(0, limit);
  return {
    picked: picked.map((d) => ({ domain: d, projectId: fleet.get(d) ?? null })),
    total: fleet.size,
    pending: never.length + due.length,
  };
}

async function checkAndRecord(
  organizationId: string,
  items: Array<{ domain: string; projectId: string | null }>,
  trigger: "scheduled_full" | "scheduled_problem" | "recheck" | "manual",
) {
  const allow = await redirectAllowlist();
  let cursor = 0;
  let changes = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        try {
          let result = applyRedirectAllowlist(
            await checkDomainHealth(item.domain, {
              timeoutMs: TIMEOUT_MS,
              maxBodyBytes: 150_000,
            }),
            allow,
          );
          // Checker timeouts used to flip healthy sites to "down" and back on
          // the next pass, burying real outages in noise. Confirm first.
          if (isTransientFailure(result)) {
            const again = applyRedirectAllowlist(
              await checkDomainHealth(item.domain, {
                timeoutMs: CONFIRM_TIMEOUT_MS,
                maxBodyBytes: 150_000,
              }),
              allow,
            );
            if (!isTransientFailure(again)) result = again;
          }
          const c = await DomainHealthRepository.recordCheck({
            organizationId,
            projectId: item.projectId,
            result,
            trigger,
          });
          changes += c.length;
        } catch (error) {
          console.error("[domain-health] check failed", item.domain, error);
        }
      }
    }),
  );
  return { checked: items.length, changes };
}

/** Check history older than this is pruned (current rows are kept). */
const HISTORY_RETENTION_DAYS = 90;
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
let lastPruneAt = 0;
// One tick at a time per isolate: a slow tick (40 domains, 10 s timeouts) can
// outlive the 5-minute cron interval, and "Run now" also starts a tick; an
// overlap would check the same due domains twice and log duplicate changes.
// A flag, not a shared promise: workerd forbids awaiting I/O started by another
// request. A flag older than 15 minutes is treated as stale.
const TICK_STALE_MS = 15 * 60 * 1000;
let tickStartedAt = 0;

/** Scheduler hook, every 5 minutes. Skips while another tick is running. */
export async function runDomainHealthTick(): Promise<void> {
  if (tickStartedAt && Date.now() - tickStartedAt < TICK_STALE_MS) return;
  tickStartedAt = Date.now();
  try {
    await runDomainHealthTickOnce();
  } finally {
    tickStartedAt = 0;
  }
}

async function pruneHistory() {
  if (Date.now() - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = Date.now();
  const cutoff = new Date(
    Date.now() - HISTORY_RETENTION_DAYS * 86400_000,
  ).toISOString();
  await db
    .delete(domainHealthChecks)
    .where(lt(domainHealthChecks.checkedAt, cutoff));
}

async function runDomainHealthTickOnce() {
  await pruneHistory().catch((e) =>
    console.error("[domain-health] prune failed", e),
  );
  const orgs = await db
    .selectDistinct({ organizationId: projects.organizationId })
    .from(projects)
    .where(isNull(projects.archivedAt));
  for (const { organizationId } of orgs) {
    const { picked, total, pending } = await dueDomains(
      organizationId,
      CHUNK_PER_TICK,
    );
    if (picked.length === 0) continue;
    const res = await checkAndRecord(organizationId, picked, "scheduled_full");
    console.log("[domain-health] tick", {
      organizationId,
      total,
      pending,
      ...res,
    });
  }
}

/**
 * "Run now": make every domain due immediately; the next ticks work through
 * them at the usual low rate. Returns the number of domains queued.
 */
export async function queueDomainHealthRunNow(organizationId: string) {
  await db
    .update(domainHealthCurrent)
    .set({ nextCheckAt: new Date(0).toISOString() })
    .where(eq(domainHealthCurrent.organizationId, organizationId));
  const fleet = await fleetDomains(organizationId);
  return { queued: fleet.size };
}

export async function domainHealthProgress(organizationId: string) {
  const { total, pending } = await dueDomains(organizationId, 0);
  const [row] = await db
    .select({
      n: sql<number>`count(*)`,
      last: sql<string | null>`max(${domainHealthCurrent.checkedAt})`,
    })
    .from(domainHealthCurrent)
    .where(eq(domainHealthCurrent.organizationId, organizationId));
  return {
    total,
    pending,
    checked: Number(row?.n ?? 0),
    lastCheckedAt: row?.last ?? null,
  };
}
