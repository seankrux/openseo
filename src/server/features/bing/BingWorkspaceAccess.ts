import { env } from "cloudflare:workers";
import {
  getDelegatedOrganizationId,
  LOCAL_ADMIN_USER_ID,
  SHARED_WORKSPACE_ORGANIZATION_ID,
} from "@/server/auth/delegated-organization";
import { AppError } from "@/server/lib/errors";
import { getEnvValueSync } from "@/server/lib/runtime-env";

// An installed API key grants access to ALL of its Bing sites. A project host
// match is only a compatibility filter, never an external entitlement check.
// Accept only the deployment's canonical trusted self-hosted workspace; in
// particular, never apply auth-mode's permissive default for unknown modes.
export function hasBingWorkspaceAccess(organizationId: string): boolean {
  const mode = getEnvValueSync(env, "AUTH_MODE");
  if (mode === "local_noauth")
    return organizationId === getDelegatedOrganizationId(LOCAL_ADMIN_USER_ID);
  return (
    mode === "cloudflare_access" &&
    organizationId === SHARED_WORKSPACE_ORGANIZATION_ID
  );
}

export function requireBingWorkspaceAccess(organizationId: string): void {
  if (!hasBingWorkspaceAccess(organizationId)) throw new AppError("FORBIDDEN");
}

// userId must come from the verified request context, never browser input. All
// Access-admitted users are implicit owners of the canonical shared workspace;
// delegated owners intentionally have no hosted `member` row. The web boundary
// additionally checks integration:manage using the middleware-resolved role.
export function requireBingManagerAccess(input: {
  organizationId: string;
  userId: string;
}): void {
  requireBingWorkspaceAccess(input.organizationId);
  if (
    !input.userId.trim() ||
    (getEnvValueSync(env, "AUTH_MODE") === "local_noauth" &&
      input.userId !== LOCAL_ADMIN_USER_ID)
  )
    throw new AppError("FORBIDDEN");
}
