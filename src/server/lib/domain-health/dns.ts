import type { DnsResult } from "./types";

/** Cloudflare DoH JSON endpoint — works in Workers and Docker (no system DNS). */
export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

type DnsJsonAnswer = { type?: number; data?: string };
type DnsJsonResponse = { Status?: number; Answer?: DnsJsonAnswer[] };

const TYPE_A = 1;
const TYPE_AAAA = 28;
const TYPE_NS = 2;

function normalizeHost(hostname: string): string {
  let host = hostname.toLowerCase().trim();
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

async function dohQuery(
  hostname: string,
  type: "A" | "AAAA" | "NS",
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<string[]> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`;
  const response = await fetchImpl(url, {
    headers: { Accept: "application/dns-json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return [];

  const body = (await response.json()) as DnsJsonResponse;
  if (body.Status !== 0 || !Array.isArray(body.Answer)) return [];

  const expected =
    type === "A" ? TYPE_A : type === "AAAA" ? TYPE_AAAA : TYPE_NS;

  return body.Answer.filter(
    (a): a is { type: number; data: string } =>
      a.type === expected && typeof a.data === "string",
  ).map((a) => {
    // NS answers sometimes end with a trailing dot.
    const data = a.data.replace(/\.$/, "");
    return type === "NS" ? data.toLowerCase() : normalizeHost(data);
  });
}

export async function resolveDomainDns(
  domain: string,
  options: {
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
  } = {},
): Promise<DnsResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const host = normalizeHost(domain);

  try {
    const [a, aaaa, ns] = await Promise.all([
      dohQuery(host, "A", fetchImpl, timeoutMs),
      dohQuery(host, "AAAA", fetchImpl, timeoutMs),
      dohQuery(host, "NS", fetchImpl, timeoutMs),
    ]);

    const onCloudflare = ns.some((n) => n.endsWith("cloudflare.com"));
    const ok = a.length > 0 || aaaa.length > 0;

    return {
      ok,
      a,
      aaaa,
      ns,
      onCloudflare,
      error: ok ? null : "No A/AAAA records",
    };
  } catch (err) {
    return {
      ok: false,
      a: [],
      aaaa: [],
      ns: [],
      onCloudflare: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * True for loopback, private, link-local, CGNAT (incl. Tailscale 100.64/10),
 * unique-local and other reserved ranges. Used so the health check never
 * fetches an internal address on behalf of a caller.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (!v.includes(":")) return false;
  if (v === "::" || v === "::1") return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]!);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
}

/** True when a URL host is an IP literal in a private range or a local name. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".ts.net")) return true;
  return isPrivateAddress(h);
}
