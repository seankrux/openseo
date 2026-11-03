// CityThrive fork: install the GA4 tag fleet-wide through Cloudflare.
// Uses the `citythrive-ga4-injector` Worker (HTMLRewriter, fail-open) whose host->measurementId map
// lives in the KV namespace `citythrive-ga4-map` (key "map"). Installing for a host = add it to the map
// and make sure the zone's apex/www routes point at the Worker. Zones whose catch-all route already
// belongs to another Worker (e.g. fleet-static-worker) are reported as blocked, never overridden.
import { MAX_HTML_BYTES, readTextUpTo } from "@/server/lib/audit/html-response";
import { normalizeAndValidateStartUrl } from "@/server/lib/audit/url-policy";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { z } from "zod";

const API = "https://api.cloudflare.com/client/v4";
const GA4_INJECTOR_SCRIPT = "citythrive-ga4-injector";
const KV_TITLE = "citythrive-ga4-map";
const cloudflareResponseSchema = z.object({
  success: z.boolean().optional(),
  result: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().optional(),
        pattern: z.string().optional(),
        script: z.string().nullable().optional(),
      }),
    )
    .nullish(),
  result_info: z.object({ total_pages: z.number().optional() }).optional(),
  errors: z.unknown().optional(),
});
const mutationResponseSchema = z.object({
  success: z.boolean(),
  errors: z.unknown().optional(),
});
const tagMapSchema = z.record(z.string(), z.string());
const EXCLUDE = ["wp-content/*", "wp-includes/*", "wp-json/*", "wp-admin/*"];

type CfConfig = { token: string; accountId: string };

export async function getCloudflareConfig(): Promise<CfConfig | null> {
  const token =
    (await getOptionalEnvValue("GA4_SETUP_CLOUDFLARE_TOKEN"))?.trim() ||
    (await getOptionalEnvValue("CLOUDFLARE_API_TOKEN"))?.trim();
  const accountId =
    (await getOptionalEnvValue("GA4_SETUP_CLOUDFLARE_ACCOUNT_ID"))?.trim() ||
    (await getOptionalEnvValue("CLOUDFLARE_ACCOUNT_ID"))?.trim();
  return token && accountId ? { token, accountId } : null;
}

