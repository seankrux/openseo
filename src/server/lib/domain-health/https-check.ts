import { readTextUpTo } from "@/server/lib/audit/html-response";
import { normalizeAndValidateStartUrl } from "@/server/lib/audit/url-policy";
import { getDomain } from "tldts";
import type { HttpsResult } from "./types";

function sameSite(a: string, b: string): boolean {
  const options = { allowPrivateDomains: true };
  return (getDomain(a, options) ?? a) === (getDomain(b, options) ?? b);
}

function isSslFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
  const hay = `${msg} ${cause}`.toLowerCase();
  return (
    hay.includes("cert") ||
    hay.includes("ssl") ||
    hay.includes("tls") ||
    hay.includes("unable to verify") ||
    hay.includes("hostname/ip doesn't match") ||
    hay.includes("err_tls") ||
    hay.includes("err_ssl")
  );
}

function isTimeout(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "TimeoutError") return true;
  if (err instanceof Error && err.name === "TimeoutError") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|aborted|AbortError/i.test(msg);
}

export async function fetchHttpsRoot(
  domain: string,
  options: {
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    maxRedirects?: number;
    maxBodyBytes?: number;
    userAgent?: string;
  } = {},
): Promise<HttpsResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const maxRedirects = options.maxRedirects ?? 8;
  const maxBodyBytes = options.maxBodyBytes ?? 200_000;
  const userAgent =
    options.userAgent ??
    "OpenSEO-DomainHealth/1.0 (+https://openseo.so; fleet-health)";

  const start = `https://${domain}/`;
  let current = start;
  let hops = 0;
  const t0 = Date.now();
  let targetValidated = false;

  try {
    current = await normalizeAndValidateStartUrl(start, fetchImpl);
    targetValidated = true;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": userAgent,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          return {
            ok: false,
            finalUrl: current,
            status: response.status,
            redirectHops: hops,
            redirectedOtherDomain: false,
            responseTimeMs: Date.now() - t0,
            bodySnippet: "",
            error: "Redirect without Location",
            timedOut: false,
            sslError: false,
          };
        }
        await response.body?.cancel();
        const nextUrl = new URL(location, current);
        try {
          current = await normalizeAndValidateStartUrl(
            nextUrl.toString(),
            fetchImpl,
          );
        } catch {
          return {
            ok: false,
            finalUrl: nextUrl.toString(),
            status: response.status,
            redirectHops: hops + 1,
            redirectedOtherDomain: true,
            responseTimeMs: Date.now() - t0,
            bodySnippet: "",
            error: "Redirect to a private or non-web address was not followed",
            timedOut: false,
            sslError: false,
          };
        }
        hops += 1;
        continue;
      }

      const bodySnippet = await readTextUpTo(response, maxBodyBytes);
      const finalHost = new URL(current).hostname;
      const redirectedOtherDomain = !sameSite(domain, finalHost);

      return {
        ok: response.status >= 200 && response.status < 400,
        finalUrl: current,
        status: response.status,
        redirectHops: hops,
        redirectedOtherDomain,
        responseTimeMs: Date.now() - t0,
        bodySnippet,
        error: null,
        timedOut: false,
        sslError: false,
      };
    }

    return {
      ok: false,
      finalUrl: current,
      status: null,
      redirectHops: hops,
      redirectedOtherDomain: false,
      responseTimeMs: Date.now() - t0,
      bodySnippet: "",
      error: "Too many redirects",
      timedOut: false,
      sslError: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = isTimeout(err);
    let sslError = isSslFailure(err);
    let error = message;
    // workerd reports TLS handshake and certificate failures as an opaque
    // "internal error; reference = ...". If the first HTTPS request failed that
    // way but plain HTTP answers, the server is up and TLS is the problem.
    if (
      targetValidated &&
      !timedOut &&
      !sslError &&
      hops === 0 &&
      (await answersOverHttp(domain, fetchImpl, userAgent, timeoutMs))
    ) {
      sslError = true;
      error = `HTTPS failed but HTTP answers (certificate or TLS problem): ${message}`;
    }
    return {
      ok: false,
      finalUrl: null,
      status: null,
      redirectHops: hops,
      redirectedOtherDomain: false,
      responseTimeMs: Date.now() - t0,
      bodySnippet: "",
      error,
      timedOut,
      sslError,
    };
  }
}

async function answersOverHttp(
  domain: string,
  fetchImpl: typeof globalThis.fetch,
  userAgent: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`http://${domain}/`, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": userAgent },
      signal: AbortSignal.timeout(Math.min(timeoutMs, 5_000)),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.status > 0;
  } catch {
    return false;
  }
}
