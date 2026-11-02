import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import {
  exportSearchPerformanceTable,
  getSearchPerformanceReport,
  getSearchPerformanceTable,
} from "./searchPerformance";

const { getPerformance } = vi.hoisted(() => ({ getPerformance: vi.fn() }));
const { getConnection, readThrough } = vi.hoisted(() => ({
  getConnection: vi.fn(),
  readThrough: vi.fn(),
}));
vi.mock("@/server/features/gsc/repositories/GscConnectionRepository", () => ({
  GscConnectionRepository: { getByProjectId: getConnection },
}));
vi.mock("@/server/features/dashboard/services/DashboardCacheService", () => ({
  DashboardCacheService: { readThrough },
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: { getPerformance },
  GscNotConnectedError: class extends Error {},
  isExpectedGrantFailure: () => false,
}));
vi.mock("@/serverFunctions/middleware", () => ({ requireProjectContext: [] }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    middleware: () => ({
      validator: (schema: z.ZodType) => ({
        handler:
          (
            handler: (input: {
              data: unknown;
              context: { projectId: string; organizationId: string };
            }) => unknown,
          ) =>
          ({ data }: { data: unknown }) =>
            handler({
              data: schema.parse(data),
              context: {
                projectId: "authorized-project",
                organizationId: "authorized-org",
              },
            }),
      }),
    }),
  }),
}));

const data = {
  projectId: "authorized-project",
  dateRange: "last_28_days" as const,
  country: "SWE",
  device: "MOBILE" as const,
  pageFilter: { operator: "contains" as const, expression: "/collections/" },
  queryFilter: { operator: "equals" as const, expression: "OpenSEO" },
};
const filters = [
  { dimension: "device", operator: "equals", expression: "MOBILE" },
  { dimension: "page", ...data.pageFilter },
  { dimension: "query", ...data.queryFilter },
  { dimension: "country", operator: "equals", expression: "swe" },
];

beforeEach(() => {
  getPerformance.mockResolvedValue({ rows: [] });
  getConnection.mockResolvedValue({
    siteUrl: "sc-domain:example.com",
    gscAccountId: "account",
    updatedAt: "2026-10-01",
  });
  readThrough.mockImplementation(
    async (input: { load: () => Promise<unknown> }) => ({
      value: await input.load(),
      fetchedAt: "2026-10-20T12:00:00Z",
      stale: false,
      refreshError: null,
    }),
  );
});
afterEach(() => vi.useRealTimers());

describe("Search Performance combined filters", () => {
  it("applies the same filters to both totals periods and striking distance, keeping country options available", async () => {
    await getSearchPerformanceReport({ data });
    expect(getPerformance).toHaveBeenCalledTimes(4);
    for (const index of [0, 1, 2]) {
      expect(getPerformance.mock.calls[index][0]).toMatchObject({
        projectId: "authorized-project",
        filters,
      });
    }
    expect(getPerformance.mock.calls[3][0]).toMatchObject({
      dimensions: ["country"],
      filters: filters.slice(0, 3),
    });
  });

  it.each(["query", "page"] as const)(
    "keeps %s pagination and exports on the same filtered dataset",
    async (dimension) => {
      await getSearchPerformanceTable({
        data: { ...data, dimension, page: 2, pageSize: 25 },
      });
      await exportSearchPerformanceTable({ data: { ...data, dimension } });
      expect(getPerformance.mock.calls[0][0]).toMatchObject({
        dimensions: [dimension],
        filters,
        rowLimit: 25000,
      });
      expect(getPerformance.mock.calls[1][0]).toMatchObject({
        dimensions: [dimension],
        filters,
        rowLimit: 1000,
      });
    },
  );

  it("reports the last-page row count instead of a full page for narrow filters", async () => {
    getPerformance.mockResolvedValue({
      rows: [
        {
          keys: ["soundsplitter"],
          clicks: 1,
          impressions: 1,
          ctr: 1,
          position: 6,
        },
      ],
    });
    const result = await getSearchPerformanceTable({
      data: { ...data, dimension: "query", page: 1, pageSize: 25 },
    });
    expect(result).toMatchObject({
      connected: true,
      hasNextPage: false,
      totalCount: 1,
    });
    getPerformance.mockResolvedValue({ rows: [] });
    const empty = await getSearchPerformanceTable({
      data: { ...data, dimension: "query", page: 1, pageSize: 25 },
    });
    expect(empty).toMatchObject({
      connected: true,
      hasNextPage: false,
      totalCount: 0,
    });
  });
});

