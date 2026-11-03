import { AppError } from "@/server/lib/errors";
import { getEnvValueSync } from "@/server/lib/runtime-env";
import { env } from "cloudflare:workers";
import {
  getDelegatedOrganizationId,
  LOCAL_ADMIN_USER_ID,
  SHARED_WORKSPACE_ORGANIZATION_ID,
} from "./delegated-organization";
import { requireOrgPermission } from "./org-gate";

// Installed provider credentials belong only to the canonical trusted workspace.
export function hasSelfHostedWorkspaceAccess(organizationId: string): boolean {
  const mode = getEnvValueSync(env, "AUTH_MODE");
  if (mode === "local_noauth")
    return organizationId === getDelegatedOrganizationId(LOCAL_ADMIN_USER_ID);
  return (
    mode === "cloudflare_access" &&
    organizationId === SHARED_WORKSPACE_ORGANIZATION_ID
  );
}

export type SelfHostedManagerContext = {
  organizationId: string;
  userId: string;
  role: string;
};

export function requireSelfHostedIntegrationManager(
  context: SelfHostedManagerContext,
): void {
  if (
    !hasSelfHostedWorkspaceAccess(context.organizationId) ||
    !context.userId.trim() ||
    (getEnvValueSync(env, "AUTH_MODE") === "local_noauth" &&
      context.userId !== LOCAL_ADMIN_USER_ID)
  ) {
    throw new AppError("FORBIDDEN");
  }
  requireOrgPermission(context, { integration: ["manage"] });
}
