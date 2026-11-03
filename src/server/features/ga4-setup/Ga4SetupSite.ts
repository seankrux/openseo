import { requireSelfHostedIntegrationManager } from "@/server/auth/self-hosted-workspace";
import { Ga4Service } from "@/server/features/ga4/services/Ga4Service";
import { bareHost } from "@/server/features/google-linking/domain";
import { getGoogleAccessToken } from "@/server/features/google/googleOAuth";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { GA4_OAUTH_PROVIDER_ID } from "@/shared/ga4";
import { admin, pickGa4Login } from "./Ga4SetupAdmin";
import {
  appendLog,
  patchState,
  readState,
  type SiteStatus,
} from "./Ga4SetupState";
import {
  getCloudflareConfig,
  planOrApplyRoutes,
  readTagMap,
  setHostsInTagMap,
  verifyTagLive,
} from "./cloudflareTag";

export type SetupResult = {
  domain: string;
  projectId: string;
  apply: boolean;
  steps: { step: string; status: string; detail?: string }[];
  propertyId?: string;
  measurementId?: string;
  final: SiteStatus["status"];
};

type SetupInput = {
  organizationId: string;
  role: string;
  userId: string;
  projectId: string;
  apply: boolean;
  skipVerifyWait?: boolean;
};
type Note = (step: string, status: string, detail?: string) => void;

