import {
  getGoogleAccessMode,
  isGatewayGoogleAvailable,
} from "@/server/features/google/googleAccess";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { MIN_BETTER_AUTH_SECRET_LENGTH } from "@/shared/selfhost-checks";

type GoogleOAuthClientConfig = {
  clientId: string;
  clientSecret: string;
};

// Behind an Every App gateway, new member connections go through the
// gateway (googleAccess.ts). An app-owned client is still used to refresh
// Search Console / Analytics grants imported into the `account` table.
export async function getGoogleOAuthClientConfig(): Promise<GoogleOAuthClientConfig | null> {
  const clientId = (await getOptionalEnvValue("GOOGLE_CLIENT_ID"))?.trim();
  const clientSecret = (
    await getOptionalEnvValue("GOOGLE_CLIENT_SECRET")
  )?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

async function hasOwnGoogleOAuthConfig(
  config?: GoogleOAuthClientConfig | null,
): Promise<boolean> {
  const oauthConfig =
    config === undefined ? await getGoogleOAuthClientConfig() : config;
  if (!oauthConfig) return false;
  const secret = (await getOptionalEnvValue("BETTER_AUTH_SECRET"))?.trim();
  return Boolean(secret && secret.length >= MIN_BETTER_AUTH_SECRET_LENGTH);
}

/** Search Console and Analytics need a Google OAuth client plus the secret
 *  that encrypts stored tokens, or a gateway Google connection. */
export async function hasGoogleOAuthConfig(
  config?: GoogleOAuthClientConfig | null,
): Promise<boolean> {
  if (await hasOwnGoogleOAuthConfig(config)) return true;
  if ((await getGoogleAccessMode()) === "gateway") {
    return isGatewayGoogleAvailable();
  }
  return false;
}

export { hasOwnGoogleOAuthConfig };
