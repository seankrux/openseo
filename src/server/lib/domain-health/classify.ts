import {
  isBlankPage,
  isCloudflareErrorPage,
  isDefaultHostPage,
  isParkedPage,
} from "./detect-parked";
import type { DnsResult, DomainHealthClass, HttpsResult } from "./types";

export function classifyDomainHealth(input: {
  dns: DnsResult;
  https: HttpsResult;
}): {
  class: DomainHealthClass;
  parked: boolean;
  defaultHostPage: boolean;
} {
  const { dns, https } = input;

  if (!dns.ok) {
    return {
      class: /timeout|timed out|aborted/i.test(dns.error ?? "")
        ? "timeout"
        : "dns_fail",
      parked: false,
      defaultHostPage: false,
    };
  }

  if (https.timedOut) {
    return { class: "timeout", parked: false, defaultHostPage: false };
  }

  if (https.sslError) {
    return { class: "ssl_error", parked: false, defaultHostPage: false };
  }

  const body = https.bodySnippet;
  const status = https.status;
  const parked = isParkedPage(body);
  const defaultHostPage = isDefaultHostPage(body);

  if (isCloudflareErrorPage(status, body)) {
    return { class: "cf_error", parked, defaultHostPage };
  }

  if (parked || defaultHostPage) {
    return { class: "parked", parked: true, defaultHostPage };
  }

  if (https.redirectedOtherDomain && https.ok) {
    return { class: "redirect_other_domain", parked, defaultHostPage };
  }

  if (status != null && status >= 400) {
    return { class: "http_error", parked, defaultHostPage };
  }

  if (!https.ok || status == null) {
    // DNS ok but HTTPS failed for a non-ssl/timeout reason → http_error-ish;
    // use timeout already handled; leftover connection errors count as http_error.
    if (/timeout/i.test(https.error ?? "")) {
      return { class: "timeout", parked, defaultHostPage };
    }
    return { class: "http_error", parked, defaultHostPage };
  }

  if (isBlankPage(body)) {
    return { class: "blank_page", parked, defaultHostPage };
  }

  return { class: "live_ok", parked, defaultHostPage };
}
