import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectAlertService } from "./ProjectAlertService";
import type { StoredGscEvidence } from "@/server/features/portfolio/StoredGoogleSnapshotService";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/server/features/portfolio/StoredGoogleSnapshotService", () => ({
  StoredGoogleSnapshotService: { read: mocks.read },
}));
const scope = { projectId: "project-1", organizationId: "org-1" };
const periods = {
  current: { startDate: "2026-09-19", endDate: "2026-10-16" },
  previous: { startDate: "2026-08-22", endDate: "2026-09-18" },
};
function evidence(current = 70, previous = 100): StoredGscEvidence {
  return {
    status: "available",
    property: "sc-domain:example.com",
    fetchedAt: new Date().toISOString(),
    periods,
    limitations: [
      "Final GSC data was requested; provider finality is not independently confirmed.",
    ],
    current: { clicks: current, impressions: 800, position: 4 },
    previous: { clicks: previous, impressions: 1000, position: 3 },
    provenance: {
      version: 1,
      kind: "gsc",
      ...scope,
      property: "sc-domain:example.com",
      binding: {
        id: "gsc-1",
        userId: "user-1",
        accountId: "google-1",
        updatedAt: "2026-10-01 00:00:00",
      },
      periods,
      dateBasis: {
        timeZone: "America/Los_Angeles",
        windowAnchor: "utc-date",
        lagDays: 3,
      },
      request: {
        startDate: "2026-08-22",
        endDate: "2026-10-16",
        dimensions: ["date"],
        type: "web",
        dataState: "final",
        rowLimit: 200,
      },
      quality: {
        complete: true,
        requestVerified: true,
        rowsValid: true,
        rowCount: 2,
      },
    },
  };
}
function useEvidence(gsc: StoredGscEvidence) {
  mocks.read.mockResolvedValue({ gsc, ga4: { status: "unavailable" } });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
  useEvidence(evidence());
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ProjectAlertService.preview", () => {
  it.each([
    [70, 100, "triggered", 30],
    [71, 100, "clear", 29],
    [0, 100, "triggered", 100],
    [35, 50, "triggered", 30],
    [51, 50, "clear", -2],
  ] as const)(
    "evaluates qualified current=%i previous=%i as %s",
    async (current, previous, state, dropPercent) => {
      useEvidence(evidence(current, previous));
      const { alerts } = await ProjectAlertService.preview(scope);
      expect(alerts[0]).toMatchObject({ state, dropPercent });
    },
  );

  it.each([0, 49])(
    "keeps previous-period clicks %i below the minimum unknown",
    async (previous) => {
      useEvidence(evidence(0, previous));
      const { alerts } = await ProjectAlertService.preview(scope);
      expect(alerts[0]).toMatchObject({ state: "unknown", dropPercent: null });
    },
  );

  it.each(["legacy", "unavailable", "stale", "failed", "invalid"] as const)(
    "never evaluates %s evidence as an alert",
    async (status) => {
      useEvidence({ ...evidence(), status });
      const { alerts } = await ProjectAlertService.preview(scope);
      expect(alerts[0]).toMatchObject({ state: "unknown", dropPercent: null });
    },
  );

  it.each([
    { provenance: undefined },
    { current: null },
    { previous: null },
    { periods: null },
    { fetchedAt: null },
    { fetchedAt: "2026-10-18T23:59:59.999Z" },
    { fetchedAt: "2026-10-19T12:00:00.001Z" },
  ])("keeps missing or out-of-date evidence unknown: %j", async (changed) => {
    useEvidence({ ...evidence(), ...changed });
    const { alerts } = await ProjectAlertService.preview(scope);
    expect(alerts[0]).toMatchObject({ state: "unknown", dropPercent: null });
  });

  it.each([
    { complete: false },
    { rowsValid: false },
    { requestVerified: false },
  ])("never qualifies incomplete GSC quality: %j", async (changed) => {
    const gsc = evidence();
    gsc.provenance!.quality = { ...gsc.provenance!.quality, ...changed };
    useEvidence(gsc);
    expect((await ProjectAlertService.preview(scope)).alerts[0]).toMatchObject({
      state: "unknown",
      dropPercent: null,
    });
  });

  it.each([
    { projectId: "other-project" },
    { organizationId: "other-org" },
    { property: "sc-domain:other.com" },
    {
      request: { ...evidence().provenance!.request, dataState: "all" as const },
    },
    {
      periods: {
        ...periods,
        previous: { startDate: "2026-08-21", endDate: "2026-09-17" },
      },
    },
  ])(
    "keeps changed or non-comparable provenance unknown: %j",
    async (changed) => {
      const gsc = evidence();
      gsc.provenance = { ...gsc.provenance!, ...changed };
      useEvidence(gsc);
      expect(
        (await ProjectAlertService.preview(scope)).alerts[0],
      ).toMatchObject({ state: "unknown", dropPercent: null });
    },
  );

  it("preserves scoped access denial instead of returning a seemingly clear alert", async () => {
    const denied = new Error("NOT_FOUND");
    mocks.read.mockRejectedValue(denied);
    await expect(ProjectAlertService.preview(scope)).rejects.toBe(denied);
  });

  it("evaluates a 30 percent GSC click drop from stored qualified evidence only", async () => {
    const result = await ProjectAlertService.preview(scope);
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(scope);
    expect(result).toMatchObject({
      projectId: "project-1",
      evaluatedAt: "2026-10-19T12:00:00.000Z",
      alerts: [
        {
          id: "gsc-click-drop",
          state: "triggered",
          dropPercent: 30,
          evidence: evidence(),
        },
      ],
    });
  });
});
