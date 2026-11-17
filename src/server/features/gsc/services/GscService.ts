import { GSC_OAUTH_PROVIDER_ID } from "@/shared/gsc";
import { AppError } from "@/server/lib/errors";
import { listGoogleGrantsForUser } from "@/server/features/google/listGrants";
import {
  createGscClient,
  type GscRequestOptions,
  type GscSite,
  type UrlInspectionResult,
} from "@/server/lib/gscClient";
import {
  GscApiError,
  GscNotConnectedError,
  GscTokenError,
} from "@/server/lib/gscErrors";
export { GscNotConnectedError } from "@/server/lib/gscErrors";
import {
  buildSearchAnalyticsRequest,
  type GscPerformanceInput,
} from "@/server/features/gsc/searchAnalytics";
import {
  GscConnectionRepository,
  type GscConnection,
} from "@/server/features/gsc/repositories/GscConnectionRepository";
import { DashboardCacheService } from "@/server/features/dashboard/services/DashboardCacheService";
import type {
  GscSearchAnalyticsRequest,
  GscSearchAnalyticsRow,
} from "@/server/lib/gscClient";

const SITE_UNVERIFIED_PERMISSION = "siteUnverifiedUser";

type GscPerformanceResult = {
  siteUrl: string;
  connectedBy: string | null;
  request: GscSearchAnalyticsRequest;
  rows: GscSearchAnalyticsRow[];
};

type GscSiteListResult = {
  accounts: Array<{
    accountId: string;
    ownerUserId: string;
    email: string | null;
    requiresReconnect: boolean;
    propertiesUnavailable: boolean;
    apiDisabled: boolean;
    sites: GscSite[];
  }>;
};

/** Thrown when a project has no connected GSC property. */
async function getConnection(projectId: string): Promise<GscConnection | null> {
  return GscConnectionRepository.getByProjectId(projectId);
}

/** Whether this user has linked a google-search-console grant (regardless of
 *  whether they've picked a property yet). Drives the connect-vs-pick UI. */
async function userHasGrant(userId: string): Promise<boolean> {
  const grants = await listGrantsForUser(userId);
  return grants.length > 0;
}

/** The Google accounts a member may pick a property from, including imported
 *  self-host grants on local-admin when running behind the Every App gateway. */
async function listGrantsForUser(userId: string) {
  return listGoogleGrantsForUser(userId, GSC_OAUTH_PROVIDER_ID);
}

/** Expected ways a stored grant fails to reach Search Console: no token could be
 *  minted (refresh token revoked or expired), or Google rejected the call
 *  (401/403). These surface a reconnect prompt without fault logging. */
export function isExpectedGrantFailure(error: unknown): boolean {
  if (error instanceof GscTokenError) return true;
  return (
    error instanceof GscApiError &&
    (error.status === 401 || error.status === 403)
  );
}

async function listSitesForUserWithGrantStatus(
  userId: string,
): Promise<GscSiteListResult> {
  const grants = await listGrantsForUser(userId);
  const accounts = await Promise.all(
    grants.map(async (grant) => {
      const client = createGscClient({
        userId: grant.ownerUserId,
        gscAccountId: grant.accountId,
      });

      try {
        const sites = await client.listSites();
        let email: string | null = null;
        try {
          email = await client.getUserInfoEmail();
        } catch {
          email = null;
        }
        return {
          accountId: grant.accountId,
          ownerUserId: grant.ownerUserId,
          email,
          requiresReconnect: false,
          propertiesUnavailable: false,
          apiDisabled: false,
          sites,
        };
      } catch (error) {
        // A disabled API is a self-host setup fault, not a dead grant:
        // reconnecting can't fix it, so log it and show the setup message.
        const apiDisabled = error instanceof GscApiError && error.apiDisabled;
        const requiresReconnect = isExpectedGrantFailure(error) && !apiDisabled;
        if (!requiresReconnect) {
          console.error(
            "Failed to list Search Console sites for account",
            grant.accountId,
            error,
          );
        }
        return {
          accountId: grant.accountId,
          ownerUserId: grant.ownerUserId,
          email: null,
          requiresReconnect,
          propertiesUnavailable: !requiresReconnect,
          apiDisabled,
          sites: [],
        };
      }
    }),
  );
  return { accounts };
}

/** Map a verified property to a project. Rejects unverified properties and
 *  properties not present on the connector's grant. */
