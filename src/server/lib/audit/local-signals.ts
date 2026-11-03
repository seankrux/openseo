/**
 * CityThrive fork: local-service signals ported from the old Crawl4AI audit
 * (tel links, CallRail, LocalBusiness schema, wrong-city slugs). Pure helpers;
 * the streaming analyzer feeds raw values in, page reporters read them out.
 */

export interface LocalSignals {
  /** Raw `tel:` hrefs (capped). */
  telHrefs: string[];
  /** Non-tel hrefs that look like a phone number (e.g. "/+1-580-271-9887”"). */
  phoneLikeHrefs: string[];
  callrail: boolean;
  /** JSON-LD @type values found on the page. */
  schemaTypes: string[];
  /** Raw internal-link paths for the wrong-city check (capped). */
  linkPaths: string[];
}

export const MAX_LOCAL_ITEMS = 50;
export const MAX_LD_JSON_CHARS = 100_000;

// Phone-ish href that is NOT a tel: link: optional slash, optional +1, 10 digits
// with common separators, optionally followed by stray quotes.
const PHONE_LIKE_HREF =
  /^\/?(?:%2b|\+)?1?[\s.\-()%20]*\d{3}[\s.\-()%20]*\d{3}[\s.\-%20]*\d{4}(?:[\s"'”“’]|%e2%80%9d|%22)*\/?$/i;

export function isPhoneLikeHref(href: string): boolean {
  const h = href.trim();
  if (/^tel:/i.test(h)) return false;
  return PHONE_LIKE_HREF.test(h);
}

/** A tel: href is malformed when it has no 10-15 digit number or stray characters. */
export function isMalformedTel(href: string): boolean {
  let raw = href.replace(/^tel:/i, "");
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // keep raw
  }
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return true;
  return /[^0-9+\-().\s,;pw*#x]/i.test(raw.replace(/ext\.?/i, ""));
}

export function collectSchemaTypes(jsonText: string, into: Set<string>): void {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return;
  }
  const walk = (node: unknown, depth: number) => {
    if (depth > 12 || into.size > 100) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    if (!node || typeof node !== "object") return;
    const t: unknown = Reflect.get(node, "@type");
    if (typeof t === "string") into.add(t);
    else if (Array.isArray(t))
      for (const x of t) if (typeof x === "string") into.add(x);
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(data, 0);
}

// LocalBusiness and its common schema.org subtypes used by home-service sites.
const LOCAL_TYPE_RE =
  /(LocalBusiness|Organization|Corporation|Contractor|Business|Plumber|Electrician|Locksmith|MovingCompany|HousePainter|RoofingContractor|GeneralContractor|HVACBusiness|ProfessionalService|HomeAndConstructionBusiness|AutomotiveBusiness|Store|Dentist|Attorney|LegalService|MedicalBusiness|EmergencyService|FinancialService)$/;

export function hasLocalBusinessSchema(types: string[]): boolean {
  return types.some((t) =>
    LOCAL_TYPE_RE.test(t.replace(/^https?:\/\/schema\.org\//, "")),
  );
}

const US_STATES = new Set(
  "al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc".split(
    " ",
  ),
);

/**
 * From a URL path like "/house-raising-lifting-boca-raton-fl/" return the
 * place words before a trailing US state code ("boca-raton-fl" style), or
 * null when the slug doesn't end with a state code. Returns up to the last
 * 3 words before the state code (words after an "-in-" marker when present).
 */
export function citySlugFromPath(
  path: string,
): { words: string[]; state: string } | null {
  const seg =
    path
      .toLowerCase()
      .split(/[?#]/, 1)[0]
      .replace(/\/+$/, "")
      .split("/")
      .pop() ?? "";
  const parts = seg
    .replace(/\.(html?|php)$/, "")
    .split("-")
    .filter(Boolean);
  if (parts.length < 2) return null;
  const state = parts[parts.length - 1];
  if (!US_STATES.has(state)) return null;
  let words = parts.slice(0, -1);
  const inIdx = words.lastIndexOf("in");
  if (inIdx >= 0 && inIdx < words.length - 1) words = words.slice(inIdx + 1);
  words = words.slice(-3).filter((w) => /^[a-z]+$/.test(w));
  return words.length ? { words, state } : null;
}

/** The site's own city is assumed to be spelled inside its domain. */
function slugMatchesDomain(words: string[], host: string): boolean {
  const compact = host
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z]/g, "");
  for (let n = 1; n <= words.length; n++) {
    const joined = words.slice(-n).join("");
    if (joined.length >= 4 && compact.includes(joined)) return true;
  }
  return false;
}

export function otherCityRefs(paths: string[], host: string): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const c = citySlugFromPath(p);
    if (!c) continue;
    if (slugMatchesDomain(c.words, host)) continue;
    out.add(`${c.words.join("-")}-${c.state}`);
    if (out.size >= 20) break;
  }
  return [...out];
}
