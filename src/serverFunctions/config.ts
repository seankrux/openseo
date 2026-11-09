import { createServerFn } from "@tanstack/react-start";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { resolveSerpProvider } from "@/server/lib/serp-provider";

export const getSeoApiKeyStatus = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(async () => {
    const configured = Boolean(
      (await getOptionalEnvValue("DATAFORSEO_API_KEY"))?.trim(),
    );
    // Rank tracking only needs SERPs, which Semrush can also supply.
    const serpProvider = (await resolveSerpProvider())?.kind ?? null;
    return { configured, serpProvider };
  });
