export const DOMAIN_HEALTH_CLASSES = [
  "live_ok",
  "redirect_other_domain",
  "redirect_intended",
  "parked",
  "dns_fail",
  "http_error",
  "ssl_error",
  "timeout",
  "cf_error",
] as const;

export type DomainHealthClass = (typeof DOMAIN_HEALTH_CLASSES)[number];

export const DOMAIN_HEALTH_CHANGE_KINDS = [
  "went_down",
  "came_back",
  "ssl_expiring_soon",
  "ga4_tag_removed",
  "gtm_tag_removed",
  "class_changed",
] as const;

export type DomainHealthChangeKind =
  (typeof DOMAIN_HEALTH_CHANGE_KINDS)[number];

/** Classes treated as "down" for went_down / came_back detection. */
export const DOMAIN_HEALTH_DOWN_CLASSES: ReadonlySet<DomainHealthClass> =
  new Set([
    "dns_fail",
    "http_error",
    "ssl_error",
    "timeout",
    "cf_error",
    "parked",
  ]);

export const SSL_EXPIRING_SOON_DAYS = 14;
