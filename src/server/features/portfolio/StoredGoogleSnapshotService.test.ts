import { describe, expect, it, vi } from "vitest";
import {
  mocks,
  scope,
  gscConnection,
  ga4Connection,
  gscCache,
  ga4Cache,
  periods,
  gscProvenance,
  ga4Provenance,
} from "./StoredGoogleSnapshotService.test-support";
import { StoredGoogleSnapshotService } from "./StoredGoogleSnapshotService";
import { ProjectAlertService } from "@/server/features/project-alerts/ProjectAlertService";

describe("StoredGoogleSnapshotService bindings and authorization", () => {
  it.each(["gsc", "ga4"] as const)(
    "rejects %s connection changes while storage is being read",
    async (source) => {
      const connection = source === "gsc" ? gscConnection : ga4Connection;
      const repository =
        source === "gsc" ? mocks.gscConnection : mocks.ga4Connection;
      repository
        .mockResolvedValueOnce(connection)
        .mockResolvedValue({ ...connection, updatedAt: "2026-10-19 12:00:00" });
      mocks.getCached.mockResolvedValue(
        source === "gsc"
          ? gscCache({ provenance: gscProvenance() })
          : ga4Cache({ provenance: ga4Provenance() }),
      );
      const evidence = (await StoredGoogleSnapshotService.read(scope))[source];
      expect(evidence).toMatchObject({
        status: "invalid",
        current: null,
        previous: null,
      });
    },
  );

  it.each(["gsc", "ga4"] as const)(
    "isolates %s storage failures without exposing raw errors or zero metrics",
    async (source) => {
      (source === "gsc"
        ? mocks.gscConnection
        : mocks.ga4Connection
      ).mockResolvedValue(source === "gsc" ? gscConnection : ga4Connection);
      mocks.getCached.mockRejectedValue(new Error("secret-storage-token"));
      const result = await StoredGoogleSnapshotService.read(scope);
      expect(result[source]).toMatchObject({
        status: "failed",
        current: null,
        previous: null,
      });
      expect(JSON.stringify(result)).not.toContain("secret-storage-token");
    },
  );

  it.each(["2026-10-18T12:00:00Z", "2026-10-20T12:00:00Z"])(
    "does not use a fresh timestamp to qualify periods from another collection day: %s",
    async (fetchedAt) => {
      vi.setSystemTime(new Date(fetchedAt));
      mocks.gscConnection.mockResolvedValue(gscConnection);
      mocks.ga4Connection.mockResolvedValue(ga4Connection);
      mocks.getCached.mockImplementation((key: string) =>
        key.startsWith("portfolio-gsc:")
          ? gscCache({ fetchedAt, provenance: gscProvenance() })
          : ga4Cache({ fetchedAt, provenance: ga4Provenance() }),
      );
      const { gsc, ga4 } = await StoredGoogleSnapshotService.read(scope);
      expect(gsc).toMatchObject({
        status: "invalid",
        current: null,
        previous: null,
      });
      expect(ga4).toMatchObject({
        status: "invalid",
        current: null,
        previous: null,
      });
    },
  );

  it("reports disconnected sources as unavailable without fabricating metrics", async () => {
    const result = await StoredGoogleSnapshotService.read(scope);
    for (const source of [result.gsc, result.ga4]) {
      expect(source).toMatchObject({
        status: "unavailable",
        property: null,
        fetchedAt: null,
        periods: null,
        current: null,
        previous: null,
      });
      expect(source.limitations.length).toBeGreaterThan(0);
    }
    expect(mocks.getCached).not.toHaveBeenCalled();
  });

  it("denies an inaccessible project before reading any evidence", async () => {
    mocks.project.mockResolvedValue(null);
    await expect(StoredGoogleSnapshotService.read(scope)).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    expect(mocks.gscConnection).not.toHaveBeenCalled();
    expect(mocks.ga4Connection).not.toHaveBeenCalled();
    expect(mocks.getCached).not.toHaveBeenCalled();
  });
});

