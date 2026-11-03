import {
  requireSelfHostedIntegrationManager,
  type SelfHostedManagerContext,
} from "@/server/auth/self-hosted-workspace";
// CityThrive fork: add + DNS-verify a Search Console domain property with a connected Google login.
import { getGoogleAccessToken } from "@/server/features/google/googleOAuth";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { type ToolContext } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { GSC_OAUTH_PROVIDER_ID } from "@/shared/gsc";
import { z } from "zod";

const SV = "https://www.googleapis.com/siteVerification/v1";
const WM = "https://www.googleapis.com/webmasters/v3";
const CF = "https://api.cloudflare.com/client/v4";

async function j(url: string, init: RequestInit = {}) {
  const r = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const t = await r.text();
  let body: unknown = {};
  try {
    body = t ? JSON.parse(t) : {};
  } catch {
    body = { raw: t.slice(0, 300) };
  }
  return { status: r.status, body };
}

async function onboardGscDomain(
  input: SelfHostedManagerContext & {
    userId: string;
    accountId: string;
    domain: string;
    dryRun: boolean;
    waitMs?: number;
  },
) {
  requireSelfHostedIntegrationManager(input);
  const domain = input.domain
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
  const steps: string[] = [];
  const token = await getGoogleAccessToken({
    userId: input.userId,
    providerId: GSC_OAUTH_PROVIDER_ID,
    accountId: input.accountId,
  });
  const g = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const tok = await j(`${SV}/token`, {
    method: "POST",
    headers: g,
    body: JSON.stringify({
      site: { type: "INET_DOMAIN", identifier: domain },
      verificationMethod: "DNS_TXT",
    }),
  });
  if (tok.status !== 200)
    throw new Error(
      `siteVerification.getToken ${tok.status}: ${JSON.stringify(tok.body).slice(0, 300)} (does the login have the siteverification scope? set GSC_OAUTH_MANAGE_SCOPES=1 and reconnect)`,
    );
  const txt = z.object({ token: z.string().min(1) }).parse(tok.body).token;
  steps.push("got TXT token");
  const cfToken = (await getOptionalEnvValue("CLOUDFLARE_DNS_TOKEN"))?.trim();
  if (!cfToken) throw new Error("CLOUDFLARE_DNS_TOKEN not set");
  const c = {
    Authorization: `Bearer ${cfToken}`,
    "Content-Type": "application/json",
  };
  const z1 = await j(`${CF}/zones?name=${encodeURIComponent(domain)}`, {
    headers: c,
  });
  const zoneId = z
    .object({ result: z.array(z.object({ id: z.string() })) })
    .parse(z1.body).result[0]?.id;
  if (!zoneId) throw new Error(`Cloudflare zone not found for ${domain}`);
  const ex = await j(
    `${CF}/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(domain)}`,
    { headers: c },
  );
  const has = z
    .object({ result: z.array(z.object({ content: z.string() })) })
    .parse(ex.body)
    .result.some((record) => record.content.includes(txt));
  if (input.dryRun)
    return { domain, dryRun: true, zoneId, txtPresent: has, steps };
  if (!has) {
    const add = await j(`${CF}/zones/${zoneId}/dns_records`, {
      method: "POST",
      headers: c,
      body: JSON.stringify({
        type: "TXT",
        name: domain,
        content: `"${txt}"`,
        ttl: 120,
        comment: "GSC verify (OpenSEO gsc_onboard_domain)",
      }),
    });
    if (!z.object({ success: z.boolean() }).parse(add.body).success)
      throw new Error(`Cloudflare add TXT failed: ${JSON.stringify(add.body)}`);
    steps.push("added TXT");
  } else steps.push("TXT already present");
  const deadline = Date.now() + (input.waitMs ?? 90_000);
  let ver: { status: number; body: unknown } = { status: 0, body: {} };
  do {
    await new Promise((r) => setTimeout(r, 15_000));
    ver = await j(`${SV}/webResource?verificationMethod=DNS_TXT`, {
      method: "POST",
      headers: g,
      body: JSON.stringify({
        site: { type: "INET_DOMAIN", identifier: domain },
      }),
    });
  } while (ver.status !== 200 && Date.now() < deadline);
  if (ver.status !== 200)
    return {
      domain,
      verified: false,
      error: JSON.stringify(ver.body).slice(0, 300),
      steps,
    };
  steps.push("verified");
  const siteUrl = `sc-domain:${domain}`;
  const add = await j(`${WM}/sites/${encodeURIComponent(siteUrl)}`, {
    method: "PUT",
    headers: g,
  });
  if (add.status >= 300)
    throw new Error(
      `sites.add ${add.status}: ${JSON.stringify(add.body).slice(0, 300)}`,
    );
  steps.push("added to Search Console");
  return { domain, verified: true, siteUrl, steps };
}

export const gscOnboardDomainTool = {
  name: "gsc_onboard_domain",
  config: {
    title: "Add + verify a Search Console domain property (Cloudflare DNS TXT)",
    description:
      "For a domain on the Cloudflare account in CLOUDFLARE_DNS_TOKEN: gets a Site Verification DNS_TXT token for the given Google login (accountId from list_google_properties), adds the TXT record, verifies, and adds sc-domain:<domain> to Search Console. Needs the login connected with GSC_OAUTH_MANAGE_SCOPES=1. dryRun (default true) only fetches the token and checks the zone. Then call link_gsc_property.",
    inputSchema: {
      domain: z.string().min(3),
      accountId: z
        .string()
        .min(1)
        .describe(
          "Google account id (sub) of the connected Search Console login.",
        ),
      dryRun: z.boolean().optional(),
    },
    outputSchema: z.looseObject({ ...optionalMetaOutputSchema }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: async (
    args: { domain: string; accountId: string; dryRun?: boolean },
    context: ToolContext,
  ) => {
    try {
      const r = await onboardGscDomain({
        ...context.auth,
        accountId: args.accountId,
        domain: args.domain,
        dryRun: args.dryRun ?? true,
      });
      return mcpResponse({
        text: JSON.stringify(r),
        structuredContent: { ok: true, ...r },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return mcpResponse({
        text: `Error: ${message}`,
        structuredContent: { ok: false, error: message },
      });
    }
  },
};
