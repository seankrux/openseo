const PARKED_KEYWORDS = [
  "domain is for sale",
  "this domain may be for sale",
  "this domain is for sale",
  "buy this domain",
  "parked free",
  "parked domain",
  "domain parking",
  "godaddy",
  "sedo.com",
  "dan.com",
  "afternic",
  "hugedomains",
  "domainmarket",
  "bodis.com",
  "parkingcrew",
  "above.com parked",
];

const DEFAULT_HOST_MARKERS = [
  "index of /",
  "cpanel",
  "hostinger",
  "wordpress installation",
  "select a language to begin installing wordpress",
  "coming soon",
  "default web site page",
  "apache2 ubuntu default page",
  "welcome to nginx",
  "it works!",
];

export function isParkedPage(html: string, titleHint?: string): boolean {
  const hay = `${titleHint ?? ""}\n${html}`.toLowerCase();
  if (PARKED_KEYWORDS.some((k) => hay.includes(k))) return true;

  // Near-empty body with a sales-y title.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 80 && /for sale|parked|buy now/i.test(hay)) return true;
  return false;
}

export function isDefaultHostPage(html: string): boolean {
  const hay = html.toLowerCase();
  return DEFAULT_HOST_MARKERS.some((k) => hay.includes(k));
}

/**
 * A 200 response with no usable document: no visible text and nothing that
 * could render one (external script, iframe, meta refresh). Hosts answer this
 * way for an account that no longer exists.
 */
export function isBlankPage(html: string): boolean {
  if (
    /<script\b[^>]*\bsrc=|<iframe\b|<frame\b|<meta[^>]+http-equiv=["']?refresh/i.test(
      html,
    )
  )
    return false;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .trim();
  return text.length < 20;
}

/** Cloudflare edge error pages: HTTP 520–530 or body 1xxx error codes. */
export function isCloudflareErrorPage(
  status: number | null,
  html: string,
): boolean {
  if (status != null && status >= 520 && status <= 530) return true;
  if (/Error code (10\d{2}|52\d)/i.test(html)) return true;
  if (
    /cloudflare/i.test(html) &&
    /(?:error|bad gateway|web server is down)/i.test(html) &&
    status != null &&
    status >= 500
  ) {
    return true;
  }
  return false;
}
