// Self-hosted GA4 setup: all public operations require the canonical workspace manager.
import { db } from "@/db";
import { account, ga4Connections, projects } from "@/db/schema";
import {
  getDelegatedOrganizationId,
  LOCAL_ADMIN_USER_ID,
  SHARED_WORKSPACE_ORGANIZATION_ID,
} from "@/server/auth/delegated-organization";
import {
  hasSelfHostedWorkspaceAccess,
  requireSelfHostedIntegrationManager,
  type SelfHostedManagerContext,
} from "@/server/auth/self-hosted-workspace";
import { bareHost } from "@/server/features/google-linking/domain";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { GA4_OAUTH_PROVIDER_ID } from "@/shared/ga4";
import { and, eq, isNull } from "drizzle-orm";
import { setupSite, type SetupResult } from "./Ga4SetupSite";
import {
  appendLog,
  kv,
  migrateScopeErrorsToWaiting,
  patchState,
  readLog as readStoredLog,
  readState as readStoredState,
} from "./Ga4SetupState";
import { verifyTagLive } from "./cloudflareTag";

export { setupSite } from "./Ga4SetupSite";
const MAX_ATTEMPTS = 6;

export async function readState(context: SelfHostedManagerContext) {
  requireSelfHostedIntegrationManager(context);
  return readStoredState();
}
export async function readLog(context: SelfHostedManagerContext) {
  requireSelfHostedIntegrationManager(context);
  return readStoredLog();
}

/** Projects with a domain and no GA4 link (not archived), across orgs. */
export async function listMissingGa4(context: SelfHostedManagerContext) {
  requireSelfHostedIntegrationManager(context);
  const { organizationId } = context;
  const rows = await db
    .select({
      id: projects.id,
      domain: projects.domain,
      organizationId: projects.organizationId,
      linked: ga4Connections.id,
    })
    .from(projects)
    .leftJoin(ga4Connections, eq(ga4Connections.projectId, projects.id))
    .where(
      and(
        isNull(projects.archivedAt),
        organizationId
          ? eq(projects.organizationId, organizationId)
          : undefined,
      ),
    );
  return rows
    .filter((r) => r.domain && !r.linked)
    .map((r) => ({
      projectId: r.id,
      domain: bareHost(r.domain)!,
      organizationId: r.organizationId,
    }));
}

export async function runBulk(input: {
  userId: string;
  organizationId: string;
  role: string;
  apply: boolean;
  limit: number;
  projectIds?: string[];
  editReady?: boolean;
}) {
  requireSelfHostedIntegrationManager(input);
  let todo = await listMissingGa4(input);
  if (input.projectIds?.length)
    todo = todo.filter((t) => input.projectIds!.includes(t.projectId));
  const state = await readStoredState();
  const now = Date.now();
  todo = todo.filter((t) => {
    const s = state[t.domain];
    if (!s) return true;
    if (s.status === "blocked") return false;
    if (s.status === "error" && s.attempts >= MAX_ATTEMPTS) return false;
    if (s.status === "waiting" && input.editReady) return true;
    return !s.nextTryAt || Date.parse(s.nextTryAt) <= now || !input.apply;
  });
  const out: SetupResult[] = [];
  for (const t of todo.slice(0, input.limit)) {
    out.push(
      await setupSite({
        ...input,
        projectId: t.projectId,
        apply: input.apply,
        skipVerifyWait: true,
      }),
    );
  }
  return {
    missingTotal: (await listMissingGa4(input)).length,
    processed: out.length,
    results: out,
  };
}

/** Scheduled autopilot (GA4_AUTOSETUP=1): a small batch every cron tick, as the owner of the GA4 grant. */
export async function runScheduledGa4Setup() {
  const flag = (await getOptionalEnvValue("GA4_AUTOSETUP"))?.trim();
  if (flag !== "1" && flag?.toLowerCase() !== "true") return;
  const organizationId =
    (await getOptionalEnvValue("AUTH_MODE")) === "local_noauth"
      ? getDelegatedOrganizationId(LOCAL_ADMIN_USER_ID)
      : SHARED_WORKSPACE_ORGANIZATION_ID;
  if (!hasSelfHostedWorkspaceAccess(organizationId)) return;
  const k = kv();
  if (k) {
    const last = Number((await k.get("ga4setup:lastTick")) ?? 0);
    const every =
      Number((await getOptionalEnvValue("GA4_AUTOSETUP_EVERY_MIN")) ?? 10) *
      60_000;
    if (Date.now() - last < every) return;
    await k.put("ga4setup:lastTick", String(Date.now()));
  }
  const [grant] = await db
    .select({ userId: account.userId, scope: account.scope })
    .from(account)
    .where(
      and(
        eq(account.providerId, GA4_OAUTH_PROVIDER_ID),
        (await getOptionalEnvValue("AUTH_MODE")) === "local_noauth"
          ? eq(account.userId, LOCAL_ADMIN_USER_ID)
          : undefined,
      ),
    )
    .limit(1);
  if (!grant) return;
  const context = { organizationId, userId: grant.userId, role: "owner" };
  const editReady = /analytics\.edit/.test(grant.scope ?? "");
  await migrateScopeErrorsToWaiting();
  const limit = Number((await getOptionalEnvValue("GA4_AUTOSETUP_BATCH")) ?? 5);
  // Re-verify sites whose tag was installed but not yet seen live.
  const st = await readStoredState();
  for (const s of Object.values(st)
    .filter(
      (x) =>
        x.status === "tagged" &&
        x.measurementId &&
        (!x.nextTryAt || Date.parse(x.nextTryAt) <= Date.now()),
    )
    .slice(0, 20)) {
    const v = await verifyTagLive(s.domain, s.measurementId!);
    await patchState(
      s.domain,
      v.live
        ? {
            projectId: s.projectId,
            status: "linked",
            step: undefined,
            detail: `live ${v.url}`,
            nextTryAt: undefined,
          }
        : {
            projectId: s.projectId,
            status: "tagged",
            attempts: s.attempts + 1,
            detail: v.reason,
            nextTryAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          },
    );
  }
  // Re-run sites previously blocked on Cloudflare (e.g. before fleet-static-worker read GA4_MAP).
  for (const s of Object.values(await readStoredState())
    .filter((x) => x.status === "blocked")
    .slice(
      0,
      Number((await getOptionalEnvValue("GA4_AUTOSETUP_RETAG_BATCH")) ?? 25),
    )) {
    await setupSite({
      ...context,
      projectId: s.projectId,
      apply: true,
      skipVerifyWait: true,
    });
  }
  if (!editReady) {
    // No Admin API write calls until Google is reconnected with analytics.edit.
    const lastNote = Number((k && (await k.get("ga4setup:waitNote"))) ?? 0);
    if (Date.now() - lastNote > 6 * 60 * 60_000) {
      await appendLog(
        "[autopilot] waiting: GA4 login lacks analytics.edit; property creation paused until reconnect",
      );
      if (k) await k.put("ga4setup:waitNote", String(Date.now()));
    }
    return;
  }
  const r = await runBulk({
    ...context,
    apply: true,
    limit,
    editReady,
  });
  await appendLog(
    `[autopilot] processed ${r.processed}, missing ${r.missingTotal}`,
  );
}
