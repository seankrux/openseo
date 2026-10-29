// CityThrive fork: install the GA4 tag fleet-wide through Cloudflare.
// Uses the `citythrive-ga4-injector` Worker (HTMLRewriter, fail-open) whose host->measurementId map
// lives in the KV namespace `citythrive-ga4-map` (key "map"). Installing for a host = add it to the map
// and make sure the zone's apex/www routes point at the Worker. Zones whose catch-all route already
// belongs to another Worker (e.g. fleet-static-worker) are reported as blocked, never overridden.
import { getOptionalEnvValue } from "@/server/lib/runtime-env";

const API = "https://api.cloudflare.com/client/v4";
export const GA4_INJECTOR_SCRIPT = "citythrive-ga4-injector";
const KV_TITLE = "citythrive-ga4-map";
const EXCLUDE = ["wp-content/*", "wp-includes/*", "wp-json/*", "wp-admin/*"];

export type CfConfig = { token: string; accountId: string };

export async function getCloudflareConfig(): Promise<CfConfig | null> {
  const token = (await getOptionalEnvValue("GA4_SETUP_CLOUDFLARE_TOKEN"))?.trim()
    || (await getOptionalEnvValue("CLOUDFLARE_API_TOKEN"))?.trim();
  const accountId = (await getOptionalEnvValue("GA4_SETUP_CLOUDFLARE_ACCOUNT_ID"))?.trim()
    || (await getOptionalEnvValue("CLOUDFLARE_ACCOUNT_ID"))?.trim();
  return token && accountId ? { token, accountId } : null;
}

async function cf(c: CfConfig, method: string, path: string, body?: unknown, raw = false) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": raw ? "text/plain" : "application/json" },
    body: body === undefined ? undefined : raw ? String(body) : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: r.status, json };
}

let kvIdCache: string | null = null;
async function kvId(c: CfConfig): Promise<string> {
  if (kvIdCache) return kvIdCache;
  const fixed = (await getOptionalEnvValue("GA4_SETUP_KV_NAMESPACE_ID"))?.trim();
  if (fixed) return (kvIdCache = fixed);
  for (let page = 1; page <= 50; page++) {
    const r = await cf(c, "GET", `/accounts/${c.accountId}/storage/kv/namespaces?per_page=100&page=${page}`);
    const hit = (r.json.result ?? []).find((n: any) => n.title === KV_TITLE);
    if (hit) return (kvIdCache = hit.id as string);
    if (page >= (r.json.result_info?.total_pages ?? 1)) break;
  }
  throw new Error(`Cloudflare KV namespace ${KV_TITLE} not found (deploy the injector Worker first)`);
}

export async function readTagMap(c: CfConfig): Promise<Record<string, string>> {
  const id = await kvId(c);
  const r = await fetch(`${API}/accounts/${c.accountId}/storage/kv/namespaces/${id}/values/map`, {
    headers: { Authorization: `Bearer ${c.token}` },
  });
  if (r.status === 404) return {};
  if (!r.ok) throw new Error(`KV read HTTP ${r.status}`);
  try { return (await r.json()) as Record<string, string>; } catch { return {}; }
}

async function writeTagMap(c: CfConfig, map: Record<string, string>) {
  const id = await kvId(c);
  const r = await cf(c, "PUT", `/accounts/${c.accountId}/storage/kv/namespaces/${id}/values/map`, JSON.stringify(map), true);
  if (!r.json.success) throw new Error(`KV write failed: ${JSON.stringify(r.json.errors ?? r.json).slice(0, 200)}`);
}

// Serialize KV map read-modify-write inside this isolate.
let mapLock: Promise<unknown> = Promise.resolve();
export function setHostsInTagMap(c: CfConfig, entries: Record<string, string>) {
  const run = mapLock.then(async () => {
    const map = await readTagMap(c);
    let changed = false;
    for (const [h, id] of Object.entries(entries)) if (map[h] !== id) { map[h] = id; changed = true; }
    if (changed) await writeTagMap(c, map);
    return changed;
  });
  mapLock = run.catch(() => undefined);
  return run;
}

export type RoutePlan = {
  zoneId: string | null;
  status: "ok" | "would_create" | "blocked" | "no_zone" | "error";
  create: string[];
  blockedBy?: string;
  error?: string;
};

export async function planOrApplyRoutes(c: CfConfig, domain: string, apply: boolean): Promise<RoutePlan> {
  const z = await cf(c, "GET", `/zones?name=${encodeURIComponent(domain)}`);
  const zoneId: string | undefined = z.json.result?.[0]?.id;
  if (!zoneId) return { zoneId: null, status: "no_zone", create: [] };
  const rr = await cf(c, "GET", `/zones/${zoneId}/workers/routes`);
  if (rr.status !== 200) return { zoneId, status: "error", create: [], error: `routes HTTP ${rr.status}` };
  const routes: { id: string; pattern: string; script?: string }[] = rr.json.result ?? [];
  const byPattern = new Map(routes.map((r) => [r.pattern, r.script ?? ""]));
  const hosts = [domain, `www.${domain}`];
  // Workers patched to read the same GA4_MAP KV (fleet-static-worker*) inject the tag themselves.
  const compatible = ((await getOptionalEnvValue("GA4_SETUP_COMPATIBLE_WORKERS")) ?? "fleet-static-worker,fleet-static-worker-server-1")
    .split(",").map((x) => x.trim()).filter(Boolean);
  for (const pat of [...hosts.map((h) => `${h}/*`), `*${domain}/*`]) {
    const s = byPattern.get(pat);
    if (s && s !== GA4_INJECTOR_SCRIPT) {
      if (compatible.includes(s)) return { zoneId, status: "ok", create: [], blockedBy: `shared:${s}` };
      return { zoneId, status: "blocked", create: [], blockedBy: `${pat} -> ${s}` };
    }
  }
  const wanted: { pattern: string; script?: string }[] = [];
  for (const h of hosts) {
    wanted.push({ pattern: `${h}/*`, script: GA4_INJECTOR_SCRIPT });
    for (const e of EXCLUDE) wanted.push({ pattern: `${h}/${e}` });
  }
  const missing = wanted.filter((w) => !byPattern.has(w.pattern));
  if (!apply) return { zoneId, status: missing.length ? "would_create" : "ok", create: missing.map((m) => m.pattern) };
  for (const m of missing) {
    const r = await cf(c, "POST", `/zones/${zoneId}/workers/routes`, m.script ? m : { pattern: m.pattern });
    if (!r.json.success) return { zoneId, status: "error", create: [], error: `route ${m.pattern}: ${JSON.stringify(r.json.errors).slice(0, 200)}` };
  }
  return { zoneId, status: "ok", create: missing.map((m) => m.pattern) };
}

/** Fetch the homepage and look for the measurement ID in the served HTML. */
export async function verifyTagLive(domain: string, measurementId: string) {
  for (const url of [`https://${domain}/`, `https://www.${domain}/`]) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (OpenSEO GA4 setup verifier)" }, redirect: "follow" });
      const html = await r.text();
      const header = r.headers.get("x-ct-ga4");
      if (html.includes(measurementId)) return { live: true, url, header };
      if (url.endsWith(`${domain}/`) && r.status === 200 && !html.includes("<head")) continue;
      if (r.status === 200) return { live: false, url, header, reason: `HTML has no ${measurementId}` };
    } catch (e) {
      if (url.includes("www.")) return { live: false, url, reason: String(e).slice(0, 120) };
    }
  }
  return { live: false, reason: "no reachable homepage" };
}