describe("StoredGoogleSnapshotService GSC evidence", () => {
  it("returns qualified GSC evidence with exact periods and preserved request provenance", async () => {
    mocks.gscConnection.mockResolvedValue(gscConnection);
    mocks.getCached.mockResolvedValue(
      gscCache({ provenance: gscProvenance() }),
    );
    const { gsc } = await StoredGoogleSnapshotService.read(scope);
    expect(gsc).toMatchObject({
      status: "available",
      property: gscConnection.siteUrl,
      periods,
      current: { clicks: 70 },
      previous: { clicks: 100 },
      provenance: gscProvenance(),
    });
  });

  it.each([
    { organizationId: "other-org" },
    { projectId: "other-project" },
    { property: "sc-domain:other.com" },
    { binding: { ...gscProvenance().binding, id: "old-binding" } },
    { binding: { ...gscProvenance().binding, userId: "other-user" } },
    { binding: { ...gscProvenance().binding, accountId: "other-account" } },
    {
      binding: { ...gscProvenance().binding, updatedAt: "2026-09-01 00:00:00" },
    },
  ])("rejects changed GSC cache provenance scope: %j", async (changed) => {
    mocks.gscConnection.mockResolvedValue(gscConnection);
    mocks.getCached.mockResolvedValue(
      gscCache({ provenance: gscProvenance(changed) }),
    );
    const { gsc } = await StoredGoogleSnapshotService.read(scope);
    expect(gsc).toMatchObject({
      status: "invalid",
      current: null,
      previous: null,
      periods: null,
    });
  });

  it.each([
    {
      current: { ...periods.current, startDate: "2026-09-20" },
      previous: periods.previous,
    },
    {
      current: periods.current,
      previous: { startDate: "2026-08-21", endDate: "2026-09-17" },
    },
    {
      current: periods.current,
      previous: { startDate: "2026-08-23", endDate: "2026-09-19" },
    },
    {
      current: { startDate: "2026-10-01", endDate: "2026-09-01" },
      previous: periods.previous,
    },
    {
      current: { startDate: "2026-02-30", endDate: "2026-03-29" },
      previous: periods.previous,
    },
  ])(
    "rejects non-adjacent or non-28-day GSC windows: %j",
    async (changedPeriods) => {
      mocks.gscConnection.mockResolvedValue(gscConnection);
      mocks.getCached.mockResolvedValue(
        gscCache({ provenance: gscProvenance({ periods: changedPeriods }) }),
      );
      const { gsc } = await StoredGoogleSnapshotService.read(scope);
      expect(gsc).toMatchObject({
        status: "invalid",
        current: null,
        previous: null,
        periods: null,
      });
    },
  );

  it.each([
    { startDate: "2026-08-23" },
    { endDate: "2026-10-15" },
    { dimensions: ["query"] },
    { type: "image" },
    { startRow: 1 },
    { rowLimit: 55 },
    {
      dimensionFilterGroups: [
        {
          groupType: "and",
          filters: [
            { dimension: "country", operator: "equals", expression: "usa" },
          ],
        },
      ],
    },
    { aggregationType: "byPage" },
  ])("rejects a different GSC request scope: %j", async (changedRequest) => {
    mocks.gscConnection.mockResolvedValue(gscConnection);
    mocks.getCached.mockResolvedValue(
      gscCache({
        provenance: gscProvenance({
          request: { ...gscProvenance().request, ...changedRequest },
        }),
      }),
    );
    const { gsc } = await StoredGoogleSnapshotService.read(scope);
    expect(gsc).toMatchObject({
      status: "invalid",
      current: null,
      previous: null,
    });
  });

  it.each([
    {
      changed: { request: { ...gscProvenance().request, dataState: "all" } },
      limitation: /final.*not requested/i,
    },
    {
      changed: { quality: { ...gscProvenance().quality, complete: false } },
      limitation: /completeness.*unknown/i,
    },
  ])(
    "retains unqualified GSC provenance with explicit limitations: $limitation",
    async ({ changed, limitation }) => {
      mocks.gscConnection.mockResolvedValue(gscConnection);
      mocks.getCached.mockResolvedValue(
        gscCache({ provenance: gscProvenance(changed) }),
      );
      const { gsc } = await StoredGoogleSnapshotService.read(scope);
      expect(gsc).toMatchObject({ status: "available", periods });
      expect(gsc.limitations.join(" ")).toMatch(limitation);
    },
  );

  it.each([{ rowsValid: false }, { requestVerified: false }, { rowCount: 57 }])(
    "rejects invalid or unverified GSC quality: %j",
    async (changedQuality) => {
      mocks.gscConnection.mockResolvedValue(gscConnection);
      mocks.getCached.mockResolvedValue(
        gscCache({
          provenance: gscProvenance({
            quality: { ...gscProvenance().quality, ...changedQuality },
          }),
        }),
      );
      const { gsc } = await StoredGoogleSnapshotService.read(scope);
      expect(gsc).toMatchObject({
        status: "invalid",
        current: null,
        previous: null,
      });
    },
  );

  it.each([{ organizationId: "other-org" }, { projectId: "other-project" }])(
    "rejects a mis-scoped GSC binding before reading its cache: %j",
    async (changed) => {
      mocks.gscConnection.mockResolvedValue({ ...gscConnection, ...changed });
      const { gsc } = await StoredGoogleSnapshotService.read(scope);
      expect(gsc).toMatchObject({
        status: "invalid",
        property: null,
        current: null,
        previous: null,
      });
      expect(mocks.getCached).not.toHaveBeenCalled();
    },
  );

  it.each([null, undefined])(
    "reports missing or expired GSC storage without zero metrics: %j",
    async (cached) => {
      mocks.gscConnection.mockResolvedValue(gscConnection);
      mocks.getCached.mockResolvedValue(cached);
      const { gsc } = await StoredGoogleSnapshotService.read(scope);
      expect(gsc).toMatchObject({
        status: "unavailable",
        property: gscConnection.siteUrl,
        current: null,
        previous: null,
      });
      expect(gsc.limitations.join(" ")).toMatch(/missing or expired/i);
    },
  );

  it.each([
    { clicks: -1 },
    { prevClicks: Number.NaN },
    { impressions: Infinity },
    { clicks: "70" },
    { fetchedAt: "not-a-date" },
  ])("rejects malformed stored GSC values: %j", async (changed) => {
    mocks.gscConnection.mockResolvedValue(gscConnection);
    mocks.getCached.mockResolvedValue(gscCache(changed));
    const { gsc } = await StoredGoogleSnapshotService.read(scope);
    expect(gsc).toMatchObject({
      status: "invalid",
      current: null,
      previous: null,
    });
  });

  it("treats an error-shaped GSC zero cache as failed and never exposes provider text", async () => {
    mocks.gscConnection.mockResolvedValue(gscConnection);
    mocks.getCached.mockResolvedValue(
      gscCache({
        clicks: 0,
        prevClicks: 0,
        error: "secret-provider-url token=private",
      }),
    );
    const { gsc } = await StoredGoogleSnapshotService.read(scope);
    expect(gsc).toMatchObject({
      status: "failed",
      current: null,
      previous: null,
    });
    expect(JSON.stringify(gsc)).not.toContain("secret-provider");
  });

  it.each([
    { age: 12 * 60 * 60 * 1000 + 1, status: "stale" },
    { age: -1, status: "invalid" },
  ])("rejects out-of-range GSC snapshot age: $age", async ({ age, status }) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
      mocks.gscConnection.mockResolvedValue(gscConnection);
      mocks.getCached.mockResolvedValue(
        gscCache({ fetchedAt: new Date(Date.now() - age).toISOString() }),
      );
      const { gsc } = await StoredGoogleSnapshotService.read(scope);
      expect(gsc).toMatchObject({ status, current: null, previous: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([gscConnection.gscAccountId, null])(
    "shows legacy GSC totals and keeps alerts unknown with account %s",
    async (gscAccountId) => {
      mocks.gscConnection.mockResolvedValue({ ...gscConnection, gscAccountId });
      mocks.getCached.mockResolvedValue(gscCache());
      const { gsc } = await StoredGoogleSnapshotService.read(scope);
      expect(gsc).toMatchObject({
        status: "legacy",
        property: "sc-domain:example.com",
        periods: null,
        current: { clicks: 70, impressions: 800, position: 4 },
        previous: { clicks: 100, impressions: 1000, position: 3 },
      });
      expect(gsc).not.toHaveProperty("provenance");
      expect(gsc.limitations.join(" ")).toMatch(/exact.*period|final/i);
      const preview = await ProjectAlertService.preview(scope);
      expect(preview.alerts[0]).toMatchObject({
        state: "unknown",
        dropPercent: null,
      });
      expect(mocks.getCached).toHaveBeenCalledWith(
        "portfolio-gsc:v1:project-1:sc-domain:example.com",
      );
    },
  );
});
