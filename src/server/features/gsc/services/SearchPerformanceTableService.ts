import { DashboardCacheService } from "@/server/features/dashboard/services/DashboardCacheService";
import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import type { GscPerformanceFilter } from "@/server/features/gsc/searchAnalytics";
import { toDimensionRows } from "@/server/features/gsc/searchPerformanceReport";
import type {
  SearchPerformanceSort,
  SearchPerformanceSortOrder,
  SearchPerformanceTableDimension,
} from "@/types/schemas/search-performance";
import { sort as sortArray } from "remeda";
import { z } from "zod";
import { GscNotConnectedError, GscService } from "./GscService";

const ROW_LIMIT = 25000;
const rowSchema = z.object({
  key: z.string(),
  clicks: z.number().nullable(),
  impressions: z.number().nullable(),
  ctr: z.number().nullable(),
  position: z.number().nullable(),
});

async function getPage(input: {
  projectId: string;
  organizationId: string;
  dimension: SearchPerformanceTableDimension;
  startDate: string;
  endDate: string;
  filters: GscPerformanceFilter[];
  page: number;
  pageSize: number;
  sort: SearchPerformanceSort;
  order: SearchPerformanceSortOrder;
}) {
  const connection = await GscConnectionRepository.getByProjectId(
    input.projectId,
  );
  if (!connection) throw new GscNotConnectedError(input.projectId);

  // GSC only orders by clicks. Cache the matching set once, then sort before
  // slicing; sorting a provider page would omit larger values on later pages.
  const result = await DashboardCacheService.readThrough({
    namespace: "gsc:performance-dimension-v1",
    organizationId: input.organizationId,
    params: {
      projectId: input.projectId,
      siteUrl: connection.siteUrl,
      accountId: connection.gscAccountId,
      connectionUpdatedAt: connection.updatedAt,
      dimension: input.dimension,
      startDate: input.startDate,
      endDate: input.endDate,
      filters: input.filters,
    },
    schema: z.array(rowSchema),
    maxAgeMs: 10 * 60_000,
    load: async () => {
      const response = await GscService.getPerformance({
        projectId: input.projectId,
        startDate: input.startDate,
        endDate: input.endDate,
        dimensions: [input.dimension],
        filters: input.filters,
        rowLimit: ROW_LIMIT,
      });
      return toDimensionRows(response.rows).map((row) => ({
        key: row.key,
        clicks: Number.isFinite(row.clicks) ? row.clicks : null,
        impressions: Number.isFinite(row.impressions) ? row.impressions : null,
        ctr: Number.isFinite(row.ctr) ? row.ctr : null,
        position: Number.isFinite(row.position) ? row.position : null,
      }));
    },
  });
  const rows = sortArray([...result.value], (a, b) => {
    const first = a[input.sort];
    const second = b[input.sort];
    // Unknown values stay last in either direction; a real zero stays numeric.
    if (first === null && second !== null) return 1;
    if (first !== null && second === null) return -1;
    const difference = first === null || second === null ? 0 : first - second;
    if (difference !== 0)
      return input.order === "asc" ? difference : -difference;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const offset = (input.page - 1) * input.pageSize;
  return {
    rows: rows.slice(offset, offset + input.pageSize),
    totalCount: rows.length,
    hasNextPage: offset + input.pageSize < rows.length,
    rowLimit: ROW_LIMIT,
    limitReached: rows.length >= ROW_LIMIT,
    fetchedAt: result.fetchedAt,
    stale: result.stale,
    refreshError: result.refreshError,
  };
}

export const SearchPerformanceTableService = { getPage };
