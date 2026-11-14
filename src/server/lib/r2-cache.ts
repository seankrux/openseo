import { env } from "cloudflare:workers";
import { cooperativeR2 } from "@/server/lib/cooperative-yield";
import { sortBy } from "remeda";

/** R2 calls hand workerd's one thread back to waiting requests. */
const bucket = () => cooperativeR2(env.R2);

/**
 * Cache TTL constants in seconds.
 */
export const CACHE_TTL = {
  /** Related keyword research results */
  researchResult: 86400,
} as const;

const CACHE_PREFIX = "dataforseo-cache/";

export const AI_SEARCH_PROMPT_CACHE_NAMESPACE = "ai-search:prompt-response";

/** Full R2 object-key prefix for a cache namespace, for prefix listing. */
export function cacheObjectPrefix(namespace: string): string {
  return `${CACHE_PREFIX}${namespace}:`;
}

/**
 * Build a deterministic cache key from an endpoint slug and input params.
 * Uses a SHA-256 digest for stability across runtimes.
 */
export async function buildCacheKey(
  prefix: string,
  params: Record<string, unknown>,
): Promise<string> {
  const raw = JSON.stringify(
    Object.fromEntries(sortBy(Object.entries(params), ([key]) => key)),
  );

  return `${prefix}:${await sha256Hex(raw)}`;
}

/**
 * Get a cached JSON value from R2. Returns null on miss or expiry.
 * Callers should validate the shape with Zod before trusting it — schema
 * drift between writes and reads is otherwise silent.
 */
export async function getCached(
  key: string,
  options: { allowExpired?: boolean } = {},
): Promise<unknown> {
  const obj = await bucket().get(`${CACHE_PREFIX}${key}`);
  if (!obj) return null;

  const expiresAt = obj.customMetadata?.expiresAt;
  // Inventory callers may inspect expired evidence to explain its age. Such
  // evidence must never be included in live totals without a freshness check.
  if (!options.allowExpired && expiresAt && Date.parse(expiresAt) < Date.now())
    return null;

  try {
    return JSON.parse(await obj.text());
  } catch {
    return null;
  }
}

const shared = new Map<string, { etag: string; value: unknown }>();

/**
 * getCached for large objects read far more often than written. The parsed
 * value is kept per isolate and reused while the stored etag is unchanged (a
 * conditional get transfers no body), so a multi-megabyte JSON.parse runs once
 * per write instead of once per read. Callers must not mutate the result.
 */
export async function getCachedShared(
  key: string,
  options: { allowExpired?: boolean } = {},
): Promise<unknown> {
  const fullKey = `${CACHE_PREFIX}${key}`;
  const hit = shared.get(fullKey);
  // A failed etagDoesNotMatch returns the object's metadata without a body.
  const obj: R2Object | R2ObjectBody | null = await bucket().get(
    fullKey,
    hit ? { onlyIf: { etagDoesNotMatch: hit.etag } } : undefined,
  );
  if (!obj) {
    shared.delete(fullKey);
    return null;
  }
  const expiresAt = obj.customMetadata?.expiresAt;
  if (!options.allowExpired && expiresAt && Date.parse(expiresAt) < Date.now())
    return null;
  if (!("text" in obj))
    return hit && obj.etag === hit.etag ? hit.value : getCached(key, options);
  try {
    const value: unknown = JSON.parse(await obj.text());
    if (obj.etag) shared.set(fullKey, { etag: obj.etag, value });
    else shared.delete(fullKey);
    return value;
  } catch {
    shared.delete(fullKey);
    return null;
  }
}

/**
 * Store a JSON value in R2 with a soft TTL via custom metadata.
 */
export async function setCached<T>(
  key: string,
  data: T,
  ttlSeconds: number,
  metadata: Record<string, string> = {},
): Promise<void> {
  await bucket().put(`${CACHE_PREFIX}${key}`, JSON.stringify(data), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      ...metadata,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    },
  });
}

/**
 * Compute a deterministic SHA-256 digest for cache keys.
 */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
