import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { hasOrgPermission } from "@/lib/org-permissions";
import { requireOrgPermission } from "@/server/auth/org-gate";
import { BingWebmasterService } from "@/server/features/bing/BingWebmasterService";
import { requireProjectContext } from "@/serverFunctions/middleware";

const projectScopedSchema = z.object({ projectId: z.string().min(1) });
const setSiteSchema = projectScopedSchema.extend({
  siteUrl: z.string().min(1),
});

export const getBingConnection = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => ({
    ...(await BingWebmasterService.getConnection({
      projectId: context.projectId,
      organizationId: context.organizationId,
    })),
    canManage: hasOrgPermission(context.role, { integration: ["manage"] }),
  }));

export const listBingSites = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    return BingWebmasterService.listSites({
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
    });
  });

export const setBingSite = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(setSiteSchema)
  .handler(async ({ context, data }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    const connection = await BingWebmasterService.bindSite({
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
      siteUrl: data.siteUrl,
    });
    return {
      connected: true as const,
      siteUrl: connection.siteUrl,
      connectedAt: connection.createdAt,
    };
  });

export const disconnectBing = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    await BingWebmasterService.disconnect({
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
    });
    return { connected: false as const };
  });
