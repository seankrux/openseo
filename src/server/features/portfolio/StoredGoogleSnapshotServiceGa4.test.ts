import { describe, expect, it, vi } from "vitest";
import {
  mocks,
  scope,
  ga4Connection,
  ga4Cache,
  ga4Periods,
  ga4Provenance,
} from "./StoredGoogleSnapshotService.test-support";
import { StoredGoogleSnapshotService } from "./StoredGoogleSnapshotService";

describe("StoredGoogleSnapshotService GA4 evidence", () => {
  it("ignores aggregates cached with the old UTC date window", async () => {
    mocks.ga4Connection.mockResolvedValue(ga4Connection);
    mocks.getCached.mockImplementation(async (key: string) =>
      key.startsWith("portfolio-ga4:v1:") ? ga4Cache() : null,
    );
    const { ga4 } = await StoredGoogleSnapshotService.read(scope);
    expect(ga4).toMatchObject({
      status: "unavailable",
      current: null,
      previous: null,
    });
  });

  it("returns versioned all-channel GA4 evidence with property timezone and exact request", async () => {
    mocks.ga4Connection.mockResolvedValue(ga4Connection);
    mocks.getCached.mockResolvedValue(
      ga4Cache({ provenance: ga4Provenance() }),
    );
    const { ga4 } = await StoredGoogleSnapshotService.read(scope);
    expect(ga4).toMatchObject({
      status: "available",
      property: ga4Connection.propertyId,
      periods: ga4Periods,
      provenance: ga4Provenance(),
      current: { sessions: 70, activeUsers: 60 },
      previous: { sessions: 100, activeUsers: 90 },
    });
    expect(ga4.limitations.join(" ")).toMatch(/all-channel/i);
  });

  it.each([
    { organizationId: "other-org" },
    { projectId: "other-project" },
    { property: "5678" },
    { binding: { ...ga4Provenance().binding, id: "old-binding" } },
    { binding: { ...ga4Provenance().binding, userId: "other-user" } },
    { binding: { ...ga4Provenance().binding, accountId: "other-account" } },
    { binding: { ...ga4Provenance().binding, updatedAt: "old-time" } },
  ])("rejects changed GA4 cache provenance scope: %j", async (changed) => {
    mocks.ga4Connection.mockResolvedValue(ga4Connection);
    mocks.getCached.mockResolvedValue(
      ga4Cache({ provenance: ga4Provenance(changed) }),
    );
    const { ga4 } = await StoredGoogleSnapshotService.read(scope);
    expect(ga4).toMatchObject({
      status: "invalid",
      current: null,
      previous: null,
      periods: null,
    });
  });

  it.each([
    { dateRanges: [ga4Periods.previous, ga4Periods.current] },
    { dateRanges: [ga4Periods.current] },
    { dimensions: [{ name: "sessionDefaultChannelGroup" }] },
    { metrics: [{ name: "sessions" }] },
    { offset: "1" },
    { limit: "1" },
    { dimensionFilter: { filter: {} } },
  ])("rejects a different GA4 request scope: %j", async (changedRequest) => {
    mocks.ga4Connection.mockResolvedValue(ga4Connection);
    mocks.getCached.mockResolvedValue(
      ga4Cache({
        provenance: ga4Provenance({
          request: { ...ga4Provenance().request, ...changedRequest },
        }),
      }),
    );
    const { ga4 } = await StoredGoogleSnapshotService.read(scope);
    expect(ga4).toMatchObject({
      status: "invalid",
      current: null,
      previous: null,
    });
  });

  it.each([
    { changed: { sampled: true }, limitation: /sampl/i },
    { changed: { thresholded: true }, limitation: /threshold/i },
    { changed: { otherRowLoss: true }, limitation: /other.row/i },
    { changed: { restricted: true }, limitation: /restrict/i },
    {
      changed: {
        complete: false,
        sampled: null,
        thresholded: null,
        otherRowLoss: null,
        restricted: null,
      },
      limitation: /quality.*unknown/i,
    },
  ])(
    "discloses GA4 quality limitations: $limitation",
    async ({ changed, limitation }) => {
      mocks.ga4Connection.mockResolvedValue(ga4Connection);
      mocks.getCached.mockResolvedValue(
        ga4Cache({
          provenance: ga4Provenance({
            quality: { ...ga4Provenance().quality, ...changed },
          }),
        }),
      );
      const { ga4 } = await StoredGoogleSnapshotService.read(scope);
      expect(ga4.status).toBe("available");
      expect(ga4.limitations.join(" ")).toMatch(limitation);
    },
  );

  it.each([{ rowsValid: false }, { rowCount: 3 }])(
    "rejects GA4 provenance with unvalidated or impossible aggregate rows: %j",
    async (quality) => {
      mocks.ga4Connection.mockResolvedValue(ga4Connection);
      mocks.getCached.mockResolvedValue(
        ga4Cache({
          provenance: ga4Provenance({
            quality: { ...ga4Provenance().quality, ...quality },
          }),
        }),
      );
      const { ga4 } = await StoredGoogleSnapshotService.read(scope);
      expect(ga4).toMatchObject({
        status: "invalid",
        current: null,
        previous: null,
      });
    },
  );

  it("shows legacy GA4 totals explicitly as all-channel traffic, not organic or conversions", async () => {
    mocks.ga4Connection.mockResolvedValue(ga4Connection);
    mocks.getCached.mockResolvedValue(ga4Cache());
    const { ga4 } = await StoredGoogleSnapshotService.read(scope);
    expect(ga4).toMatchObject({
      status: "legacy",
      property: "1234",
      periods: null,
      current: { sessions: 70, activeUsers: 60 },
      previous: { sessions: 100, activeUsers: 90 },
    });
    expect(ga4.limitations.join(" ")).toMatch(/all.channel/i);
    expect(mocks.getCached).toHaveBeenCalledWith(
      "portfolio-ga4:v2:project-1:1234",
    );
  });

  it.each([{ organizationId: "other-org" }, { projectId: "other-project" }])(
    "rejects a mis-scoped GA4 binding before reading its cache: %j",
    async (changed) => {
      mocks.ga4Connection.mockResolvedValue({ ...ga4Connection, ...changed });
      const { ga4 } = await StoredGoogleSnapshotService.read(scope);
      expect(ga4).toMatchObject({
        status: "invalid",
        property: null,
        current: null,
        previous: null,
      });
      expect(mocks.getCached).not.toHaveBeenCalled();
    },
  );

  it.each([
    { cached: null, status: "unavailable" },
    { cached: ga4Cache({ sessions: -1 }), status: "invalid" },
    { cached: ga4Cache({ activeUsers: "3" }), status: "invalid" },
    { cached: ga4Cache({ prevSessions: Infinity }), status: "invalid" },
    { cached: ga4Cache({ fetchedAt: "bad-date" }), status: "invalid" },
  ])(
    "rejects absent or invalid GA4 storage: $status",
    async ({ cached, status }) => {
      mocks.ga4Connection.mockResolvedValue(ga4Connection);
      mocks.getCached.mockResolvedValue(cached);
      const { ga4 } = await StoredGoogleSnapshotService.read(scope);
      expect(ga4).toMatchObject({
        status,
        property: "1234",
        current: null,
        previous: null,
      });
    },
  );

  it("treats an error-shaped GA4 cache as failed without exposing error text", async () => {
    mocks.ga4Connection.mockResolvedValue(ga4Connection);
    mocks.getCached.mockResolvedValue(
      ga4Cache({ sessions: 0, error: "secret-provider-url token=private" }),
    );
    const { ga4 } = await StoredGoogleSnapshotService.read(scope);
    expect(ga4).toMatchObject({
      status: "failed",
      current: null,
      previous: null,
    });
    expect(JSON.stringify(ga4)).not.toContain("secret-provider");
  });

  it.each([
    { age: 12 * 60 * 60 * 1000 + 1, status: "stale" },
    { age: -1, status: "invalid" },
  ])("rejects out-of-range GA4 snapshot age: $age", async ({ age, status }) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
      mocks.ga4Connection.mockResolvedValue(ga4Connection);
      mocks.getCached.mockResolvedValue(
        ga4Cache({ fetchedAt: new Date(Date.now() - age).toISOString() }),
      );
      const { ga4 } = await StoredGoogleSnapshotService.read(scope);
      expect(ga4).toMatchObject({ status, current: null, previous: null });
    } finally {
      vi.useRealTimers();
    }
  });
});
