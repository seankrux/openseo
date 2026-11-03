import type { TagDetection } from "./types";

const GA4_RE =
  /(?:gtag\/js\?id=|gtag\(\s*['"]config['"]\s*,\s*['"])(G-[A-Z0-9]+)/gi;
const GTM_RE =
  /(?:googletagmanager\.com\/gtm\.js\?id=|GTM-)(GTM-[A-Z0-9]+|[A-Z0-9]+)/gi;
const GTM_STANDALONE = /\b(GTM-[A-Z0-9]+)\b/g;

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** Extract GA4 measurement IDs (G-…) and GTM container IDs (GTM-…) from HTML. */
export function detectAnalyticsTags(html: string): TagDetection {
  const ga4Ids: string[] = [];
  const gtmIds: string[] = [];

  for (const match of html.matchAll(GA4_RE)) {
    if (match[1]) ga4Ids.push(match[1].toUpperCase());
  }

  for (const match of html.matchAll(GTM_RE)) {
    const raw = match[0].includes("GTM-")
      ? match[0].match(/GTM-[A-Z0-9]+/i)?.[0]
      : match[1]?.startsWith("GTM-")
        ? match[1]
        : match[1]
          ? `GTM-${match[1]}`
          : null;
    if (raw) gtmIds.push(raw.toUpperCase());
  }

  for (const match of html.matchAll(GTM_STANDALONE)) {
    if (match[1]) gtmIds.push(match[1].toUpperCase());
  }

  return {
    ga4Ids: unique(ga4Ids),
    gtmIds: unique(gtmIds),
  };
}