export async function setupSite(input: SetupInput): Promise<SetupResult> {
  requireSelfHostedIntegrationManager(input);
  const proj = await ProjectService.getProjectForOrganization(
    input.organizationId,
    input.projectId,
  );
  if (!proj?.domain) throw new Error("Project has no domain.");
  const domain = bareHost(proj.domain)!;
  const steps: SetupResult["steps"] = [];
  const res: SetupResult = {
    domain,
    projectId: proj.id,
    apply: input.apply,
    steps,
    final: "preview",
  };
  const note = (step: string, status: string, detail?: string) =>
    steps.push({ step, status, detail });
  try {
    const { login, existingLink, propertyId, measurementId } =
      await preparePropertyAndStream({ ...input, domain }, note);
    res.propertyId = propertyId;
    res.measurementId = measurementId;
    const live0 = await installTag(
      { ...input, domain, propertyId, measurementId },
      res,
      note,
    );
    // 4. verify
    if (input.apply && measurementId && res.final !== "blocked") {
      let v = live0?.live ? live0 : await verifyTagLive(domain, measurementId);
      if (!v.live && !input.skipVerifyWait) {
        // Worker caches the KV map up to 5 min per isolate.
        for (let i = 0; i < 4 && !v.live; i++) {
          await new Promise((r) => setTimeout(r, 20_000));
          v = await verifyTagLive(domain, measurementId);
        }
      }
      note("verify", v.live ? "live" : "not_yet", v.live ? v.url : v.reason);
      if (v.live) res.final = "live";
    }
    // 5. link
    if (propertyId && !existingLink) {
      if (!input.apply) note("link", "would_link", propertyId);
      else {
        await Ga4Service.setProperty({
          projectId: proj.id,
          organizationId: input.organizationId,
          propertyId,
          accountId: login.accountId,
          userId: input.userId,
        });
        note("link", "linked", propertyId);
      }
    }
    if (input.apply) {
      const done = res.final === "live" && (existingLink || propertyId);
      const status: SiteStatus["status"] =
        res.final === "blocked" ? "blocked" : done ? "linked" : "tagged";
      res.final = status;
      await patchState(domain, {
        projectId: proj.id,
        status,
        propertyId,
        measurementId,
        step: status === "tagged" ? "verify" : undefined,
        detail:
          status === "tagged" ? "tag not live yet; will re-verify" : undefined,
        nextTryAt:
          status === "tagged"
            ? new Date(Date.now() + 10 * 60_000).toISOString()
            : undefined,
      });
      await appendLog(
        `${domain} ${status} ${propertyId ?? ""} ${measurementId ?? ""}`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    note("error", "error", msg);
    res.final = "error";
    if (input.apply) {
      const prev = (await readState())[domain];
      // Missing analytics.edit (login not reconnected yet) is a wait state, not a failed attempt.
      const waiting =
        /analytics\.edit|GA4_OAUTH_MANAGE_SCOPES|insufficient.*scope/i.test(
          msg,
        );
      const attempts = (prev?.attempts ?? 0) + (waiting ? 0 : 1);
      // Scope-blocked sites park in "waiting" (6h backoff); the autopilot skips creation entirely
      // until the GA4 login grants analytics.edit, then retries them at once.
      await patchState(
        domain,
        waiting
          ? {
              projectId: proj.id,
              status: "waiting",
              detail:
                "waiting for Google Analytics reconnect with analytics.edit",
              attempts,
              nextTryAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
            }
          : {
              projectId: proj.id,
              status: "error",
              detail: msg.slice(0, 300),
              attempts,
              nextTryAt: new Date(
                Date.now() + Math.min(24 * 60, 15 * 2 ** attempts) * 60_000,
              ).toISOString(),
            },
      );
      await appendLog(
        `${domain} error (attempt ${attempts}): ${msg.slice(0, 200)}`,
      );
    }
  }
  return res;
}

async function preparePropertyAndStream(
  input: SetupInput & { domain: string },
  note: Note,
) {
  const { domain } = input;
  const login = await pickGa4Login(input.userId);
  // 1. property
  const existingLink = await Ga4Service.getConnection(input.projectId);
  let propertyId = existingLink?.propertyId;
  if (propertyId) note("property", "linked", propertyId);
  if (!propertyId) {
    const hit = login.properties.find(
      (p) => bareHost(p.displayName) === domain,
    );
    if (hit) {
      propertyId = hit.propertyId;
      note("property", "exists", propertyId);
    }
  }
  const token =
    input.apply || propertyId
      ? await getGoogleAccessToken({
          userId: input.userId,
          providerId: GA4_OAUTH_PROVIDER_ID,
          accountId: login.accountId,
        })
      : null;
  if (!propertyId) {
    const parent = (
      await getOptionalEnvValue("GA4_SETUP_PARENT_ACCOUNT")
    )?.trim();
    if (!parent)
      throw new Error("GA4_SETUP_PARENT_ACCOUNT (accounts/<id>) is not set.");
    if (!input.apply) {
      note("property", "would_create", `${parent} displayName=${domain}`);
    } else {
      const tz =
        (await getOptionalEnvValue("GA4_SETUP_TIMEZONE")) ?? "America/Chicago";
      const p = await admin(token!, "POST", "/properties", {
        parent,
        displayName: domain,
        timeZone: tz,
        currencyCode: "USD",
        industryCategory: "HOME_AND_GARDEN",
      });
      if (!p.name) throw new Error("Admin API returned no property name.");
      propertyId = p.name;
      note("property", "created", propertyId);
      await patchState(domain, {
        projectId: input.projectId,
        status: "created",
        propertyId,
      });
    }
  }
  // 2. web stream / measurement id
  let measurementId: string | undefined;
  if (propertyId && token) {
    const ds = await admin(token, "GET", `/${propertyId}/dataStreams`);
    const web = (ds.dataStreams ?? []).find(
      (s) => s.type === "WEB_DATA_STREAM",
    );
    measurementId = web?.webStreamData?.measurementId;
    if (measurementId) note("stream", "exists", measurementId);
    else if (!input.apply) note("stream", "would_create", `https://${domain}`);
    else {
      const s = await admin(token, "POST", `/${propertyId}/dataStreams`, {
        type: "WEB_DATA_STREAM",
        displayName: domain,
        webStreamData: { defaultUri: `https://${domain}` },
      });
      measurementId = s.webStreamData?.measurementId;
      note("stream", "created", measurementId);
    }
  } else note("stream", "would_create", `https://${domain}`);

  return { login, existingLink, propertyId, measurementId };
}

async function installTag(
  input: SetupInput & {
    domain: string;
    propertyId?: string;
    measurementId?: string;
  },
  res: SetupResult,
  note: Note,
) {
  const { domain, propertyId, measurementId } = input;
  // 3. tag via Cloudflare
  const cfc = await getCloudflareConfig();
  if (!cfc)
    throw new Error(
      "Cloudflare token/account not configured (GA4_SETUP_CLOUDFLARE_TOKEN / _ACCOUNT_ID).",
    );
  const live0 = measurementId
    ? await verifyTagLive(domain, measurementId)
    : null;
  if (live0?.live) note("tag", "already_live", live0.url);
  else {
    const plan = await planOrApplyRoutes(
      cfc,
      domain,
      input.apply && !!measurementId,
    );
    if (plan.status === "blocked") {
      note(
        "tag",
        "blocked",
        `zone catch-all owned by another Worker (${plan.blockedBy}); add the tag in that Worker or the site header`,
      );
      res.final = "blocked";
      if (input.apply)
        await patchState(domain, {
          projectId: input.projectId,
          status: "blocked",
          step: "tag",
          detail: plan.blockedBy,
          propertyId,
          measurementId,
        });
    } else if (plan.status === "no_zone" || plan.status === "error") {
      throw new Error(`Cloudflare: ${plan.status} ${plan.error ?? ""}`);
    } else if (!input.apply || !measurementId) {
      const map = await readTagMap(cfc).catch(
        () => ({}) as Record<string, string>,
      );
      note(
        "tag",
        "would_install",
        `KV map ${map[domain] ? "has " + map[domain] : "add " + domain}; routes ${plan.create.length ? "+" + plan.create.length : "ok"}`,
      );
    } else {
      await setHostsInTagMap(cfc, { [domain]: measurementId });
      note("tag", "installed", `routes +${plan.create.length}`);
      await patchState(domain, {
        projectId: input.projectId,
        status: "tagged",
        propertyId,
        measurementId,
      });
    }
  }

  return live0;
}
