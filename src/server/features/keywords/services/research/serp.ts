import { waitUntil } from "cloudflare:workers";
import {
  SERP_ANALYSIS_DEPTH,
  type SerpLiveItem,
} from "@/server/lib/dataforseo";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import type { SerpResultItem } from "@/types/keywords";
import { z } from "zod";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { requireDataforseoApiKey } from "@/server/lib/dataforseo/config";
import { normalizeKeyword } from "./helpers";
import { assertLocalResearchLocation } from "./local-volume";

const SERP_CACHE_TTL_SECONDS = 12 * 60 * 60;

type SerpAnalysisReason = "no_organic_results";

type SerpAnalysisResult = {
  requestedKeyword: string;
  items: SerpResultItem[];
  depth: number;
  reason?: SerpAnalysisReason;
};

const serpResultItemSchema = z.object({
  rank: z.number().int(),
  title: z.string(),
  url: z.string(),
  domain: z.string(),
  description: z.string(),
  etv: z.number().nullable(),
  estimatedPaidTrafficCost: z.number().nullable(),
  referringDomains: z.number().nullable(),
  backlinks: z.number().nullable(),
  isNew: z.boolean(),
  rankChange: z.number().nullable(),
});

const serpCacheSchema = z.object({
  requestedKeyword: z.string(),
  items: z.array(serpResultItemSchema),
  depth: z.number().int().default(SERP_ANALYSIS_DEPTH),
  reason: z.enum(["no_organic_results"]).optional(),
});

function mapOrganicSerpItems(items: SerpLiveItem[]): SerpResultItem[] {
  return items.flatMap((item) => {
    const rank = item.rank_group ?? item.rank_absolute;
    if (item.type !== "organic" || rank == null || !item.url) return [];
    return [
      {
        rank,
        title: item.title ?? "",
        url: item.url,
        domain: item.domain ?? "",
        description: item.description ?? "",
        etv: item.etv ?? null,
        estimatedPaidTrafficCost: item.estimated_paid_traffic_cost ?? null,
        referringDomains: item.backlinks_info?.referring_domains ?? null,
        backlinks: item.backlinks_info?.backlinks ?? null,
        isNew: false,
        rankChange: null,
      },
    ];
  });
}

async function getSerpLiveAnalysis(
  input: {
    projectId: string;
    keyword: string;
    locationCode: number;
    languageCode: string;
    depth: number;
    locationName?: string;
  },
  billingCustomer: BillingCustomerContext,
): Promise<SerpAnalysisResult> {
  const keyword = normalizeKeyword(input.keyword);
  const { depth } = input;
  if (input.locationName) {
    await assertLocalResearchLocation(input.locationCode, input.locationName);
  }

  const cacheKey = await buildCacheKey("serp:analysis:v2", {
    organizationId: billingCustomer.organizationId,
    projectId: input.projectId,
    keyword,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    locationName: input.locationName,
  });

  const cachedRaw = await getCached(cacheKey);
  const cached = serpCacheSchema.safeParse(cachedRaw);
  if (cached.success && cached.data.depth >= depth) {
    return cached.data;
  }

  await requireDataforseoApiKey();
  const liveItems = await createDataforseoClient(billingCustomer).serp.live({
    keyword,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    locationName: input.locationName,
    depth,
  });

  const items = mapOrganicSerpItems(liveItems);
  const result: SerpAnalysisResult = {
    requestedKeyword: keyword,
    items,
    depth,
  };
  if (items.length === 0) {
    result.reason = "no_organic_results";
  }

  if (items.length === 0 && cached.success && cached.data.items.length > 0) {
    return result;
  }

  waitUntil(
    setCached(cacheKey, result, SERP_CACHE_TTL_SECONDS).catch((error) => {
      console.error("keywords.serp.cache-write failed:", error);
    }),
  );

  return result;
}

export const getSerpAnalysis = getSerpLiveAnalysis;
