// CityThrive fork: keeps fleet site audits current. Every audit was run once
// by hand; this re-runs the same audit on sites whose latest one is stale, a
// few per scheduler tick, so 1,600 crawls never start at once.
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { audits, projects } from "@/db/schema";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { parseAuditConfig } from "@/server/lib/audit/types";
import { asAppError } from "@/server/lib/errors";
import { getCached, setCached } from "@/server/lib/r2-cache";

export type FleetReauditMode = "off" | "gentle" | "normal" | "fast";

/** Audits started per 5-minute tick, and the cap on audits running at once. */
export const FLEET_REAUDIT_RATES: Record<
  Exclude<FleetReauditMode, "off">,
  { perTick: number; maxRunning: number }
> = {
  gentle: { perTick: 3, maxRunning: 6 },
  normal: { perTick: 5, maxRunning: 10 },
  fast: { perTick: 10, maxRunning: 20 },
};

/** A site is due when its latest audit started longer ago than this. */
export const FLEET_REAUDIT_STALE_DAYS = 7;

const modeSchema = z.enum(["off", "gentle", "normal", "fast"]);
const actorSchema = z.object({ userId: z.string(), userEmail: z.string() });
const tickSchema = z.object({
  at: z.string(),
  started: z.number(),
  failed: z.number(),
  errors: z.array(z.object({ projectId: z.string(), code: z.string() })),
});
const stateSchema = z.object({
  mode: modeSchema.catch("off"),
  actor: actorSchema.nullable().catch(null),
  /** Sites picked on demand, in the order asked; drained before stale sites. */
  queue: z.array(z.string()).catch([]),
  lastTick: tickSchema.nullable().catch(null),
});
type Actor = z.infer<typeof actorSchema>;
type TickResult = z.infer<typeof tickSchema>;
type State = z.infer<typeof stateSchema>;
const EMPTY_STATE: State = { mode: "off", actor: null, queue: [], lastTick: null };

const STATE_TTL_SECONDS = 10 * 365 * 24 * 3600;
const stateKey = (organizationId: string) =>
  `fleet-reaudit:v1:${organizationId}`;

async function readState(organizationId: string): Promise<State> {
  const parsed = stateSchema.safeParse(await getCached(stateKey(organizationId)));
  return parsed.success ? parsed.data : EMPTY_STATE;
}

async function writeState(organizationId: string, state: State) {
  await setCached(stateKey(organizationId), state, STATE_TTL_SECONDS);
}

type Site = {
  projectId: string;
  domain: string;
  status: "running" | "completed" | "failed" | null;
  startedAt: number | null;
  config: string | null;
};