describe("Search Performance matching-dataset sorting", () => {
  it("sorts all 295 matches before paginating, including a partial last page", async () => {
    getPerformance.mockResolvedValue({
      rows: Array.from({ length: 295 }, (_, index) => ({
        keys: [`query-${index}`],
        clicks: index === 0 ? 1 : 0,
        impressions: index + 1,
        ctr: 0,
        position: 10,
      })),
    });
    const input = {
      ...data,
      dimension: "query" as const,
      pageSize: 25,
      sort: "impressions" as const,
      order: "desc" as const,
    };
    const first = await getSearchPerformanceTable({
      data: { ...input, page: 1 },
    });
    const second = await getSearchPerformanceTable({
      data: { ...input, page: 2 },
    });
    const last = await getSearchPerformanceTable({
      data: { ...input, page: 12 },
    });
    if (!first.connected || !second.connected || !last.connected)
      throw new Error("Expected connected data");
    expect(first.rows.map((row) => row.impressions)).toEqual(
      Array.from({ length: 25 }, (_, index) => 295 - index),
    );
    expect(second.rows.map((row) => row.impressions)).toEqual(
      Array.from({ length: 25 }, (_, index) => 270 - index),
    );
    expect(last.rows.map((row) => row.impressions)).toEqual(
      Array.from({ length: 20 }, (_, index) => 20 - index),
    );
    expect(last).toMatchObject({
      totalCount: 295,
      hasNextPage: false,
      limitReached: false,
    });
  });

  it.each(["asc", "desc"] as const)(
    "keeps unknowns last, real zeroes numeric, and ties stable for %s sorting",
    async (order) => {
      getPerformance.mockResolvedValue({
        rows: [
          {
            keys: ["unknown"],
            clicks: 0,
            impressions: null,
            ctr: 0,
            position: 10,
          },
          { keys: ["b"], clicks: 0, impressions: 0, ctr: 0, position: 10 },
          {
            keys: ["nonzero"],
            clicks: 0,
            impressions: 5,
            ctr: 0,
            position: 10,
          },
          { keys: ["a"], clicks: 0, impressions: 0, ctr: 0, position: 10 },
        ],
      });
      const result = await getSearchPerformanceTable({
        data: {
          ...data,
          dimension: "query",
          page: 1,
          pageSize: 25,
          sort: "impressions",
          order,
        },
      });
      if (!result.connected) throw new Error("Expected connected data");
      expect(result.rows.map((row) => row.key)).toEqual(
        order === "asc"
          ? ["a", "b", "nonzero", "unknown"]
          : ["nonzero", "a", "b", "unknown"],
      );
      expect(
        result.rows.find((row) => row.key === "unknown")?.impressions,
      ).toBeNull();
      expect(result.rows.find((row) => row.key === "a")?.impressions).toBe(0);
    },
  );

  it("scopes the shared dataset cache to organization, property, window, dimension, and filters", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    await getSearchPerformanceTable({
      data: {
        ...data,
        dimension: "page",
        page: 2,
        pageSize: 25,
        sort: "position",
        order: "asc",
      },
    });
    expect(readThrough).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "authorized-org",
        params: {
          projectId: "authorized-project",
          siteUrl: "sc-domain:example.com",
          accountId: "account",
          connectionUpdatedAt: "2026-10-01",
          dimension: "page",
          startDate: "2026-09-20",
          endDate: "2026-10-17",
          filters,
        },
      }),
    );
    expect(getPerformance.mock.calls[0][0]).not.toHaveProperty("startRow");
  });
});
