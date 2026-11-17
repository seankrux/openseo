import { describe, expect, it, vi } from "vitest";

const checkDomainHealth = vi.fn();
vi.mock("@/server/lib/domain-health", () => ({ checkDomainHealth: (...a: unknown[]) => checkDomainHealth(...a) }));
vi.mock("@/server/features/domain-health/repositories/DomainHealthRepository", () => ({
  DomainHealthRepository: { recordCheck: vi.fn(async () => []) },
}));
const resolveFleetProject = vi.fn();
vi.mock("@/server/features/domain-health/services/domainHealthTick", async () => {
  const real = await vi.importActual<Record<string, unknown>>(
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
});
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({ domainHealthCurrent: {}, domainHealthChecks: {}, projects: {} }));
vi.mock("@/server/lib/runtime-env", () => ({ getOptionalEnvValue: vi.fn(async () => undefined) }));

import { recheckDomainTool } from "./domain-health-tools";
import { DomainHealthRepository } from "@/server/features/domain-health/repositories/DomainHealthRepository";

const ctx = { auth: { organizationId: "org1", userId: "u1" } } as never;
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;
const ok = { domain: "a.com", class: "live_ok", httpStatus: 200, finalUrl: "https://a.com/", ga4Ids: [], gtmIds: [] };

describe("recheck_domain input hardening", () => {
  it("rejects non-domain input before any network call", async () => {
    for (const bad of ["127.0.0.1:3001", "localhost", "http://100.84.140.90:8317/v1"]) {
      const r = (await recheckDomainTool.handler({ domain: bad }, ctx)) as never;
      expect(text(r)).toMatch(/not a valid domain/);
    }
    expect(checkDomainHealth).not.toHaveBeenCalled();
  });

  it("rejects a projectId from another organization", async () => {
    resolveFleetProject.mockResolvedValueOnce({ error: "Project p9 was not found in this organization." });
    const r = (await recheckDomainTool.handler({ domain: "a.com", projectId: "p9" }, ctx)) as never;
    expect(text(r)).toMatch(/not found in this organization/);
    expect(checkDomainHealth).not.toHaveBeenCalled();
  });

  it("checks but does not store a domain outside the fleet", async () => {
    resolveFleetProject.mockResolvedValueOnce({ projectId: null, inFleet: false });
    checkDomainHealth.mockResolvedValueOnce(ok);
    const r = (await recheckDomainTool.handler({ domain: "a.com" }, ctx)) as never;
    expect(text(r)).toMatch(/not stored/);
    expect(DomainHealthRepository.recordCheck).not.toHaveBeenCalled();
  });

  it("stores a fleet domain under its own project", async () => {
    resolveFleetProject.mockResolvedValueOnce({ projectId: "p1", inFleet: true });
    checkDomainHealth.mockResolvedValueOnce(ok);
    await recheckDomainTool.handler({ domain: "https://www.A.com/" }, ctx);
    expect(DomainHealthRepository.recordCheck).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org1", projectId: "p1", trigger: "recheck" }),
    );
  });
});