/** SQLite's current_timestamp has no zone marker; it is UTC. */
function parseStartedAt(value: string): number {
  return Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

async function listSites(organizationId: string): Promise<Site[]> {
  const rows = await db
    .select({
      projectId: projects.id,
      domain: projects.domain,
      status: audits.status,
      startedAt: audits.startedAt,
      config: audits.config,
    })
    .from(projects)
    .leftJoin(
      audits,
      and(
        eq(audits.projectId, projects.id),
        sql`${audits.startedAt} = (select max(a2.started_at) from audits a2 where a2.project_id = ${projects.id})`,
      ),
    )
    .where(
      and(
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
        isNotNull(projects.domain),
      ),
    );
  return rows.map((r) => ({
    projectId: r.projectId,
    domain: r.domain!,
    status: r.status,
    startedAt: r.startedAt ? parseStartedAt(r.startedAt) : null,
    config: r.config,
  }));
}

function isDue(site: Site, now: number) {
  if (site.status === "running") return false;
  if (site.startedAt == null) return true;
  return now - site.startedAt > FLEET_REAUDIT_STALE_DAYS * 86_400_000;
}

/** Never-audited sites first, then the oldest audit. */
function byStaleness(a: Site, b: Site) {
  return (a.startedAt ?? -Infinity) - (b.startedAt ?? -Infinity);
}

/** Re-run the site's previous audit settings; first audits use the fleet default. */
function auditSettings(config: string | null) {
  const previous = parseAuditConfig(config);
  return {
    maxPages: previous?.maxPages ?? 10,
    lighthouseStrategy: previous?.lighthouseStrategy ?? "none",
    renderJavaScript: previous?.renderJavaScript ?? false,
  };
}

export async function setFleetReauditMode(
  organizationId: string,
  mode: FleetReauditMode,
  actor: Actor,
) {
  const state = await readState(organizationId);
  await writeState(organizationId, { ...state, mode, actor });
}

/** Queue sites for a re-audit; returns how many fleet sites are now waiting. */
export async function queueFleetReaudit(
  organizationId: string,
  projectIds: string[],
  actor: Actor,
) {
  const fleet = new Set((await listSites(organizationId)).map((s) => s.projectId));
  const state = await readState(organizationId);
  const queue = [...new Set([...state.queue, ...projectIds])].filter((id) =>
    fleet.has(id),
  );
  await writeState(organizationId, { ...state, actor, queue });
  return { queued: queue.length };
}

export async function clearFleetReauditQueue(organizationId: string) {
  const state = await readState(organizationId);
  await writeState(organizationId, { ...state, queue: [] });
}

export async function getFleetReauditStatus(organizationId: string) {
  const [state, sites] = await Promise.all([
    readState(organizationId),
    listSites(organizationId),
  ]);
  const now = Date.now();
  return {
    mode: state.mode,
    staleDays: FLEET_REAUDIT_STALE_DAYS,
    rates: FLEET_REAUDIT_RATES,
    due: sites.filter((s) => isDue(s, now)).length,
    running: sites.filter((s) => s.status === "running").length,
    queued: state.queue.length,
    lastTick: state.lastTick,
  };
}

export async function runFleetReauditTick(organizationId: string) {
  const state = await readState(organizationId);
  if (!state.actor || (state.mode === "off" && state.queue.length === 0))
    return null;
  // Picked sites still drain at the normal rate while the schedule is off.
  const rate =
    FLEET_REAUDIT_RATES[state.mode === "off" ? "normal" : state.mode];
  const sites = await listSites(organizationId);
  const byId = new Map(sites.map((s) => [s.projectId, s]));
  const now = Date.now();
  const running = sites.filter((s) => s.status === "running").length;
  const room = Math.max(0, Math.min(rate.perTick, rate.maxRunning - running));
  const picked = state.queue
    .map((id) => byId.get(id))
    .filter((s): s is Site => !!s && s.status !== "running");
  const stale =
    state.mode === "off"
      ? []
      : sites
          .filter((s) => isDue(s, now) && !state.queue.includes(s.projectId))
          // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh array; toSorted is not in the ES2022 lib
          .sort(byStaleness);
  const batch = [...picked, ...stale].slice(0, room);

  const customer = { organizationId, ...state.actor };
  const limitTier = await AuditService.resolveAuditLimitTier(customer);
  const result: TickResult = {
    at: new Date(now).toISOString(),
    started: 0,
    failed: 0,
    errors: [],
  };
  for (const site of batch) {
    try {
      await AuditService.startAudit({
        actorUserId: state.actor.userId,
        billingCustomer: customer,
        projectId: site.projectId,
        startUrl: `https://${site.domain}`,
        limitTier,
        ...auditSettings(site.config),
      });
      result.started++;
    } catch (error) {
      result.failed++;
      result.errors.push({
        projectId: site.projectId,
        code: asAppError(error)?.code ?? "INTERNAL_ERROR",
      });
    }
  }
  // Re-read so sites queued during the tick are kept.
  const latest = await readState(organizationId);
  const done = new Set(batch.map((s) => s.projectId));
  await writeState(organizationId, {
    ...latest,
    queue: latest.queue.filter((id) => byId.has(id) && !done.has(id)),
    lastTick: result,
  });
  return result;
}

let scheduledStartedAt = 0;

/** Cron entry: one tick per organization; skips if the last run is still going. */
export async function runScheduledFleetReaudit() {
  if (scheduledStartedAt && Date.now() - scheduledStartedAt < 10 * 60_000)
    return;
  scheduledStartedAt = Date.now();
  try {
    const orgs = await db
      .selectDistinct({ organizationId: projects.organizationId })
      .from(projects)
      .where(isNull(projects.archivedAt));
    for (const { organizationId } of orgs) {
      const result = await runFleetReauditTick(organizationId);
      if (result?.started || result?.failed)
        console.log("[fleet-reaudit] tick", { organizationId, ...result });
    }
  } finally {
    scheduledStartedAt = 0;
  }
}
