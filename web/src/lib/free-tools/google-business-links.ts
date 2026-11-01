/** Client-side parsers for Google Business Profile links (no API). */

const PLACE_ID_RE = /\b(ChI[\w-]{20,})\b/;
const CID_PARAM_RE = /(?:\?|&)cid=(\d+)/i;
const PLACE_ID_PARAM_RE = /(?:placeid|place_id)=(ChI[\w-]+)/i;

export type GoogleBusinessLinks = {
  placeId: string | null;
  cidDecimal: string | null;
  mapsPlaceUrl: string | null;
  mapsCidUrl: string | null;
  reviewUrl: string | null;
  note: string | null;
};

export function parseGoogleBusinessInput(raw: string): GoogleBusinessLinks | null {
  const input = raw.trim();
  if (!input) return null;

  let placeId: string | null = null;
  let cidDecimal: string | null = null;

  const placeMatch = input.match(PLACE_ID_RE);
  if (placeMatch) placeId = placeMatch[1];

  const placeParam = input.match(PLACE_ID_PARAM_RE);
  if (placeParam) placeId = placeParam[1];

  const cidMatch = input.match(CID_PARAM_RE);
  if (cidMatch) cidDecimal = cidMatch[1];

  if (/^\d{10,}$/.test(input)) {
    cidDecimal = input.replace(/^0+/, "") || input;
  }

  try {
    if (input.includes("google.") || input.includes("goo.gl")) {
      const url = new URL(input.includes("://") ? input : `https://${input}`);
      const cidFromUrl = url.searchParams.get("cid");
      if (cidFromUrl && /^\d+$/.test(cidFromUrl)) cidDecimal = cidFromUrl;
      const q = url.searchParams.get("q") ?? url.searchParams.get("query");
      if (!placeId && q?.match(PLACE_ID_RE)) {
        placeId = q.match(PLACE_ID_RE)![1];
      }
      const pathPlace = url.pathname.match(/\/place\/([^/]+)/);
      if (pathPlace && pathPlace[1].startsWith("ChI")) {
        placeId = decodeURIComponent(pathPlace[1].replace(/\+/g, " "));
      }
    }
  } catch {
    // Not a URL; other patterns above may still match.
  }

  if (!placeId && !cidDecimal) return null;

  const mapsPlaceUrl = placeId
    ? `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${encodeURIComponent(placeId)}`
    : null;
  const mapsCidUrl = cidDecimal
    ? `https://www.google.com/maps?cid=${cidDecimal}`
    : null;
  const reviewUrl = placeId
    ? `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`
    : null;

  let note: string | null = null;
  if (!placeId && cidDecimal) {
    note =
      "We found a CID but not a Place ID. Maps link works; review links need a Place ID (paste a Maps place URL or a ChIJ… id).";
  }

  return {
    placeId,
    cidDecimal,
    mapsPlaceUrl,
    mapsCidUrl,
    reviewUrl,
    note,
  };
}
