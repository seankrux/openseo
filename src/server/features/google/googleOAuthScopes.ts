import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import type { GoogleLinkProvider } from "@/shared/google-link";

/** CityThrive fork: when GSC_OAUTH_MANAGE_SCOPES=1, the Search Console connect
 *  also asks for `webmasters` (add sites) and `siteverification` (DNS TXT
 *  verification) so the gsc_onboard_domain MCP tool can add and verify new
 *  properties with that login. Off by default (read-only, upstream behaviour). */
const GSC_MANAGE_SCOPES = [
  "https://www.googleapis.com/auth/webmasters",
  "https://www.googleapis.com/auth/siteverification",
] as const;

/** CityThrive fork: GA4_OAUTH_MANAGE_SCOPES=1 adds analytics.edit so GA4 setup can create
 *  properties and web streams with the connected login. */
const GA4_MANAGE_SCOPES = [
  "https://www.googleapis.com/auth/analytics.edit",
] as const;

export async function getRequestedScopes(integration: {
  provider: GoogleLinkProvider;
  scopes: readonly string[];
}): Promise<string[]> {
  const scopes = [...integration.scopes];
  const on = async (name: string) => {
    const f = (await getOptionalEnvValue(name))?.trim();
    // Management permissions require an explicit operator opt-in.
    return f === "1" || f?.toLowerCase() === "true";
  };
  const extra =
    integration.provider === "gsc" && (await on("GSC_OAUTH_MANAGE_SCOPES"))
      ? GSC_MANAGE_SCOPES
      : integration.provider === "ga4" && (await on("GA4_OAUTH_MANAGE_SCOPES"))
        ? GA4_MANAGE_SCOPES
        : [];
  for (const s of extra) if (!scopes.includes(s)) scopes.push(s);
  return scopes;
}
