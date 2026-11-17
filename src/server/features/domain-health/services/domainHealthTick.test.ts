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

import {
  applyRedirectAllowlist,
  normalizeFleetDomain,
  partitionFleetHealth,
  redirectAllowlist,
} from "./domainHealthTick";
import type { DomainHealthResult } from "@/server/lib/domain-health";

const redirect = (domain: string, finalUrl: string) =>
  ({
    domain,
    class: "redirect_other_domain",
    finalUrl,
  }) as unknown as DomainHealthResult;

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
    const r = {
      domain: "a.com",
      class: "live_ok",
      finalUrl: "https://b.com",
    } as unknown as DomainHealthResult;
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

describe("domain health fleet bookkeeping", () => {
  const now = "2026-11-09T12:00:00.000Z";

  it("counts only fleet domains as checked and retires rows that left the fleet", () => {
    const p = partitionFleetHealth(
      ["a.com", "b.com", "c.com"],
      [
        { domain: "a.com", nextCheckAt: "2026-11-10T00:00:00.000Z" },
        { domain: "b.com", nextCheckAt: "2026-11-01T00:00:00.000Z" },
        { domain: "archived.com", nextCheckAt: null },
      ],
      now,
    );
    expect(p.total).toBe(3);
    expect(p.checked).toBe(2);
    expect(p.never).toEqual(["c.com"]);
    expect(p.due).toEqual(["b.com"]);
    expect(p.retired).toEqual(["archived.com"]);
    expect(p.pending).toBe(2);
  });

  it("orders due domains oldest first and treats a null next check as due", () => {
    const p = partitionFleetHealth(
      ["x.com", "y.com", "z.com"],
      [
        { domain: "x.com", nextCheckAt: "2026-11-09T11:00:00.000Z" },
        { domain: "y.com", nextCheckAt: null },
        { domain: "z.com", nextCheckAt: "2026-11-09T10:00:00.000Z" },
      ],
      now,
    );
    expect(p.due).toEqual(["y.com", "z.com", "x.com"]);
    expect(p.retired).toEqual([]);
    expect(p.checked).toBe(3);
  });
});
