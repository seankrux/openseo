/** Classification of a single domain health check. */
export const DOMAIN_HEALTH_CLASSES = [
  "live_ok",
  "redirect_other_domain",
  "redirect_intended",
  "parked",
  "dns_fail",
  "http_error",
  "ssl_error",
  "timeout",
  "cf_error",
] as const;

export type DomainHealthClass = (typeof DOMAIN_HEALTH_CLASSES)[number];

export type DomainHealthStatusChangeKind =
  | "went_down"
  | "came_back"
  | "ssl_expiring_soon"
  | "ga4_tag_removed"
  | "gtm_tag_removed"
  | "class_changed";

export interface DnsResult {
  ok: boolean;
  a: string[];
  aaaa: string[];
  ns: string[];
  onCloudflare: boolean;
  error: string | null;
}

export interface HttpsResult {
  ok: boolean;
  finalUrl: string | null;
  status: number | null;
  redirectHops: number;
  redirectedOtherDomain: boolean;
  responseTimeMs: number | null;
  bodySnippet: string;
  error: string | null;
  timedOut: boolean;
  sslError: boolean;
}

export interface SslInfo {
  valid: boolean | null;
  expiresAt: string | null;
  daysRemaining: number | null;
  error: string | null;
}

export interface TagDetection {
  ga4Ids: string[];
  gtmIds: string[];
}

export interface DomainHealthResult {
  domain: string;
  class: DomainHealthClass;
  /** Present when class is http_error or cf_error. */
  httpStatus: number | null;
  finalUrl: string | null;
  redirectHops: number;
  redirectedOtherDomain: boolean;
  responseTimeMs: number | null;
  dnsOk: boolean;
  aRecords: string[];
  aaaaRecords: string[];
  nsRecords: string[];
  onCloudflare: boolean;
  sslValid: boolean | null;
  sslExpiresAt: string | null;
  sslDaysRemaining: number | null;
  parked: boolean;
  defaultHostPage: boolean;
  ga4Ids: string[];
  gtmIds: string[];
  error: string | null;
  checkedAt: string;
}

export interface CheckDomainHealthOptions {
  /** HTTPS / DNS timeout in ms (default 12_000). */
  timeoutMs?: number;
  /** Max redirect hops to follow (default 8). */
  maxRedirects?: number;
  /** Bytes of HTML to read for tag/parked detection (default 200_000). */
  maxBodyBytes?: number;
  /** User-Agent for HTTPS GETs. */
  userAgent?: string;
  /** Injected fetch (defaults to global fetch). */
  fetch?: typeof globalThis.fetch;
  /**
   * Optional SSL peer-cert probe. Workers cannot read peer certs from fetch;
   * the Node CLI supplies one via tls.connect. When omitted, ssl* fields are null.
   */
  probeSsl?: (hostname: string, timeoutMs: number) => Promise<SslInfo>;
  /** Skip RDAP/WHOIS (always skipped when slow; reserved for future). */
  skipRdap?: boolean;
}

export interface CheckBatchOptions extends CheckDomainHealthOptions {
  /** Concurrent checks (default 20). Keep low on small boxes. */
  concurrency?: number;
  onProgress?: (done: number, total: number, latest: DomainHealthResult) => void;
}
