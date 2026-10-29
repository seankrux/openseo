import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import { PortfolioService } from "@/server/features/portfolio/PortfolioService";
import { getFleetDashboard as loadFleetDashboard } from "@/server/features/portfolio/FleetDashboardService";

export const getPortfolioOverview = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .handler(({ context }) =>
    PortfolioService.getOverview({ organizationId: context.organizationId }),
  );

export const refreshPortfolioOverview = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(z.object({}).optional())
  .handler(async ({ context }) => {
    await PortfolioService.clearCache(context.organizationId);
    return { ok: true as const };
  });

// CityThrive fork: all-sites dashboard snapshot (cache-only, no Google calls).
export const getFleetDashboard = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(z.object({ refresh: z.boolean().optional() }).optional())
  .handler(({ context, data }) =>
    loadFleetDashboard(context.organizationId, data?.refresh === true),
  );
