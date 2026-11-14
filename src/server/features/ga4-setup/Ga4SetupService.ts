// CityThrive fork: GA4 setup per site and in bulk.
// Steps per site: (1) find or create the GA4 property + web stream (Admin API, connected GA4 login),
// (2) install the gtag via Cloudflare (injector Worker + KV map), (3) verify the tag is live on the
// homepage, (4) link the property to the project. Preview (apply=false) never writes anything.
// Status per domain is kept in KV (`ga4setup:state`) and shown on /ga4-setup.
import { env } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { account, ga4Connections, projects } from "@/db/schema";
import { getGoogleAccessToken } from "@/server/features/google/googleOAuth";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { Ga4Service } from "@/server/features/ga4/services/Ga4Service";
import { GA4_OAUTH_PROVIDER_ID } from "@/shared/ga4";
import { bareHost } from "@/server/features/google-linking/domain";
import {
  getCloudflareConfig,
  planOrApplyRoutes,
  readTagMap,
  setHostsInTagMap,
  verifyTagLive,
} from "./cloudflareTag";

const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const STATE_KEY = "ga4setup:state";
const LOG_KEY = "ga4setup:log";
const MAX_ATTEMPTS = 6;

export type SiteStatus = {
  domain: string;
  projectId: string;
  status: "pending" | "preview" | "created" | "tagged" | "live" | "linked" | "blocked" | "waiting" | "error";
  step?: string;
  propertyId?: string;
  measurementId?: string;
  detail?: string;
  attempts: number;
  updatedAt: string;
  nextTryAt?: string;
};
type State = Record<string, SiteStatus>;

function kv(): KVNamespace | null {
  const k = (env as unknown as { KV?: KVNamespace }).KV;
  return k ?? null;
}
export async function readState(): Promise<State> {
  const k = kv();
  if (!k) return {};
  return ((await k.get(STATE_KEY, { type: "json" })) as State | null) ?? {};
}
let stateLock: Promise<unknown> = Promise.resolve();
async function patchState(domain: string, patch: Partial<SiteStatus> & { projectId: string }) {
  const run = stateLock.then(async () => {
    const k = kv();
    if (!k) return;
    const s = await readState();
    const prev = s[domain] ?? { domain, projectId: patch.projectId, status: "pending", attempts: 0, updatedAt: "" };
    s[domain] = { ...prev, ...patch, domain, updatedAt: new Date().toISOString() } as SiteStatus;
    await k.put(STATE_KEY, JSON.stringify(s));
  });
  stateLock = run.catch(() => undefined);
  return run;
}
/** One pass: older scope-403 "error" entries become "waiting" (single KV write). */
async function migrateScopeErrorsToWaiting() {
  const run = stateLock.then(async () => {
    const k = kv();
    if (!k) return;
    const s = await readState();
    let n = 0;
    for (const v of Object.values(s)) {
      if (v.status === "error" && /analytics\.edit|GA4_OAUTH_MANAGE_SCOPES|insufficient.*scope/i.test(v.detail ?? "")) {
        v.status = "waiting"; v.detail = "waiting for Google Analytics reconnect with analytics.edit"; v.attempts = 0;
        v.nextTryAt = new Date(Date.now() + 6 * 60 * 60_000).toISOString(); n++;
      }
    }
    if (n) await k.put(STATE_KEY, JSON.stringify(s));
  });
  stateLock = run.catch(() => undefined);
  return run;
}
async function appendLog(line: string) {
  const k = kv();
  if (!k) return;
  const log = ((await k.get(LOG_KEY, { type: "json" })) as string[] | null) ?? [];
  log.unshift(`${new Date().toISOString()} ${line}`);
  await k.put(LOG_KEY, JSON.stringify(log.slice(0, 500)));
}
export async function readLog(): Promise<string[]> {
  const k = kv();
  return k ? (((await k.get(LOG_KEY, { type: "json" })) as string[] | null) ?? []) : [];
}

/** The GA4 login to act as: GA4_SETUP_GOOGLE_EMAIL (default seantechworks@gmail.com). */
async function pickGa4Login(userId: string) {
  const want = ((await getOptionalEnvValue("GA4_SETUP_GOOGLE_EMAIL")) ?? "seantechworks@gmail.com").toLowerCase();
  const { accounts } = await Ga4Service.listPropertiesForUserWithGrantStatus(userId);
  const hit = accounts.find((a) => (a.email ?? "").toLowerCase() === want);
  if (!hit) throw new Error(`No connected Google Analytics login for ${want}. Connect it under Integrations.`);
  if (hit.email?.toLowerCase().startsWith("seanguillermo@")) throw new Error("Refusing to use seanguillermo@gmail.com for GA4 setup.");
  return hit;
}

