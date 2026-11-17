import { createServerFn } from "@tanstack/react-start";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";

export const getSeoApiKeyStatus = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(async () => {
    const configured = Boolean(
      (await getOptionalEnvValue("DATAFORSEO_API_KEY"))?.trim(),
    );
    return { configured };
  });