async function setSite(input: {
  projectId: string;
  organizationId: string;
  siteUrl: string;
  accountId: string;
  userId: string;
}): Promise<GscConnection> {
  const grants = await listGrantsForUser(input.userId);
  const grant = grants.find((row) => row.accountId === input.accountId);
  if (!grant) {
    throw new AppError(
      "NOT_FOUND",
      "That Google account isn't connected to your OpenSEO account.",
    );
  }

  const client = createGscClient({
    userId: grant.ownerUserId,
    gscAccountId: grant.accountId,
  });
  const sites = await client.listSites();
  const match = sites.find((s) => s.siteUrl === input.siteUrl);
  if (!match) {
    throw new AppError(
      "NOT_FOUND",
      "That Search Console property isn't available on your connected Google account.",
    );
  }
  if (match.permissionLevel === SITE_UNVERIFIED_PERMISSION) {
    throw new AppError(
      "FORBIDDEN",
      "You don't have verified access to that Search Console property.",
    );
  }
  let connectedAccountEmail: string | null = null;
  try {
    connectedAccountEmail = await client.getUserInfoEmail();
  } catch {
    connectedAccountEmail = null;
  }
  return GscConnectionRepository.upsert({
    projectId: input.projectId,
    organizationId: input.organizationId,
    siteUrl: input.siteUrl,
    connectedByUserId: grant.ownerUserId,
    gscAccountId: grant.accountId,
    connectedAccountEmail,
  });
}

async function disconnect(input: { projectId: string }): Promise<void> {
  await GscConnectionRepository.deleteByProjectId(input.projectId);
  await DashboardCacheService.deleteGscCache(input.projectId);
}

/** Pass-through of GSC `searchAnalytics.query` for a project's connected property. */
async function getPerformance(
  input: GscPerformanceInput,
  options?: GscRequestOptions,
): Promise<GscPerformanceResult> {
  const connection = await GscConnectionRepository.getByProjectId(
    input.projectId,
  );
  if (!connection) {
    throw new GscNotConnectedError(input.projectId);
  }
  const request = buildSearchAnalyticsRequest(input);
  // The MCP input schema caps tool responses at 1,000; app consumers may
  // request Google's full page to compare low-click keywords accurately.
  if (input.rowLimit !== undefined)
    request.rowLimit = Math.max(1, Math.min(25000, input.rowLimit));

  const client = createGscClient({
    ...options,
    userId: connection.connectedByUserId,
    gscAccountId: connection.gscAccountId ?? undefined,
  });
  const rows = await client.querySearchAnalytics(connection.siteUrl, request);
  return {
    siteUrl: connection.siteUrl,
    connectedBy: connection.connectedAccountEmail,
    request,
    rows,
  };
}

type GscUrlInspection = {
  url: string;
  result: UrlInspectionResult | null;
  error?: string;
};

type GscInspectUrlsResult = {
  siteUrl: string;
  connectedBy: string | null;
  results: GscUrlInspection[];
};

/** A Worker opens at most 6 outbound connections at once and queues the
 *  rest, so a wider fan-out only makes the extra inspections wait. */
const INSPECT_CONCURRENCY = 5;

/** Inspect 1–N URLs against a project's connected property. Resolves the
 *  connection once, then inspects up to INSPECT_CONCURRENCY URLs at a time:
 *  Google answers each inspection in ~6 s, so a serial batch of ten held the
 *  request open for a minute and made it the usual casualty whenever its
 *  isolate ran out of memory. Per-URL failures are captured inline so one bad
 *  URL doesn't fail the batch. Token/grant failures propagate so the caller
 *  can prompt a reconnect. */
async function inspectUrls(input: {
  projectId: string;
  urls: string[];
  languageCode?: string;
}): Promise<GscInspectUrlsResult> {
  const connection = await GscConnectionRepository.getByProjectId(
    input.projectId,
  );
  if (!connection) {
    throw new GscNotConnectedError(input.projectId);
  }
  const client = createGscClient({
    userId: connection.connectedByUserId,
    gscAccountId: connection.gscAccountId ?? undefined,
  });
  const results: GscUrlInspection[] = [];
  let next = 0;
  const worker = async () => {
    while (next < input.urls.length) {
      const index = next++;
      const url = input.urls[index];
      try {
        const result = await client.inspectUrl(
          connection.siteUrl,
          url,
          input.languageCode,
        );
        results[index] = { url, result };
      } catch (error) {
        if (error instanceof GscTokenError) throw error;
        results[index] = {
          url,
          result: null,
          error: error instanceof Error ? error.message : "Inspection failed",
        };
      }
    }
  };
  await Promise.all(Array.from({ length: INSPECT_CONCURRENCY }, worker));
  return {
    siteUrl: connection.siteUrl,
    connectedBy: connection.connectedAccountEmail,
    results,
  };
}

export const GscService = {
  getConnection,
  userHasGrant,
  listSitesForUserWithGrantStatus,
  setSite,
  disconnect,
  getPerformance,
  inspectUrls,
};
