import { useEffect, useState } from "react";
import { queryOptions, type UseQueryResult } from "@tanstack/react-query";
import { getProjects } from "@/serverFunctions/projects";

// The org's active projects. Invalidating this key also refreshes the
// archived list, which lives under ["projects", "archived"].
export const projectsQueryOptions = () =>
  queryOptions({
    queryKey: ["projects"],
    queryFn: () => getProjects(),
  });

/**
 * The cached list can predate a project created elsewhere (MCP, another tab).
 * Refetch once when the id is missing; true while that check is running.
 */
export function useMissingProjectCheck(
  query: UseQueryResult<{ id: string }[]>,
  projectId: string,
) {
  const [checkedId, setCheckedId] = useState<string | null>(null);
  const isMissing =
    query.isSuccess && !query.data.some((row) => row.id === projectId);
  useEffect(() => {
    if (!isMissing || checkedId === projectId) return;
    setCheckedId(projectId);
    void query.refetch();
  }, [checkedId, isMissing, projectId, query]);
  return isMissing && (checkedId !== projectId || query.isFetching);
}
