// CityThrive fork: server functions for the /ga4-setup page.
import {
  listMissingGa4,
  readLog,
  readState,
  runBulk,
  setupSite,
} from "@/server/features/ga4-setup/Ga4SetupService";
import {
  requireAuthenticatedContext,
  requireProjectContext,
} from "@/serverFunctions/middleware";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const getGa4SetupOverview = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) => {
    const [missing, state, log] = await Promise.all([
      listMissingGa4(context),
      readState(context),
      readLog(context),
    ]);
    return { missing, state: Object.values(state), log: log.slice(0, 100) };
  });

export const runGa4SetupSite = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    z.object({
      projectId: z.string().min(1),
      apply: z.boolean(),
      confirm: z.boolean().optional(),
    }),
  )
  .handler(({ data, context }) =>
    setupSite({
      ...context,
      projectId: context.projectId,
      apply: data.apply && data.confirm === true,
    }),
  );

export const runGa4SetupBulk = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(
    z.object({
      limit: z.number().int().min(1).max(50),
      apply: z.boolean(),
      confirm: z.boolean().optional(),
    }),
  )
  .handler(({ data, context }) =>
    runBulk({
      ...context,
      apply: data.apply && data.confirm === true,
      limit: data.limit,
    }),
  );
