import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import { PortfolioService } from "@/server/features/portfolio/PortfolioService";
import {
  getFleetDashboard as loadFleetDashboard,
  getPortfolioOverview as loadPortfolioOverview,
} from "@/server/features/portfolio/FleetDashboardService";

// CityThrive fork: the site table reads the fleet snapshot (one cache object
// plus a database query). It never calls Google; the scheduler warms caches.
export const getPortfolioOverview = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .handler(({ context }) => loadPortfolioOverview(context.organizationId));

export const refreshPortfolioOverview = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(z.object({}).optional())
  .handler(async ({ context }) => {
    await PortfolioService.clearCache(context.organizationId);
    return { ok: true as const };
  });

// CityThrive fork: all-sites dashboard snapshot (cache-only, no Google calls).
// The per-site provider inventory is large (1,600+ rows x 3 providers), so it
// is served by getFleetInventory on demand rather than with every page view.
export const getFleetDashboard = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(z.object({ refresh: z.boolean().optional() }).optional())
  .handler(async ({ context, data }) => {
    const { inventory: _inventory, ...dashboard } = await loadFleetDashboard(
      context.organizationId,
      data?.refresh === true,
    );
    return dashboard;
  });

export const getFleetInventory = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) => {
    const { generatedAt, inventory } = await loadFleetDashboard(
      context.organizationId,
    );
    return { generatedAt, inventory };
  });
