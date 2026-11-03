import { waitUntil } from "cloudflare:workers";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { CreditFeature } from "@/shared/billing-credit-features";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { buildRankedKeywordsScopeFilter } from "@/server/lib/dataforseo/researchScopeFilters";
import { joinClauses } from "@/server/lib/dataforseo/filters";
import { parseResearchTargetOrThrow } from "@/server/lib/domainUtils";
import type { ResearchScope } from "@/shared/researchScope";
import { mapKeywordItem } from "@/server/features/domain/services/domainKeywordMapper";
import { getKeywordsPage } from "@/server/features/domain/services/domainKeywordsPage";
import { getPagesPage } from "@/server/features/domain/services/domainPagesPage";
import { requireDataforseoApiKey } from "@/server/lib/dataforseo/config";

type MeteringOverrides = {
  creditFeature?: CreditFeature;
};

const DOMAIN_OVERVIEW_TTL_SECONDS = 12 * 60 * 60;

const domainOverviewResultSchema = z.object({
  domain: z.string(),
  organicTraffic: z.number().nullable(),
  organicKeywords: z.number().nullable(),
  backlinks: z.number().nullable(),
  referringDomains: z.number().nullable(),
  hasData: z.boolean(),
  fetchedAt: z.string(),
});

type DomainOverviewResult = z.infer<typeof domainOverviewResultSchema> & {
  scope: ResearchScope;
  displayTarget: string;
};

async function getOverview(
  input: {
    projectId: string;
    domain: string;
    scope?: ResearchScope;
    locationCode: number;
    languageCode: string;
  },
  billingCustomer: BillingCustomerContext,
  metering: MeteringOverrides = {},
): Promise<DomainOverviewResult> {
  const target = parseResearchTargetOrThrow(input.domain, input.scope);
  const domain = target.hostname;

  const cacheKey = await buildCacheKey("domain:overview:v2", {
    organizationId: billingCustomer.organizationId,
    projectId: input.projectId,
    domain,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
  });

  const cachedRaw = await getCached(cacheKey);
  const cached = domainOverviewResultSchema.safeParse(cachedRaw);
  if (cached.success && cached.data.hasData) {
    return {
      ...cached.data,
      scope: target.scope,
      displayTarget: target.display,
    };
  }

  const nowIso = new Date().toISOString();
  await requireDataforseoApiKey();
  const dataforseo = createDataforseoClient(billingCustomer);
  const metricsResponse = await dataforseo.domain.rankOverview({
    target: domain,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    ...metering,
  });

  const metrics = metricsResponse[0];
  const organicTraffic =
    metrics?.metrics?.organic?.etv != null
      ? Math.round(metrics.metrics.organic.etv)
      : null;
  const organicKeywords =
    metrics?.metrics?.organic?.count != null
      ? Math.round(metrics.metrics.organic.count)
      : null;

  const stored: z.infer<typeof domainOverviewResultSchema> = {
    domain,
    organicTraffic,
    organicKeywords,
    backlinks: null,
    referringDomains: null,
    hasData: organicKeywords != null && organicKeywords > 0,
    fetchedAt: nowIso,
  };

  if (stored.hasData) {
    waitUntil(
      setCached(cacheKey, stored, DOMAIN_OVERVIEW_TTL_SECONDS).catch(
        (error) => {
          console.error("domain.overview.cache-write failed:", error);
        },
      ),
    );
  }

  return { ...stored, scope: target.scope, displayTarget: target.display };
}

async function getSuggestedKeywords(
  input: {
    domain: string;
    scope?: ResearchScope;
    locationCode: number;
    languageCode: string;
    organizationId: string;
    projectId: string;
  },
  billingCustomer: BillingCustomerContext,
  metering: MeteringOverrides = {},
): Promise<
  Array<{
    keyword: string;
    position: number | null;
    searchVolume: number | null;
    traffic: number | null;
    cpc: number | null;
    keywordDifficulty: number | null;
  }>
> {
  const target = parseResearchTargetOrThrow(input.domain, input.scope);
  const scopeFilter = buildRankedKeywordsScopeFilter(target);

  const cacheKey = await buildCacheKey("domain:keyword-suggestions:v2", {
    organizationId: billingCustomer.organizationId,
    projectId: input.projectId,
    domain: target.hostname,
    scope: target.scope,
    path: target.path,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
  });

  const cachedRaw = await getCached(cacheKey);
  const cached = z
    .array(
      z.object({
        keyword: z.string(),
        position: z.number().nullable(),
        searchVolume: z.number().nullable(),
        traffic: z.number().nullable(),
        cpc: z.number().nullable(),
        keywordDifficulty: z.number().nullable(),
      }),
    )
    .safeParse(cachedRaw);
  if (cached.success && cached.data.length > 0) {
    return cached.data;
  }

  await requireDataforseoApiKey();
  const dataforseo = createDataforseoClient(billingCustomer);
  const rankedKeywordsResponse = await dataforseo.domain.rankedKeywords({
    target: target.hostname,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    limit: 100,
    orderBy: ["ranked_serp_element.serp_item.etv,desc"],
    filters:
      scopeFilter.clauses.length > 0
        ? joinClauses(scopeFilter.clauses, "and")
        : undefined,
    ...metering,
  });

  const keywords = rankedKeywordsResponse.items
    .map((item) => mapKeywordItem(item))
    .filter(
      (item): item is NonNullable<ReturnType<typeof mapKeywordItem>> =>
        item != null,
    )
    .map((item) => ({
      keyword: item.keyword,
      position: item.position,
      searchVolume: item.searchVolume,
      traffic: item.traffic,
      cpc: item.cpc,
      keywordDifficulty: item.keywordDifficulty,
    }));

  if (keywords.length > 0) {
    waitUntil(
      setCached(cacheKey, keywords, DOMAIN_OVERVIEW_TTL_SECONDS).catch(
        (error) => {
          console.error(
            "domain.keyword-suggestions.cache-write failed:",
            error,
          );
        },
      ),
    );
  }

  return keywords;
}

export const DomainService = {
  getOverview,
  getSuggestedKeywords,
  getKeywordsPage,
  getPagesPage,
};
