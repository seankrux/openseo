import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getGscRankings } from "@/server/features/rank-tracking/services/gscRankings";
import { requireProjectContext } from "@/serverFunctions/middleware";

export const getProjectGscRankings = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(z.object({ projectId: z.string().uuid(), refresh: z.boolean().optional() }))
  .handler(async ({ data, context }) => getGscRankings(context.projectId, !!data.refresh));
