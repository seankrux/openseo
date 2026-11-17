import { createServerFn } from "@tanstack/react-start";
import { hasDataforseoAccess } from "@/server/lib/provider-access";
import { resolveSerpProvider } from "@/server/lib/serp-provider";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";

export const getSeoApiKeyStatus = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(async () => {
    const configured = await hasDataforseoAccess();
    const serpProvider = (await resolveSerpProvider())?.kind ?? null;
    return { configured, serpProvider };
  });
