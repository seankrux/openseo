import type { RankCheckResult } from "@/server/lib/dataforseo";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { createSemrushSerpProvider } from "@/server/lib/semrush/serp";

export interface OrganicSerpQuery {
  keyword: string;
  /** Lowercase ISO 3166-1 alpha-2 country code. */
  countryCode: string;
  /** City or region; null for a country-wide SERP. */
  locationName: string | null;
  device: "desktop" | "mobile";
  /** Number of organic results to look through (10-100). */
  depth: number;
}

export interface OrganicSerpEntry {
  /** Position among organic results, 1-based. */
  position: number;
  domain: string;
  url: string;
}

/** A SERP source that answers one organic lookup per call. */
export interface SerpProvider {
  readonly id: "semrush";
  organicSerp(query: OrganicSerpQuery): Promise<OrganicSerpEntry[]>;
}

/**
 * Where rank checks get their SERPs. DataForSEO keeps its own metered live and
 * task-queue paths (rankCheckPaths.ts); a lookup provider runs one call per
 * keyword and device.
 */
type SerpProviderSelection =
  | { kind: "dataforseo" }
  | { kind: "semrush"; provider: SerpProvider };

/**
 * DataForSEO when its key is set, else Semrush when its key is set, else null
 * (no rank checks possible).
 */
export async function resolveSerpProvider(): Promise<SerpProviderSelection | null> {
  if ((await getOptionalEnvValue("DATAFORSEO_API_KEY"))?.trim()) {
    return { kind: "dataforseo" };
  }
  const semrushKey = (await getOptionalEnvValue("SEMRUSH_API_KEY"))?.trim();
  if (semrushKey) {
    return { kind: "semrush", provider: createSemrushSerpProvider(semrushKey) };
  }
  return null;
}

/**
 * The target domain's best organic position, matching the domain or any
 * subdomain as the DataForSEO path does.
 */
export function rankFromOrganicSerp(
  input: { keywordId: string; keyword: string; targetDomain: string },
  entries: OrganicSerpEntry[],
): RankCheckResult {
  const target = input.targetDomain.toLowerCase();
  const match = entries
    .filter((entry) => {
      const domain = entry.domain.toLowerCase();
      return domain === target || domain.endsWith(`.${target}`);
    })
    .reduce<OrganicSerpEntry | null>(
      (best, entry) =>
        best === null || entry.position < best.position ? entry : best,
      null,
    );
  return {
    keywordId: input.keywordId,
    keyword: input.keyword,
    position: match?.position ?? null,
    url: match?.url ?? null,
    // Semrush reports SERP features as numeric codes, not the type names
    // the rank table shows, so none are recorded.
    serpFeatures: [],
  };
}
