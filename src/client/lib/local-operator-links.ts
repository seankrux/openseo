/** Fleet / operator shortcuts to public local SEO utilities (openseo.so). */

export const OPENSEO_MARKETING_ORIGIN = "https://openseo.so";

export function googleMapsSearchUrl(query: string): string {
  const q = query.trim();
  if (!q) return "https://www.google.com/maps";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

export function googleReviewLinkToolUrl(): string {
  return `${OPENSEO_MARKETING_ORIGIN}/google-review-link-generator`;
}

export function googleCidConverterToolUrl(): string {
  return `${OPENSEO_MARKETING_ORIGIN}/google-cid-converter`;
}

/** Prefer domain; fall back to project display name for Maps search. */
export function mapsSearchQuery(domain: string | null | undefined, name: string): string {
  return (domain?.trim() || name.trim() || "").replace(/^https?:\/\//, "");
}
