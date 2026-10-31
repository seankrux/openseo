import {
  type AdsKeywordIdeaItem,
  type LabsKeywordDataItem,
} from "@/server/lib/dataforseo";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { CreditFeature } from "@/shared/billing-credit-features";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { requireDataforseoApiKey } from "@/server/lib/dataforseo/config";
import {
  normalizeIntent,
  normalizeKeyword,
  type EnrichedKeyword,
} from "./helpers";
import type { KeywordSource } from "./selection";

type FetchResearchRowsParams = {
  seedKeyword: string;
  locationCode: number;
  languageCode: string;
  resultLimit: number;
  source: KeywordSource;
  includeClickstreamData?: boolean;
  ignoreSynonyms?: boolean;
  creditFeature?: CreditFeature;
};

function mapKeywordDataItems(items: LabsKeywordDataItem[]): EnrichedKeyword[] {
  const rows: EnrichedKeyword[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const keyword = item.keyword;
    if (!keyword) continue;

    const normalized = normalizeKeyword(keyword);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const keywordInfo =
      item.keyword_info_normalized_with_clickstream?.search_volume != null
        ? item.keyword_info_normalized_with_clickstream
        : item.keyword_info;

    rows.push({
      keyword: normalized,
      searchVolume: keywordInfo?.search_volume ?? null,
      trend: (keywordInfo?.monthly_searches ?? []).flatMap((entry) =>
        entry.year != null && entry.month != null && entry.search_volume != null
          ? [
              {
                year: entry.year,
                month: entry.month,
                searchVolume: entry.search_volume,
              },
            ]
          : [],
      ),
      cpc: item.keyword_info?.cpc ?? null,
      competition: item.keyword_info?.competition ?? null,
      keywordDifficulty: item.keyword_properties?.keyword_difficulty ?? null,
      intent: normalizeIntent(item.search_intent_info?.main_intent),
    });
  }

  return rows;
}

export function mapAdsKeywordItems(
  items: AdsKeywordIdeaItem[],
): EnrichedKeyword[] {
  const rows: EnrichedKeyword[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const keyword = item.keyword;
    if (!keyword) continue;

    const normalized = normalizeKeyword(keyword);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    rows.push({
      keyword: normalized,
      searchVolume: item.search_volume ?? null,
      trend: (item.monthly_searches ?? []).flatMap((entry) =>
        entry.year != null && entry.month != null && entry.search_volume != null
          ? [
              {
                year: entry.year,
                month: entry.month,
                searchVolume: entry.search_volume,
              },
            ]
          : [],
      ),
      cpc: item.cpc ?? null,
      competition:
        item.competition_index != null ? item.competition_index / 100 : null,
      keywordDifficulty: null,
      intent: "unknown",
    });
  }

  return rows;
}

export async function fetchGoogleAdsResearchRows(
  params: Omit<FetchResearchRowsParams, "source">,
  billingCustomer: BillingCustomerContext,
): Promise<EnrichedKeyword[]> {
  await requireDataforseoApiKey();
  const dataforseo = createDataforseoClient(billingCustomer);
  return mapAdsKeywordItems(
    await dataforseo.keywords.adsIdeas({
      keyword: params.seedKeyword,
      locationCode: params.locationCode,
      languageCode: params.languageCode,
      limit: params.resultLimit,
      creditFeature: params.creditFeature,
    }),
  );
}

async function fetchRelatedRows(
  params: Omit<FetchResearchRowsParams, "source">,
  dataforseo: ReturnType<typeof createDataforseoClient>,
) {
  const items = await dataforseo.keywords.related({
    keyword: params.seedKeyword,
    locationCode: params.locationCode,
    languageCode: params.languageCode,
    limit: params.resultLimit,
    depth: 3,
    includeClickstreamData: params.includeClickstreamData,
    ignoreSynonyms: params.ignoreSynonyms,
    creditFeature: params.creditFeature,
  });

  return mapKeywordDataItems(
    items
      .map((item) => item.keyword_data)
      .filter((data): data is NonNullable<typeof data> => data != null),
  );
}

export async function fetchResearchRowsBySource(
  params: FetchResearchRowsParams,
  billingCustomer: BillingCustomerContext,
): Promise<EnrichedKeyword[]> {
  await requireDataforseoApiKey();
  const dataforseo = createDataforseoClient(billingCustomer);

  if (params.source === "related") {
    return fetchRelatedRows(params, dataforseo);
  }

  if (params.source === "suggestions") {
    return mapKeywordDataItems(
      await dataforseo.keywords.suggestions({
        keyword: params.seedKeyword,
        locationCode: params.locationCode,
        languageCode: params.languageCode,
        limit: params.resultLimit,
        includeClickstreamData: params.includeClickstreamData,
        ignoreSynonyms: params.ignoreSynonyms,
        creditFeature: params.creditFeature,
      }),
    );
  }

  return mapKeywordDataItems(
    await dataforseo.keywords.ideas({
      keyword: params.seedKeyword,
      locationCode: params.locationCode,
      languageCode: params.languageCode,
      limit: params.resultLimit,
      includeClickstreamData: params.includeClickstreamData,
      ignoreSynonyms: params.ignoreSynonyms,
      creditFeature: params.creditFeature,
    }),
  );
}