async function admin(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(ADMIN + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 200) }; }
  if (!r.ok) {
    const msg = json?.error?.message ?? JSON.stringify(json).slice(0, 200);
    const scopeHint = r.status === 403 && /scope/i.test(msg) ? " (reconnect Google Analytics with GA4_OAUTH_MANAGE_SCOPES=1 so the login grants analytics.edit)" : "";
    throw new Error(`Admin API ${method} ${path.split("?")[0]} ${r.status}: ${msg}${scopeHint}`);
  }
  return json;
}

export type SetupResult = {
  domain: string;
  projectId: string;
  apply: boolean;
  steps: { step: string; status: string; detail?: string }[];
  propertyId?: string;
  measurementId?: string;
  final: SiteStatus["status"];
};

export async function setupSite(input: {
  userId: string;
  projectId: string;
  apply: boolean;
  skipVerifyWait?: boolean;
}): Promise<SetupResult> {
  const [proj] = await db.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
  if (!proj?.domain) throw new Error("Project has no domain.");
  const domain = bareHost(proj.domain)!;
  const steps: SetupResult["steps"] = [];
  const res: SetupResult = { domain, projectId: proj.id, apply: input.apply, steps, final: "preview" };
  const note = (step: string, status: string, detail?: string) => steps.push({ step, status, detail });
  try {
    const login = await pickGa4Login(input.userId);
    // 1. property
    const existingLink = await Ga4Service.getConnection(proj.id);
    let propertyId = existingLink?.propertyId;
    if (propertyId) note("property", "linked", propertyId);
    if (!propertyId) {
      const hit = login.properties.find((p) => bareHost(p.displayName) === domain);
      if (hit) { propertyId = hit.propertyId; note("property", "exists", propertyId); }
    }
    const token = input.apply || propertyId
      ? await getGoogleAccessToken({ userId: input.userId, providerId: GA4_OAUTH_PROVIDER_ID, accountId: login.accountId })
      : null;
    if (!propertyId) {
      const parent = (await getOptionalEnvValue("GA4_SETUP_PARENT_ACCOUNT"))?.trim();
      if (!parent) throw new Error("GA4_SETUP_PARENT_ACCOUNT (accounts/<id>) is not set.");
      if (!input.apply) { note("property", "would_create", `${parent} displayName=${domain}`); }
      else {
        const tz = (await getOptionalEnvValue("GA4_SETUP_TIMEZONE")) ?? "America/Chicago";
        const p = await admin(token!, "POST", "/properties", { parent, displayName: domain, timeZone: tz, currencyCode: "USD", industryCategory: "HOME_AND_GARDEN" });
        propertyId = p.name as string;
        note("property", "created", propertyId);
        await patchState(domain, { projectId: proj.id, status: "created", propertyId });
      }
    }
    // 2. web stream / measurement id
    let measurementId: string | undefined;
    if (propertyId && token) {
      const ds = await admin(token, "GET", `/${propertyId}/dataStreams`);
      const web = (ds.dataStreams ?? []).find((s: any) => s.type === "WEB_DATA_STREAM");
      measurementId = web?.webStreamData?.measurementId;
      if (measurementId) note("stream", "exists", measurementId);
      else if (!input.apply) note("stream", "would_create", `https://${domain}`);
      else {
        const s = await admin(token, "POST", `/${propertyId}/dataStreams`, { type: "WEB_DATA_STREAM", displayName: domain, webStreamData: { defaultUri: `https://${domain}` } });
        measurementId = s.webStreamData?.measurementId;
        note("stream", "created", measurementId);
      }
    } else note("stream", "would_create", `https://${domain}`);
    res.propertyId = propertyId; res.measurementId = measurementId;
    // 3. tag via Cloudflare
    const cfc = await getCloudflareConfig();
    if (!cfc) throw new Error("Cloudflare token/account not configured (GA4_SETUP_CLOUDFLARE_TOKEN / _ACCOUNT_ID).");
    const live0 = measurementId ? await verifyTagLive(domain, measurementId) : null;
    if (live0?.live) note("tag", "already_live", live0.url);
    else {
      const plan = await planOrApplyRoutes(cfc, domain, input.apply && !!measurementId);
      if (plan.status === "blocked") {
        note("tag", "blocked", `zone catch-all owned by another Worker (${plan.blockedBy}); add the tag in that Worker or the site header`);
        res.final = "blocked";
        if (input.apply) await patchState(domain, { projectId: proj.id, status: "blocked", step: "tag", detail: plan.blockedBy, propertyId, measurementId });
      } else if (plan.status === "no_zone" || plan.status === "error") {
        throw new Error(`Cloudflare: ${plan.status} ${plan.error ?? ""}`);
      } else if (!input.apply || !measurementId) {
        const map = await readTagMap(cfc).catch(() => ({} as Record<string, string>));
        note("tag", "would_install", `KV map ${map[domain] ? "has " + map[domain] : "add " + domain}; routes ${plan.create.length ? "+" + plan.create.length : "ok"}`);
      } else {
        await setHostsInTagMap(cfc, { [domain]: measurementId });
        note("tag", "installed", `routes +${plan.create.length}`);
        await patchState(domain, { projectId: proj.id, status: "tagged", propertyId, measurementId });
      }
    }
    // 4. verify
    if (input.apply && measurementId && res.final !== "blocked") {
      let v = live0?.live ? live0 : await verifyTagLive(domain, measurementId);
      if (!v.live && !input.skipVerifyWait) {
        // Worker caches the KV map up to 5 min per isolate.
        for (let i = 0; i < 4 && !v.live; i++) { await new Promise((r) => setTimeout(r, 20_000)); v = await verifyTagLive(domain, measurementId); }
      }
      note("verify", v.live ? "live" : "not_yet", v.live ? v.url : v.reason);
      if (v.live) res.final = "live";
    }
    // 5. link
    if (propertyId && !existingLink) {
      if (!input.apply) note("link", "would_link", propertyId);
      else {
        await Ga4Service.setProperty({ projectId: proj.id, organizationId: proj.organizationId, propertyId, accountId: login.accountId, userId: input.userId });
        note("link", "linked", propertyId);
      }
    }
    if (input.apply) {
      const done = res.final === "live" && (existingLink || propertyId);
      const status: SiteStatus["status"] = res.final === "blocked" ? "blocked" : done ? "linked" : "tagged";
      res.final = status;
      await patchState(domain, { projectId: proj.id, status, propertyId, measurementId, step: status === "tagged" ? "verify" : undefined, detail: status === "tagged" ? "tag not live yet; will re-verify" : undefined, nextTryAt: status === "tagged" ? new Date(Date.now() + 10 * 60_000).toISOString() : undefined });
      await appendLog(`${domain} ${status} ${propertyId ?? ""} ${measurementId ?? ""}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    note("error", "error", msg);
    res.final = "error";
    if (input.apply) {
      const prev = (await readState())[domain];
      // Missing analytics.edit (login not reconnected yet) is a wait state, not a failed attempt.
      const waiting = /analytics\.edit|GA4_OAUTH_MANAGE_SCOPES|insufficient.*scope/i.test(msg);
      const attempts = (prev?.attempts ?? 0) + (waiting ? 0 : 1);
      // Scope-blocked sites park in "waiting" (6h backoff); the autopilot skips creation entirely
      // until the GA4 login grants analytics.edit, then retries them at once.
      await patchState(domain, waiting
        ? { projectId: proj.id, status: "waiting", detail: "waiting for Google Analytics reconnect with analytics.edit", attempts, nextTryAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString() }
        : { projectId: proj.id, status: "error", detail: msg.slice(0, 300), attempts, nextTryAt: new Date(Date.now() + Math.min(24 * 60, 15 * 2 ** attempts) * 60_000).toISOString() });
      await appendLog(`${domain} error (attempt ${attempts}): ${msg.slice(0, 200)}`);
    }
  }
  return res;
}

/** Projects with a domain and no GA4 link (not archived), across orgs. */
export async function listMissingGa4(organizationId?: string) {
  const rows = await db
    .select({ id: projects.id, domain: projects.domain, organizationId: projects.organizationId, linked: ga4Connections.id })
    .from(projects)
    .leftJoin(ga4Connections, eq(ga4Connections.projectId, projects.id))
    .where(and(isNull(projects.archivedAt), organizationId ? eq(projects.organizationId, organizationId) : undefined));
  return rows.filter((r) => r.domain && !r.linked).map((r) => ({ projectId: r.id, domain: bareHost(r.domain)!, organizationId: r.organizationId }));
}

export async function runBulk(input: { userId: string; organizationId?: string; apply: boolean; limit: number; projectIds?: string[]; editReady?: boolean }) {
  let todo = await listMissingGa4(input.organizationId);
  if (input.projectIds?.length) todo = todo.filter((t) => input.projectIds!.includes(t.projectId));
  const state = await readState();
  const now = Date.now();
  todo = todo.filter((t) => {
    const s = state[t.domain];
    if (!s) return true;
    if (s.status === "blocked") return false;
    if (s.status === "error" && s.attempts >= MAX_ATTEMPTS) return false;
    if (s.status === "waiting" && input.editReady) return true;
    return !s.nextTryAt || Date.parse(s.nextTryAt) <= now || !input.apply;
  });
  const out: SetupResult[] = [];
  for (const t of todo.slice(0, input.limit)) {
    out.push(await setupSite({ userId: input.userId, projectId: t.projectId, apply: input.apply, skipVerifyWait: true }));
  }
  return { missingTotal: (await listMissingGa4(input.organizationId)).length, processed: out.length, results: out };
}

/** Scheduled autopilot (GA4_AUTOSETUP=1): a small batch every cron tick, as the owner of the GA4 grant. */
export async function runScheduledGa4Setup() {
  const flag = (await getOptionalEnvValue("GA4_AUTOSETUP"))?.trim();
  if (flag !== "1" && flag?.toLowerCase() !== "true") return;
  const k = kv();
  if (k) {
    const last = Number((await k.get("ga4setup:lastTick")) ?? 0);
    const every = Number((await getOptionalEnvValue("GA4_AUTOSETUP_EVERY_MIN")) ?? 10) * 60_000;
    if (Date.now() - last < every) return;
    await k.put("ga4setup:lastTick", String(Date.now()));
  }
  const [grant] = await db.select({ userId: account.userId, scope: account.scope }).from(account).where(eq(account.providerId, GA4_OAUTH_PROVIDER_ID)).limit(1);
  if (!grant) return;
  const editReady = /analytics\.edit/.test(grant.scope ?? "");
  await migrateScopeErrorsToWaiting();
  const limit = Number((await getOptionalEnvValue("GA4_AUTOSETUP_BATCH")) ?? 5);
  // Re-verify sites whose tag was installed but not yet seen live.
  const st = await readState();
  for (const s of Object.values(st).filter((x) => x.status === "tagged" && x.measurementId && (!x.nextTryAt || Date.parse(x.nextTryAt) <= Date.now())).slice(0, 20)) {
    const v = await verifyTagLive(s.domain, s.measurementId!);
    await patchState(s.domain, v.live
      ? { projectId: s.projectId, status: "linked", step: undefined, detail: `live ${v.url}`, nextTryAt: undefined }
      : { projectId: s.projectId, status: "tagged", attempts: s.attempts + 1, detail: v.reason, nextTryAt: new Date(Date.now() + 30 * 60_000).toISOString() });
  }
  // Re-run sites previously blocked on Cloudflare (e.g. before fleet-static-worker read GA4_MAP).
  for (const s of Object.values(await readState()).filter((x) => x.status === "blocked").slice(0, Number((await getOptionalEnvValue("GA4_AUTOSETUP_RETAG_BATCH")) ?? 25))) {
    await setupSite({ userId: grant.userId, projectId: s.projectId, apply: true, skipVerifyWait: true });
  }
  if (!editReady) {
    // No Admin API write calls until Google is reconnected with analytics.edit.
    const lastNote = Number((k && (await k.get("ga4setup:waitNote"))) ?? 0);
    if (Date.now() - lastNote > 6 * 60 * 60_000) {
      await appendLog("[autopilot] waiting: GA4 login lacks analytics.edit; property creation paused until reconnect");
      if (k) await k.put("ga4setup:waitNote", String(Date.now()));
    }
    return;
  }
  const r = await runBulk({ userId: grant.userId, apply: true, limit, editReady });
  await appendLog(`[autopilot] processed ${r.processed}, missing ${r.missingTotal}`);
}