async function cf(
  c: CfConfig,
  method: string,
  path: string,
  body?: unknown,
  raw = false,
) {
  const r = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${c.token}`,
      "Content-Type": raw ? "text/plain" : "application/json",
    },
    body:
      body === undefined
        ? undefined
        : raw
          ? z.string().parse(body)
          : JSON.stringify(body),
  });
  const text = await r.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return {
    status: r.status,
    json: cloudflareResponseSchema.parse(
      method === "GET" ? json : mutationResponseSchema.parse(json),
    ),
  };
}

let kvIdCache: string | null = null;
async function kvId(c: CfConfig): Promise<string> {
  if (kvIdCache) return kvIdCache;
  const fixed = (
    await getOptionalEnvValue("GA4_SETUP_KV_NAMESPACE_ID")
  )?.trim();
  if (fixed) return (kvIdCache = fixed);
  for (let page = 1; page <= 50; page++) {
    const r = await cf(
      c,
      "GET",
      `/accounts/${c.accountId}/storage/kv/namespaces?per_page=100&page=${page}`,
    );
    const hit = (r.json.result ?? []).find((n) => n.title === KV_TITLE);
    if (hit) return (kvIdCache = hit.id);
    if (page >= (r.json.result_info?.total_pages ?? 1)) break;
  }
  throw new Error(
    `Cloudflare KV namespace ${KV_TITLE} not found (deploy the injector Worker first)`,
  );
}

export async function readTagMap(c: CfConfig): Promise<Record<string, string>> {
  const id = await kvId(c);
  const r = await fetch(
    `${API}/accounts/${c.accountId}/storage/kv/namespaces/${id}/values/map`,
    {
      headers: { Authorization: `Bearer ${c.token}` },
    },
  );
  if (r.status === 404) return {};
  if (!r.ok) throw new Error(`KV read HTTP ${r.status}`);
  return tagMapSchema.parse(await r.json());
}

async function writeTagMap(c: CfConfig, map: Record<string, string>) {
  const id = await kvId(c);
  const r = await cf(
    c,
    "PUT",
    `/accounts/${c.accountId}/storage/kv/namespaces/${id}/values/map`,
    JSON.stringify(map),
    true,
  );
  if (!r.json.success)
    throw new Error(
      `KV write failed: ${JSON.stringify(r.json.errors ?? r.json).slice(0, 200)}`,
    );
}

// Serialize KV map read-modify-write inside this isolate.
let mapLock: Promise<unknown> = Promise.resolve();
export function setHostsInTagMap(c: CfConfig, entries: Record<string, string>) {
  const run = mapLock.then(async () => {
    const map = await readTagMap(c);
    let changed = false;
    for (const [h, id] of Object.entries(entries))
      if (map[h] !== id) {
        map[h] = id;
        changed = true;
      }
    if (changed) await writeTagMap(c, map);
    return changed;
  });
  mapLock = run.catch(() => undefined);
  return run;
}

type RoutePlan = {
  zoneId: string | null;
  status: "ok" | "would_create" | "blocked" | "no_zone" | "error";
  create: string[];
  blockedBy?: string;
  error?: string;
};

export async function planOrApplyRoutes(
  c: CfConfig,
  domain: string,
  apply: boolean,
): Promise<RoutePlan> {
  const zoneResponse = await cf(
    c,
    "GET",
    `/zones?name=${encodeURIComponent(domain)}`,
  );
  const zoneId: string | undefined = zoneResponse.json.result?.[0]?.id;
  if (!zoneId) return { zoneId: null, status: "no_zone", create: [] };
  const rr = await cf(c, "GET", `/zones/${zoneId}/workers/routes`);
  if (rr.status !== 200)
    return {
      zoneId,
      status: "error",
      create: [],
      error: `routes HTTP ${rr.status}`,
    };
  const routes: { id: string; pattern: string; script?: string }[] = (
    rr.json.result ?? []
  ).flatMap((r) =>
    r.pattern
      ? [{ id: r.id, pattern: r.pattern, script: r.script ?? undefined }]
      : [],
  );
  const byPattern = new Map(routes.map((r) => [r.pattern, r.script ?? ""]));
  const hosts = [domain, `www.${domain}`];
  // Workers patched to read the same GA4_MAP KV (fleet-static-worker*) inject the tag themselves.
  const compatible = (
    (await getOptionalEnvValue("GA4_SETUP_COMPATIBLE_WORKERS")) ??
    "fleet-static-worker,fleet-static-worker-server-1"
  )
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const pat of [...hosts.map((h) => `${h}/*`), `*${domain}/*`]) {
    const s = byPattern.get(pat);
    if (s && s !== GA4_INJECTOR_SCRIPT) {
      if (compatible.includes(s))
        return { zoneId, status: "ok", create: [], blockedBy: `shared:${s}` };
      return {
        zoneId,
        status: "blocked",
        create: [],
        blockedBy: `${pat} -> ${s}`,
      };
    }
  }
  const wanted: { pattern: string; script?: string }[] = [];
  for (const h of hosts) {
    wanted.push({ pattern: `${h}/*`, script: GA4_INJECTOR_SCRIPT });
    for (const e of EXCLUDE) wanted.push({ pattern: `${h}/${e}` });
  }
  const missing = wanted.filter((w) => !byPattern.has(w.pattern));
  if (!apply)
    return {
      zoneId,
      status: missing.length ? "would_create" : "ok",
      create: missing.map((m) => m.pattern),
    };
  for (const m of missing) {
    const r = await cf(
      c,
      "POST",
      `/zones/${zoneId}/workers/routes`,
      m.script ? m : { pattern: m.pattern },
    );
    if (!r.json.success)
      return {
        zoneId,
        status: "error",
        create: [],
        error: `route ${m.pattern}: ${JSON.stringify(r.json.errors).slice(0, 200)}`,
      };
  }
  return { zoneId, status: "ok", create: missing.map((m) => m.pattern) };
}

/** Fetch bounded HTML, validating the initial URL and every redirect. */
async function verifyHomepage(url: string, measurementId: string) {
  let current = await normalizeAndValidateStartUrl(url);
  for (let hop = 0; hop <= 5; hop++) {
    const response = await fetch(current, {
      headers: { "User-Agent": "Mozilla/5.0 (OpenSEO GA4 setup verifier)" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      current = await normalizeAndValidateStartUrl(
        new URL(location, current).toString(),
      );
      continue;
    }
    const html = await readTextUpTo(response, MAX_HTML_BYTES);
    return {
      live: response.ok && html.includes(measurementId),
      url: current,
      header: response.headers.get("x-ct-ga4"),
      reason: response.ok
        ? `HTML has no ${measurementId}`
        : `Homepage HTTP ${response.status}`,
    };
  }
  throw new Error("Too many homepage redirects");
}

/** Check both apex and www before declaring a tag missing. */
export async function verifyTagLive(domain: string, measurementId: string) {
  let last: {
    live: boolean;
    url?: string;
    header?: string | null;
    reason?: string;
  } = {
    live: false,
    reason: "no reachable homepage",
  };
  for (const url of [`https://${domain}/`, `https://www.${domain}/`]) {
    try {
      last = await verifyHomepage(url, measurementId);
      if (last.live) return last;
    } catch (error) {
      last = {
        live: false,
        url,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return last;
}
