import { AppError } from "@/server/lib/errors";
import { getRequiredEnvValue } from "@/server/lib/runtime-env";

/** Measured SEO data requires a provider key; an AI proxy is not a substitute. */
export async function requireDataforseoApiKey(): Promise<string> {
  try {
    const key = await getRequiredEnvValue("DATAFORSEO_API_KEY");
    if (key.trim()) return key;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !==
        "Missing required environment variable: DATAFORSEO_API_KEY"
    ) {
      throw error;
    }
  }
  throw new AppError(
    "DATAFORSEO_NOT_CONFIGURED",
    "Configure DATAFORSEO_API_KEY to retrieve measured SEO data. An AI proxy cannot provide verified search metrics, rankings or backlinks.",
  );
}
