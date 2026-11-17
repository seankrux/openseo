import { createAuthClient } from "better-auth/react";
import { apiKeyClient } from "@better-auth/api-key/client";
import {
  inferAdditionalFields,
  organizationClient,
} from "better-auth/client/plugins";
import { captureClientEvent, resetAnalyticsUser } from "@/client/lib/posthog";
import { isHostedClientAuthMode } from "@/lib/auth-mode";
import { userAdditionalFields } from "@/lib/auth-options";
import { orgAccessControl, orgRoles } from "@/lib/org-permissions";
import { getSignInHrefForLocation } from "@/lib/auth-redirect";

export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : "",
  plugins: [
    apiKeyClient(),
    organizationClient({ ac: orgAccessControl, roles: orgRoles }),
    inferAdditionalFields({ user: userAdditionalFields }),
  ],
});

const NOAUTH_SESSION_RESULT = {
  data: null,
  isPending: false,
  isRefetching: false,
  error: null,
  refetch: async () => {},
} as ReturnType<typeof authClient.useSession>;

export function useSession() {
  if (!isHostedClientAuthMode()) {
    return NOAUTH_SESSION_RESULT;
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return authClient.useSession();
}

export function signOutAndRedirect() {
  const signInHref = getSignInHrefForLocation(window.location);
  captureClientEvent("auth:sign_out");
  resetAnalyticsUser();
  void authClient.signOut({
    fetchOptions: {
      onSuccess: () => {
        window.location.assign(signInHref);
      },
    },
  });
}
