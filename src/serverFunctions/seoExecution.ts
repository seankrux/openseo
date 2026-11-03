import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { SearchOpportunityService } from "@/server/features/ga4/services/SearchOpportunityService";
import { buildSeoExecutionPlan } from "@/shared/seo-execution/plan";
import { requireProjectContext } from "@/serverFunctions/middleware";

const projectSchema = z.object({ projectId: z.string().min(1) });

/** Read-only: source the existing project-bound Google connections and build a review plan. */
export const getSeoExecutionPlan = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectSchema)
  .handler(async ({ context }) => {
    const source = await SearchOpportunityService.getOpportunities({
      projectId: context.projectId,
      limit: 100,
    });
    return buildSeoExecutionPlan(source);
  });
