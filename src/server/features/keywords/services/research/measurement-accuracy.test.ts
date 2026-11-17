import { beforeEach, describe, expect, it, vi } from "vitest";
import { research } from "./research";
import { fetchGoogleAdsResearchRows } from "./research-data";
import { refreshSavedKeywordMetrics } from "./refresh-metrics";

const mocks = vi.hoisted(() => ({
  key: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  persist: vi.fn(),
  saved: vi.fn(),
  ideas: vi.fn(),
  adsIdeas: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
vi.mock("@/server/lib/runtime-env", () => ({ getRequiredEnvValue: mocks.key }));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({
    keywords: { ideas: mocks.ideas, adsIdeas: mocks.adsIdeas },
  }),
  fetchKeywordMetricsForList: vi.fn(),
}));
vi.mock("@/server/lib/r2-cache", () => ({
  CACHE_TTL: { researchResult: 86400 },
  buildCacheKey: async (namespace: string, params: unknown) =>
    `${namespace}:${JSON.stringify(params)}`,
  getCached: mocks.read,
  setCached: mocks.write,
}));
vi.mock(
  "@/server/features/keywords/repositories/KeywordResearchRepository",
  () => ({
    KeywordResearchRepository: {
      upsertKeywordMetric: mocks.persist,
      listSavedKeywordsByProject: mocks.saved,
    },
  }),
);

const customer = {
  organizationId: "org",
  userId: "user",
  userEmail: "user@example.com",
};
const input = {
  projectId: "project",
  keywords: ["seed"],
  locationCode: 2840,
  languageCode: "en",
  resultLimit: 150 as const,
  mode: "ideas" as const,
  clickstream: false,
  groupKeywords: false,
};

beforeEach(() => {
  mocks.key.mockResolvedValue("configured-key");
  mocks.read.mockResolvedValue(null);
  mocks.write.mockResolvedValue(undefined);
  mocks.persist.mockResolvedValue(undefined);
  mocks.saved.mockResolvedValue({ rows: [] });
  mocks.ideas.mockResolvedValue([]);
  mocks.adsIdeas.mockResolvedValue([]);
});

describe("keyword research measurement accuracy", () => {
  it("rejects missing provider configuration without inventing, persisting or caching metrics", async () => {
    mocks.key.mockRejectedValue(
      new Error("Missing required environment variable: DATAFORSEO_API_KEY"),
    );

    await expect(research(input, customer)).rejects.toMatchObject({
      code: "DATAFORSEO_NOT_CONFIGURED",
    });

    expect(mocks.ideas).not.toHaveBeenCalled();
    expect(mocks.adsIdeas).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("retires cached proxy metrics while retaining the measured research contract", async () => {
    mocks.read.mockImplementation(async (key: string) =>
      key.includes('"cacheVersion":5')
        ? {
            rows: [
              {
                keyword: "seed",
                searchVolume: 1200,
                cpc: 2.5,
                competition: 0.6,
                keywordDifficulty: 45,
                trend: [],
                intent: "commercial",
              },
            ],
            source: "ideas",
            usedFallback: false,
          }
        : null,
    );
    mocks.ideas.mockResolvedValue([
      {
        keyword: "seed",
        keyword_info: { search_volume: 0, cpc: 0, competition: 0 },
        keyword_properties: { keyword_difficulty: 0 },
      },
    ]);

    const result = await research(input, customer);

    expect(result.rows[0]).toMatchObject({
      searchVolume: 0,
      cpc: 0,
      competition: 0,
      keywordDifficulty: 0,
    });
    expect(mocks.ideas).toHaveBeenCalledOnce();
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        searchVolume: 0,
        cpc: 0,
        competition: 0,
        keywordDifficulty: 0,
      }),
    );
    expect(mocks.write).toHaveBeenCalledWith(
      expect.stringContaining('"cacheVersion":6'),
      result,
      expect.any(Number),
    );
  });

  it("preserves a measured clickstream zero and omits unavailable monthly observations", async () => {
    mocks.ideas.mockResolvedValue([
      {
        keyword: "zero clickstream",
        keyword_info: { search_volume: 100 },
        keyword_info_normalized_with_clickstream: {
          search_volume: 0,
          monthly_searches: [
            { year: 2026, month: 1, search_volume: 0 },
            { year: 2026, month: 2 },
          ],
        },
      },
      { keyword: "unknown metrics" },
    ]);

    const result = await research({ ...input, clickstream: true }, customer);

    expect(result.rows).toEqual([
      {
        keyword: "zero clickstream",
        searchVolume: 0,
        trend: [{ year: 2026, month: 1, searchVolume: 0 }],
        cpc: null,
        competition: null,
        keywordDifficulty: null,
        intent: "unknown",
      },
      {
        keyword: "unknown metrics",
        searchVolume: null,
        trend: [],
        cpc: null,
        competition: null,
        keywordDifficulty: null,
        intent: "unknown",
      },
    ]);
  });

  it("preserves Google Ads zero and keeps missing metrics unavailable", async () => {
    mocks.adsIdeas.mockResolvedValue([
      {
        keyword: "zero",
        search_volume: 0,
        cpc: 0,
        competition_index: 0,
        monthly_searches: [
          { year: 2026, month: 1, search_volume: 0 },
          { year: 2026, month: 2 },
        ],
      },
      { keyword: "unknown" },
    ]);
    const rows = await fetchGoogleAdsResearchRows(
      {
        seedKeyword: "seed",
        locationCode: 2840,
        languageCode: "en",
        resultLimit: 150,
      },
      customer,
    );
    expect(rows).toMatchObject([
      {
        keyword: "zero",
        searchVolume: 0,
        cpc: 0,
        competition: 0,
        trend: [{ year: 2026, month: 1, searchVolume: 0 }],
      },
      {
        keyword: "unknown",
        searchVolume: null,
        cpc: null,
        competition: null,
        trend: [],
      },
    ]);
  });

  it("reports unavailable refresh metrics rather than a successful zero update", async () => {
    mocks.saved.mockResolvedValue({
      rows: [
        { row: { keyword: "seed", locationCode: 2840, languageCode: "en" } },
      ],
    });
    mocks.key.mockRejectedValue(
      new Error("Missing required environment variable: DATAFORSEO_API_KEY"),
    );
    await expect(
      refreshSavedKeywordMetrics({ projectId: "project" }, customer),
    ).rejects.toMatchObject({ code: "DATAFORSEO_NOT_CONFIGURED" });
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("can report zero refresh updates for an actually empty saved-keyword list", async () => {
    await expect(
      refreshSavedKeywordMetrics({ projectId: "project" }, customer),
    ).resolves.toEqual({ updated: 0 });
    expect(mocks.key).not.toHaveBeenCalled();
  });
});
