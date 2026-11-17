import { queryOptions } from "@tanstack/react-query";
import type { z } from "zod";
import { getSearchPerformanceTable } from "@/serverFunctions/searchPerformance";
import type {
  searchPerformanceInputSchema,
  SearchPerformanceSort,
  SearchPerformanceSortOrder,
  SearchPerformanceTableDimension,
} from "@/types/schemas/search-performance";

export type FilterInput = Omit<
  z.infer<typeof searchPerformanceInputSchema>,
  "projectId"
>;

// Shared by the live table and prefetch so the query key and request agree.
export function tableQueryOptions(
  projectId: string,
  dimension: SearchPerformanceTableDimension,
  page: number,
  pageSize: number,
  filterInput: FilterInput,
  sort: SearchPerformanceSort = "clicks",
  order: SearchPerformanceSortOrder = "desc",
) {
  return queryOptions({
    queryKey: [
      "searchPerformanceTable",
      projectId,
      dimension,
      page,
      pageSize,
      filterInput,
      sort,
      order,
    ],
    queryFn: () =>
      getSearchPerformanceTable({
        data: {
          projectId,
          dimension,
          page,
          pageSize,
          sort,
          order,
          ...filterInput,
        },
      }),
  });
}
