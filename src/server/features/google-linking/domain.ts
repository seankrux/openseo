// Pure domain helpers for Google property matching (CityThrive fork).
export function bareHost(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith("sc-domain:")) s = s.slice("sc-domain:".length);
  s = s.replace(/^[a-z]+:\/\//, "").split(/[/?#]/, 1)[0] ?? "";
  s = s.replace(/:\d+$/, "").replace(/\.$/, "");
  if (s.startsWith("www.")) s = s.slice(4);
  return s || null;
}

/** GSC site candidates for a domain, best first. */
export function gscCandidatesFor(domain: string): string[] {
  return [
    `sc-domain:${domain}`,
    `https://${domain}/`,
    `https://www.${domain}/`,
    `http://${domain}/`,
    `http://www.${domain}/`,
  ];
}
