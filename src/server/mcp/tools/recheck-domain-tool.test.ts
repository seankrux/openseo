import type * as DomainHealthTick from "@/server/features/domain-health/services/domainHealthTick";
import { describe, expect, it, vi } from "vitest";
import { makeToolContext, textContent as text } from "./tool-test-support";

const recordCheck = vi.hoisted(() => vi.fn(async () => []));
const checkDomainHealth = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock("@/server/lib/domain-health", () => ({
  checkDomainHealth: (...a: unknown[]) => checkDomainHealth(...a),
}));
vi.mock(
  "@/server/features/domain-health/repositories/DomainHealthRepository",
  () => ({
    DomainHealthRepository: { recordCheck },
  }),
);
const resolveFleetProject = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock(
  "@/server/features/domain-health/services/domainHealthTick",
  async () => {
    const real = await vi.importActual<typeof DomainHealthTick>(
      "@/server/features/domain-health/services/domainHealthTick",
    );
    return {
      normalizeFleetDomain: real.normalizeFleetDomain,
      applyRedirectAllowlist: (r: unknown) => r,
      redirectAllowlist: async () => [],
      domainHealthProgress: vi.fn(),
      queueDomainHealthRunNow: vi.fn(),
      resolveFleetProject: (...a: unknown[]) => resolveFleetProject(...a),
    };
  },
);
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({
  domainHealthCurrent: {},
  domainHealthChecks: {},
  projects: {},
}));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: vi.fn(async () => undefined),
}));

import { recheckDomainTool } from "./domain-health-tools";

const ctx = makeToolContext({ organizationId: "org1", userId: "u1" });
const ok = {
  domain: "a.com",
  class: "live_ok",
  httpStatus: 200,
  finalUrl: "https://a.com/",
  ga4Ids: [],
  gtmIds: [],
};

describe("recheck_domain input hardening", () => {
  it("rejects non-domain input before any network call", async () => {
    for (const bad of [
      "127.0.0.1:3001",
      "localhost",
      "http://100.84.140.90:8317/v1",
    ]) {
      const r = await recheckDomainTool.handler({ domain: bad }, ctx);
      expect(text(r)).toMatch(/not a valid domain/);
    }
    expect(checkDomainHealth).not.toHaveBeenCalled();
  });

  it("rejects a projectId from another organization", async () => {
    resolveFleetProject.mockResolvedValueOnce({
      error: "Project p9 was not found in this organization.",
    });
    const r = await recheckDomainTool.handler(
      { domain: "a.com", projectId: "p9" },
      ctx,
    );
    expect(text(r)).toMatch(/not found in this organization/);
    expect(checkDomainHealth).not.toHaveBeenCalled();
  });

  it("checks but does not store a domain outside the fleet", async () => {
    resolveFleetProject.mockResolvedValueOnce({
      projectId: null,
      inFleet: false,
    });
    checkDomainHealth.mockResolvedValueOnce(ok);
    const r = await recheckDomainTool.handler({ domain: "a.com" }, ctx);
    expect(text(r)).toMatch(/not stored/);
    expect(recordCheck).not.toHaveBeenCalled();
  });

  it("stores a fleet domain under its own project", async () => {
    resolveFleetProject.mockResolvedValueOnce({
      projectId: "p1",
      inFleet: true,
    });
    checkDomainHealth.mockResolvedValueOnce(ok);
    await recheckDomainTool.handler({ domain: "https://www.A.com/" }, ctx);
    expect(recordCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org1",
        projectId: "p1",
        trigger: "recheck",
      }),
    );
  });
});
