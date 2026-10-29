import { classifyDomainHealth } from "./classify";
import { detectAnalyticsTags } from "./detect-tags";
import { isPrivateAddress, resolveDomainDns } from "./dns";
import { fetchHttpsRoot } from "./https-check";
import type {
  CheckDomainHealthOptions,
  DomainHealthResult,
  SslInfo,
} from "./types";

function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.split("/")[0] ?? d;
  d = d.split("?")[0] ?? d;
  d = d.replace(/\.$/, "");
  return d;
}

/**
 * Check one domain: DoH DNS (A/AAAA/NS + Cloudflare), HTTPS root GET with
 * redirects, parked/default-host/CF-error detection, GA4/GTM tag scrape, and
 * optional SSL expiry probe.
 */
export async function checkDomainHealth(
  domainInput: string,
  options: CheckDomainHealthOptions = {},
): Promise<DomainHealthResult> {
  const domain = normalizeDomain(domainInput);
  const checkedAt = new Date().toISOString();
  const timeoutMs = options.timeoutMs ?? 12_000;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    return emptyFail(domain || domainInput, "dns_fail", "Invalid domain", checkedAt);
  }

  const dns = await resolveDomainDns(domain, {
    fetch: fetchImpl,
    timeoutMs: Math.min(timeoutMs, 5_000),
  });

  if (!dns.ok) {
    return {
      domain,
      class: "dns_fail",
      httpStatus: null,
      finalUrl: null,
      redirectHops: 0,
      redirectedOtherDomain: false,
      responseTimeMs: null,
      dnsOk: false,
      aRecords: dns.a,
      aaaaRecords: dns.aaaa,
      nsRecords: dns.ns,
      onCloudflare: dns.onCloudflare,
      sslValid: null,
      sslExpiresAt: null,
      sslDaysRemaining: null,
      parked: false,
      defaultHostPage: false,
      ga4Ids: [],
      gtmIds: [],
      error: dns.error,
      checkedAt,
    };
  }

  // Never fetch an internal address: a public name pointing (even partly) at a private,
  // loopback or tailnet IP is reported instead of requested.
  const addrs = [...dns.a, ...dns.aaaa];
  if (addrs.some(isPrivateAddress)) {
    return {
      ...emptyFail(domain, "dns_fail", "Resolves to a private or reserved address", checkedAt),
      dnsOk: true,
      aRecords: dns.a,
      aaaaRecords: dns.aaaa,
      nsRecords: dns.ns,
      onCloudflare: dns.onCloudflare,
    };
  }

  const https = await fetchHttpsRoot(domain, {
    fetch: fetchImpl,
    timeoutMs,
    maxRedirects: options.maxRedirects,
    maxBodyBytes: options.maxBodyBytes,
    userAgent: options.userAgent,
  });

  const { class: healthClass, parked, defaultHostPage } = classifyDomainHealth({
    dns,
    https,
  });

  const tags = detectAnalyticsTags(https.bodySnippet);

  let ssl: SslInfo = {
    valid: null,
    expiresAt: null,
    daysRemaining: null,
    error: null,
  };
  if (options.probeSsl && !https.sslError && !https.timedOut) {
    try {
      ssl = await options.probeSsl(domain, Math.min(timeoutMs, 8_000));
    } catch (err) {
      ssl = {
        valid: null,
        expiresAt: null,
        daysRemaining: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // SSL probe can upgrade classification when HTTPS fetch looked fine but cert is bad.
  let finalClass = healthClass;
  if (
    finalClass === "live_ok" &&
    ssl.valid === false &&
    (ssl.daysRemaining == null || ssl.daysRemaining < 0)
  ) {
    finalClass = "ssl_error";
  }

  return {
    domain,
    class: finalClass,
    httpStatus: https.status,
    finalUrl: https.finalUrl,
    redirectHops: https.redirectHops,
    redirectedOtherDomain: https.redirectedOtherDomain,
    responseTimeMs: https.responseTimeMs,
    dnsOk: true,
    aRecords: dns.a,
    aaaaRecords: dns.aaaa,
    nsRecords: dns.ns,
    onCloudflare: dns.onCloudflare,
    sslValid: ssl.valid,
    sslExpiresAt: ssl.expiresAt,
    sslDaysRemaining: ssl.daysRemaining,
    parked,
    defaultHostPage,
    ga4Ids: tags.ga4Ids,
    gtmIds: tags.gtmIds,
    error: https.error ?? ssl.error,
    checkedAt,
  };
}

function emptyFail(
  domain: string,
  healthClass: DomainHealthResult["class"],
  error: string,
  checkedAt: string,
): DomainHealthResult {
  return {
    domain,
    class: healthClass,
    httpStatus: null,
    finalUrl: null,
    redirectHops: 0,
    redirectedOtherDomain: false,
    responseTimeMs: null,
    dnsOk: false,
    aRecords: [],
    aaaaRecords: [],
    nsRecords: [],
    onCloudflare: false,
    sslValid: null,
    sslExpiresAt: null,
    sslDaysRemaining: null,
    parked: false,
    defaultHostPage: false,
    ga4Ids: [],
    gtmIds: [],
    error,
    checkedAt,
  };
}
