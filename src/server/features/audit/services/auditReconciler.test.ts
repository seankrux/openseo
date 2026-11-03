import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  terminate: vi.fn(),
  failAudit: vi.fn(),
  get: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { SITE_AUDIT_WORKFLOW: { get: mocks.get } },
}));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({ audits: {}, projects: {} }));
vi.mock("@/db/provider", () => ({ getDatabaseProvider: () => "d1" }));
vi.mock("@/server/lib/posthog", () => ({ captureServerEvent: vi.fn() }));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: { failAudit: mocks.failAudit },
}));

import { reconcileRunningAudit } from "./auditReconciler";

const HOUR = 60 * 60 * 1000;
const d1Time = (agoMs: number) =>
  new Date(Date.now() - agoMs).toISOString().replace("T", " ").slice(0, 19);
const audit = (agoMs: number) => ({
  id: "a1",
  workflowInstanceId: "a1",
  startedAt: d1Time(agoMs),
  currentPhase: "discovery",
});

describe("reconcileRunningAudit stale ceiling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AUDIT_STALE_FAIL_AFTER_HOURS;
    mocks.terminate.mockResolvedValue(undefined);
    mocks.get.mockResolvedValue({
      status: mocks.status,
      terminate: mocks.terminate,
    });
  });

  it("leaves a recent running audit alone", async () => {
    mocks.status.mockResolvedValue({ status: "running" });
    expect(await reconcileRunningAudit(audit(HOUR))).toBeNull();
    expect(mocks.failAudit).not.toHaveBeenCalled();
  });

  it("fails and terminates a zombie still 'running' past 6h", async () => {
    mocks.status.mockResolvedValue({ status: "running" });
    const info = await reconcileRunningAudit(audit(3 * 24 * HOUR));
    expect(info?.errorCode).toBe("stalled");
    expect(mocks.terminate).toHaveBeenCalled();
    expect(mocks.failAudit).toHaveBeenCalledWith(
      "a1",
      "a1",
      expect.objectContaining({
        errorCode: "stalled",
        failedPhase: "discovery",
      }),
    );
  });

  it("honours AUDIT_STALE_FAIL_AFTER_HOURS", async () => {
    process.env.AUDIT_STALE_FAIL_AFTER_HOURS = "12";
    mocks.status.mockResolvedValue({ status: "running" });
    expect(await reconcileRunningAudit(audit(8 * HOUR))).toBeNull();
    expect((await reconcileRunningAudit(audit(13 * HOUR)))?.errorCode).toBe(
      "stalled",
    );
  });

  it("fails an old audit whose status read keeps erroring", async () => {
    mocks.get.mockRejectedValue(new Error("internal error"));
    expect(await reconcileRunningAudit(audit(HOUR))).toBeNull();
    expect((await reconcileRunningAudit(audit(7 * HOUR)))?.errorCode).toBe(
      "stalled",
    );
  });
});
