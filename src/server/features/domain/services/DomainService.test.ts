import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainService } from "./DomainService";

const mocks = vi.hoisted(() => ({
  key: vi.fn(),
  getCached: vi.fn(),
  setCached: vi.fn(),
  rankOverview: vi.fn(),
  rankedKeywords: vi.fn(),
  relevantPages: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ waitUntil: vi.fn() }));
vi.mock("@/server/lib/runtime-env", () => ({ getRequiredEnvValue: mocks.key }));
vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: async (namespace: string, params: unknown) =>
    `${namespace}:${JSON.stringify(params)}`,
  getCached: mocks.getCached,
  setCached: mocks.setCached,
}));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({
    domain: {
      rankOverview: mocks.rankOverview,
      rankedKeywords: mocks.rankedKeywords,
      relevantPages: mocks.relevantPages,
    },
  }),
}));

const customer = {
  organizationId: "org",
  userId: "user",
  userEmail: "user@example.com",
};
const input = {
  projectId: "project",
  domain: "example.com",
  scope: "domain" as const,
  locationCode: 2840,
  languageCode: "en",
};
const pageInput = {
  ...input,
  page: 1,
  pageSize: 50,
  sortMode: "traffic" as const,
  sortOrder: "desc" as const,
  filters: {},
};

beforeEach(() => {
  mocks.key.mockResolvedValue("configured-key");
  mocks.getCached.mockResolvedValue(null);
  mocks.setCached.mockResolvedValue(undefined);
  mocks.rankOverview.mockResolvedValue([]);
  mocks.rankedKeywords.mockResolvedValue({ items: [], totalCount: 0 });
  mocks.relevantPages.mockResolvedValue({ items: [], totalCount: 0 });
});

describe("measured domain analytics", () => {
  const requests = [
    [
      "overview",
      () => DomainService.getOverview(input, customer),
      "domain:overview:v2:",
    ],
    [
      "suggested keywords",
      () =>
        DomainService.getSuggestedKeywords(
          { ...input, organizationId: customer.organizationId },
          customer,
        ),
      "domain:keyword-suggestions:v2:",
    ],
    [
      "keyword page",
      () => DomainService.getKeywordsPage(pageInput, customer),
      "domain:keywords-page:v2:",
    ],
    [
      "pages",
      () => DomainService.getPagesPage(pageInput, customer),
      "domain:pages-page:v2:",
    ],
  ] as const;

  it.each(requests)(
    "requires a measured provider for %s and ignores retired fallback caches",
    async (_label, request, namespace) => {
      mocks.key.mockRejectedValue(
        new Error("Missing required environment variable: DATAFORSEO_API_KEY"),
      );
      // A valid-looking result in a retired namespace must not become evidence.
      mocks.getCached.mockImplementation(async (key: string) =>
        key.includes(":v2:")
          ? null
          : {
              domain: "example.com",
              organicTraffic: 250,
              organicKeywords: 45,
              hasData: true,
              backlinks: null,
              referringDomains: null,
              fetchedAt: "2026-01-01T00:00:00.000Z",
            },
      );

      await expect(request()).rejects.toMatchObject({
        code: "DATAFORSEO_NOT_CONFIGURED",
      });

      expect(mocks.getCached).toHaveBeenCalledWith(
        expect.stringContaining(namespace),
      );
      expect(mocks.rankOverview).not.toHaveBeenCalled();
      expect(mocks.rankedKeywords).not.toHaveBeenCalled();
      expect(mocks.relevantPages).not.toHaveBeenCalled();
      expect(mocks.setCached).not.toHaveBeenCalled();
    },
  );

  it("distinguishes observed zero overview metrics from unavailable metrics", async () => {
    mocks.rankOverview.mockResolvedValueOnce([
      { metrics: { organic: { etv: 0, count: 0 } } },
    ]);
    expect(await DomainService.getOverview(input, customer)).toMatchObject({
      organicTraffic: 0,
      organicKeywords: 0,
      hasData: false,
    });

    mocks.rankOverview.mockResolvedValueOnce([]);
    expect(await DomainService.getOverview(input, customer)).toMatchObject({
      organicTraffic: null,
      organicKeywords: null,
      hasData: false,
    });
  });

  it("preserves measured zero keyword metrics and leaves unobserved ranks and URLs unavailable", async () => {
    mocks.rankedKeywords.mockResolvedValue({
      totalCount: 2,
      items: [
        {
          keyword_data: {
            keyword: "observed zero",
            keyword_info: { search_volume: 0, cpc: 0 },
            keyword_properties: { keyword_difficulty: 0 },
          },
          ranked_serp_element: {
            serp_item: {
              rank_absolute: 1,
              etv: 0,
              url: "https://example.com/observed",
            },
          },
        },
        { keyword_data: { keyword: "unavailable metrics" } },
      ],
    });

    const result = await DomainService.getKeywordsPage(pageInput, customer);

    expect(result.keywords).toEqual([
      {
        keyword: "observed zero",
        position: 1,
        searchVolume: 0,
        traffic: 0,
        cpc: 0,
        keywordDifficulty: 0,
        url: "https://example.com/observed",
        relativeUrl: "/observed",
      },
      {
        keyword: "unavailable metrics",
        position: null,
        searchVolume: null,
        traffic: null,
        cpc: null,
        keywordDifficulty: null,
        url: null,
        relativeUrl: null,
      },
    ]);
    expect(result).toMatchObject({ totalCount: 2, hasMore: false });
  });

  it("preserves measured zero page metrics, skips missing URLs, and keeps absent metrics unavailable", async () => {
    mocks.relevantPages.mockResolvedValue({
      totalCount: 3,
      items: [
        {
          page_address: "https://example.com/zero",
          metrics: { organic: { etv: 0, count: 0 } },
        },
        { page_address: "https://example.com/unknown" },
        { metrics: { organic: { etv: 100, count: 15 } } },
      ],
    });

    const result = await DomainService.getPagesPage(pageInput, customer);

    expect(result.pages).toEqual([
      {
        page: "https://example.com/zero",
        relativePath: "/zero",
        organicTraffic: 0,
        keywords: 0,
      },
      {
        page: "https://example.com/unknown",
        relativePath: "/unknown",
        organicTraffic: null,
        keywords: null,
      },
    ]);
  });

  it("preserves scoped filters, search, sorting and offsets at the provider boundary", async () => {
    await DomainService.getKeywordsPage(
      {
        ...pageInput,
        domain: "https://example.com/services/",
        scope: "subfolder",
        page: 2,
        pageSize: 25,
        search: "repair",
        filters: { minVol: 0 },
      },
      customer,
    );

    expect(mocks.rankedKeywords).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "example.com",
        offset: 25,
        limit: 25,
        orderBy: ["ranked_serp_element.serp_item.etv,desc"],
      }),
    );
    const request: unknown = mocks.rankedKeywords.mock.calls[0]?.[0];
    expect(request).toHaveProperty(
      "filters",
      expect.arrayContaining([
        ["keyword_data.keyword_info.search_volume", ">=", 0],
        [
          ["keyword_data.keyword", "ilike", "%repair%"],
          "or",
          ["ranked_serp_element.serp_item.url", "ilike", "%repair%"],
        ],
      ]),
    );
    expect(JSON.stringify(mocks.rankedKeywords.mock.calls[0])).toContain(
      "/services/%",
    );
  });
});
