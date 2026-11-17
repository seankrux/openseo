import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import { PortfolioService } from "@/server/features/portfolio/PortfolioService";
import {
  getFleetDashboard as loadFleetDashboard,
  getPortfolioOverview as loadPortfolioOverview,
} from "@/server/features/portfolio/FleetDashboardService";
import {
  clearFleetReauditQueue as clearReauditQueue,
  getFleetReauditStatus as loadReauditStatus,
  queueFleetReaudit as queueReaudit,
  setFleetReauditMode as setReauditMode,
} from "@/server/features/portfolio/FleetReauditService";

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

// CityThrive fork: fleet re-audit controls (schedule, picked sites, status).
// Scheduled audits are started as the operator who last changed the controls.
const actorOf = (context: { userId: string; userEmail: string }) => ({
  userId: context.userId,
  userEmail: context.userEmail,
});

export const getFleetReauditStatus = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .handler(({ context }) => loadReauditStatus(context.organizationId));

export const setFleetReauditMode = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(z.object({ mode: z.enum(["off", "gentle", "normal", "fast"]) }))
  .handler(async ({ context, data }) => {
    await setReauditMode(context.organizationId, data.mode, actorOf(context));
    return loadReauditStatus(context.organizationId);
  });

export const queueFleetReaudit = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(z.object({ projectIds: z.array(z.string()).min(1).max(5_000) }))
  .handler(async ({ context, data }) => {
    await queueReaudit(context.organizationId, data.projectIds, actorOf(context));
    return loadReauditStatus(context.organizationId);
  });

export const clearFleetReauditQueue = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) => {
    await clearReauditQueue(context.organizationId);
    return loadReauditStatus(context.organizationId);
  });
