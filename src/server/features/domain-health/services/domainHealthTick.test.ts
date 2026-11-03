import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({
  domainHealthCurrent: {},
  domainHealthChecks: {},
  projects: {},
}));
vi.mock(
  "@/server/features/domain-health/repositories/DomainHealthRepository",
  () => ({ DomainHealthRepository: {} }),
);
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: vi.fn(async () => "other.com>*, a.com>b.com"),
}));

import type { DomainHealthResult } from "@/server/lib/domain-health";
import {
  applyRedirectAllowlist,
  normalizeFleetDomain,
  redirectAllowlist,
} from "./domainHealthTick";

const redirect = (domain: string, finalUrl: string): DomainHealthResult => ({
  domain,
  finalUrl,
  class: "redirect_other_domain",
  httpStatus: 200,
  redirectHops: 1,
  redirectedOtherDomain: true,
  responseTimeMs: 1,
  dnsOk: true,
  aRecords: [],
  aaaaRecords: [],
  nsRecords: [],
  onCloudflare: false,
  sslValid: null,
  sslExpiresAt: null,
  sslDaysRemaining: null,
  parked: false,
  defaultHostPage: false,
  ga4Ids: [],
  gtmIds: [],
  error: null,
  checkedAt: "2026-11-03T00:00:00Z",
});

describe("domain health redirect allowlist", () => {
  it("treats Atlantic Beach to solidfoundations.com as intended", async () => {
    const allow = await redirectAllowlist();
    const r = applyRedirectAllowlist(
      redirect(
        "atlanticbeachfoundationrepair.com",
        "https://www.solidfoundations.com/",
      ),
      allow,
    );
    expect(r.class).toBe("redirect_intended");
  });

  it("keeps other cross-domain redirects as problems", async () => {
    const allow = await redirectAllowlist();
    const r = applyRedirectAllowlist(
      redirect("x.com", "https://spam.example/"),
      allow,
    );
    expect(r.class).toBe("redirect_other_domain");
    const wrongTarget = applyRedirectAllowlist(
      redirect("atlanticbeachfoundationrepair.com", "https://elsewhere.com/"),
      allow,
    );
    expect(wrongTarget.class).toBe("redirect_other_domain");
  });

  it("supports env entries with wildcard and exact targets", async () => {
    const allow = await redirectAllowlist();
    expect(
      applyRedirectAllowlist(redirect("other.com", "https://any.net/"), allow)
        .class,
    ).toBe("redirect_intended");
    expect(
      applyRedirectAllowlist(redirect("www.a.com", "https://b.com/x"), allow)
        .class,
    ).toBe("redirect_intended");
  });

  it("leaves non-redirect results alone", async () => {
    const r: DomainHealthResult = {
      ...redirect("a.com", "https://b.com"),
      class: "live_ok",
    };
    expect(applyRedirectAllowlist(r, await redirectAllowlist()).class).toBe(
      "live_ok",
    );
  });

  it("normalizes project domains", () => {
    expect(normalizeFleetDomain("https://www.Foo.com/path")).toBe("foo.com");
    expect(normalizeFleetDomain("not a domain")).toBeNull();
    expect(normalizeFleetDomain(null)).toBeNull();
  });
});
