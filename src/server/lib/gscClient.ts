import { getGoogleAccessToken } from "@/server/features/google/googleOAuth";
import { GSC_OAUTH_PROVIDER_ID } from "@/shared/gsc";
import {
  GscApiError,
  GscTokenError,
  classifyGscError,
  GSC_API_DISABLED_MESSAGE,
} from "./gscErrors";

const REQUEST_TIMEOUT_MS = 30_000;
const OPERATION_TIMEOUT_MS = 65_000;

export type GscRequestOptions = {
  signal?: AbortSignal;
  /** Reserve one additional provider call from the caller's shared budget. */
  reserveRetry?: () => boolean;
};

export { GscApiError, GscTokenError } from "./gscErrors";

const GSC_API_BASE = "https://www.googleapis.com/webmasters/v3";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

/** A GSC REST call returned a non-2xx status. `status` drives user-facing messaging. */
export type GscSite = {
  siteUrl: string;
  permissionLevel: string;
};

export type GscSearchAnalyticsRow = {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type GscDimensionFilter = {
  dimension: string;
  operator: string;
  expression: string;
};

export type GscSearchAnalyticsRequest = {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  dimensionFilterGroups?: Array<{
    groupType: "and" | "or";
    filters: GscDimensionFilter[];
  }>;
  rowLimit?: number;
  startRow?: number;
  type?: string;
  dataState?: string;
  aggregationType?: string;
};

/** Subset of the URL Inspection API `inspectionResult` we surface. The wire
 *  shape is richer; extra fields are ignored. */
export type UrlInspectionResult = {
  indexStatusResult?: {
    verdict?: string;
    coverageState?: string;
    robotsTxtState?: string;
    indexingState?: string;
    lastCrawlTime?: string;
    pageFetchState?: string;
    googleCanonical?: string;
    userCanonical?: string;
    crawledAs?: string;
    sitemap?: string[];
    referringUrls?: string[];
  };
  mobileUsabilityResult?: { verdict?: string };
  richResultsResult?: { verdict?: string };
  inspectionResultLink?: string;
};

function messageForStatus(status: number, body: string): string {
  if (status === 401)
    return "Search Console connection expired or was revoked.";
  if (status === 403) {
    if (body.includes("SERVICE_DISABLED")) return GSC_API_DISABLED_MESSAGE;
    if (/quota|rate.?limit|resource_exhausted/i.test(body))
      return "Search Console quota or rate limit reached. Waiting before retry.";
    return "Search Console denied access to this property. Check verified property permissions.";
  }
  if (status === 429) {
    return "Search Console rate limit reached. Retry shortly.";
  }
  if (status === 404) {
    return "Search Console property not found. It may have been removed in Search Console.";
  }
  return `Search Console API error (${status}): ${body.slice(0, 300)}`;
}

/** Free Google Search Console client. Unlike the DataForSEO client it does NOT
 *  meter credits — GSC is first-party data with no per-call cost. Access tokens
 *  come from (and are auto-refreshed against) the connector's stored
 *  google-search-console grant. */
export function createGscClient(
  opts: {
    userId: string;
    gscAccountId?: string;
  } & GscRequestOptions,
) {
  async function getToken(signal: AbortSignal): Promise<string> {
    try {
      return await getGoogleAccessToken({
        providerId: GSC_OAUTH_PROVIDER_ID,
        userId: opts.userId,
        accountId: opts.gscAccountId,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (classifyGscError(error) !== "auth") throw error;
      throw new GscTokenError(
        "Could not mint a Search Console access token (grant revoked or expired).",
        error,
      );
    }
  }

  async function request<T>(
    url: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(OPERATION_TIMEOUT_MS),
      ...(opts.signal ? [opts.signal] : []),
    ]);
    signal.throwIfAborted();
    const token = await getToken(signal);
    const hasBody = init?.body !== undefined;
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        const response = await fetch(url, {
          method: init?.method ?? "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            ...(hasBody ? { "Content-Type": "application/json" } : {}),
          },
          body: hasBody ? JSON.stringify(init?.body) : undefined,
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ]),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new GscApiError(
            response.status,
            messageForStatus(response.status, body),
            body,
          );
        }
        const result = (await response.json()) as T;
        signal.throwIfAborted();
        return result;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        // Every method exposed by this client is a read, including Google's
        // POST searchAnalytics/query and URL inspection endpoints. Never retry
        // quota, permission, malformed-response or rejected-grant failures.
        if (
          attempt > 0 ||
          classifyGscError(error) !== "transient" ||
          opts.reserveRetry?.() === false
        )
          throw error;
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, 250);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    }
  }

  return {
    async getUserInfoEmail(): Promise<string | null> {
      const data = await request<{ email?: unknown }>(GOOGLE_USERINFO_URL);
      return typeof data.email === "string" ? data.email : null;
    },

    /** Webmasters API `sites.list` — the verified properties on the grant. */
    async listSites(): Promise<GscSite[]> {
      const data = await request<{ siteEntry?: GscSite[] }>(
        `${GSC_API_BASE}/sites`,
      );
      return data.siteEntry ?? [];
    },

    /** Webmasters API `searchAnalytics.query`. siteUrl is used verbatim. */
    async querySearchAnalytics(
      siteUrl: string,
      body: GscSearchAnalyticsRequest,
    ): Promise<GscSearchAnalyticsRow[]> {
      const data = await request<{ rows?: GscSearchAnalyticsRow[] }>(
        `${GSC_API_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        { method: "POST", body },
      );
      return data.rows ?? [];
    },

    /** URL Inspection API `urlInspection.index.inspect`. This lives on a
     *  different host than the Webmasters v3 base, so the full URL is passed to
     *  the request helper. Same `webmasters.readonly` scope. */
    async inspectUrl(
      siteUrl: string,
      inspectionUrl: string,
      languageCode?: string,
    ): Promise<UrlInspectionResult | null> {
      const data = await request<{ inspectionResult?: UrlInspectionResult }>(
        "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
        {
          method: "POST",
          body: {
            siteUrl,
            inspectionUrl,
            ...(languageCode ? { languageCode } : {}),
          },
        },
      );
      return data.inspectionResult ?? null;
    },
  };
}
