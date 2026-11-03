import {
  client,
  ga4,
  gsc,
  id,
  mocks,
  org,
  seed,
  site,
} from "../../../../tests/support/fleet-dashboard";
import { setCached } from "@/server/lib/r2-cache";
import { describe, expect, it, vi } from "vitest";

import {
  buildFleetDashboard,
  getFleetDashboard,
  getPortfolioOverview,
} from "./FleetDashboardService";
import { cacheKey, ga4CacheKey } from "./PortfolioService";
describe("cache-only complete fleet inventory", () => {
  it("includes all 1,628 active scoped projects, even when every provider cache is missing", async () => {
    await seed(1628, { ga4: true, bing: true });
    await client.execute(
      "INSERT INTO projects (id, name, organization_id, archived_at) VALUES ('archived', 'archived', 'delegated-local-admin', '2026-01-01'), ('foreign', 'foreign', 'another-org', NULL)",
    );
    const dashboard = await buildFleetDashboard(org);
    expect(dashboard.inventory).toHaveLength(1628);
    expect(dashboard.coverage).toMatchObject({
      projects: 1628,
      gscLinked: 1628,
      ga4Linked: 1628,
      bingLinked: 1628,
      gscCached: 0,
      ga4Cached: 0,
      bingCached: 0,
    });
    expect(dashboard.inventory.at(-1)).toMatchObject({
      projectId: "p1627",
      gsc: {
        status: "missing",
        accountId: "account-gsc",
        email: "gsc@example.test",
        metrics: null,
      },
      ga4: { status: "missing", metrics: null },
      bing: { status: "missing", metrics: null },
    });
    expect(mocks.performance).not.toHaveBeenCalled();
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.refreshBing).not.toHaveBeenCalled();
  });

  it("keeps genuine zero available but excludes stale, malformed, error and missing evidence", async () => {
    await seed(5, { ga4: true });
    await setCached(cacheKey(id(0), site(0)), gsc(), 3600);
    await setCached(ga4CacheKey(id(0), "1234"), ga4(), 3600);
    await setCached(
      cacheKey(id(1), site(1)),
      gsc({ fetchedAt: "2026-10-26T23:00:00Z", clicks: 900 }),
      -1,
    );
    await setCached(
      cacheKey(id(2), site(2)),
      gsc({ error: "revoked", clicks: 900 }),
      3600,
    );
    await setCached(cacheKey(id(3), site(3)), gsc({ clicks: "900" }), 3600);
    const dashboard = await buildFleetDashboard(org);
    expect(dashboard.inventory.map((r) => r.gsc.status)).toEqual([
      "available",
      "stale",
      "error",
      "error",
      "missing",
    ]);
    expect(dashboard.inventory[0].gsc.metrics?.clicks).toBe(0);
    // Stale evidence keeps its earlier numbers for display only: the 900
    // clicks must not reach the totals below.
    expect(dashboard.inventory[1].gsc).toMatchObject({
      fetchedAt: "2026-10-26T23:00:00Z",
      metrics: { clicks: 900 },
    });
    expect(dashboard.gsc).toMatchObject({ sites: 1, clicks: 0, errors: 2 });
    expect(dashboard.ga4).toMatchObject({
      sites: 1,
      sessions: 0,
      zeroSessionSites: 1,
    });
    expect(dashboard.inventory[4].ga4.metrics).toBeNull();
  });

  it("rejects a recent cache from the previous reporting date or a replaced connection", async () => {
    await seed(2, { ga4: true });
    vi.setSystemTime(new Date("2026-10-28T00:05:00Z"));
    await setCached(
      cacheKey(id(0), site(0)),
      gsc({ fetchedAt: "2026-10-27T23:55:00Z", clicks: 800 }),
      3600,
    );
    await setCached(
      ga4CacheKey(id(0), "1234"),
      ga4({ fetchedAt: "2026-10-27T15:55:00Z", sessions: 800 }),
      3600,
    );
    await setCached(
      cacheKey(id(1), site(1)),
      gsc({ fetchedAt: "2026-10-28T00:00:00Z", clicks: 800 }),
      3600,
    );
    await client.execute({
      sql: "UPDATE gsc_connections SET updated_at = ? WHERE project_id = ?",
      args: ["2026-10-28 00:01:00", id(1)],
    });
    const dashboard = await buildFleetDashboard(org);
    expect(dashboard.inventory[0].gsc.status).toBe("stale");
    expect(dashboard.inventory[0].ga4.status).toBe("stale");
    expect(dashboard.inventory[1].gsc.status).toBe("stale");
    expect(dashboard.gsc.sites).toBe(0);
  });

  it("does not silently use a fresh cache after the exact Google grant is removed", async () => {
    await seed(1);
    await setCached(cacheKey(id(0), site(0)), gsc(), 3600);
    await client.execute("DELETE FROM account WHERE id = 'grant-gsc'");
    expect((await buildFleetDashboard(org)).inventory[0].gsc).toMatchObject({
      status: "error",
      accountId: "account-gsc",
      metrics: null,
    });
  });
});

describe("site table from the snapshot", () => {
  it("maps available and failed evidence to rows and counts the rest as pending, without provider calls", async () => {
    await seed(3, { ga4: true });
    await setCached(cacheKey(id(0), site(0)), gsc({ clicks: 7 }), 3600);
    await setCached(ga4CacheKey(id(0), "1234"), ga4(), 3600);
    await setCached(
      cacheKey(id(1), site(1)),
      gsc({ error: "revoked", clicks: 900 }),
      3600,
    );
    const overview = await getPortfolioOverview(org);
    expect(overview.rows.map((r) => r.gsc?.clicks ?? null)).toEqual([
      7,
      0,
      null,
    ]);
    expect(overview.rows[1].gsc?.error).toBe("revoked");
    expect(overview.rows[0].ga4).toMatchObject({ sessions: 0 });
    expect(overview).toMatchObject({
      pendingGsc: 1,
      pendingGa4: 2,
      pending: 3,
    });
    expect(mocks.performance).not.toHaveBeenCalled();
    expect(mocks.runReport).not.toHaveBeenCalled();
  });

  it("keeps showing earlier numbers and failures while expired entries refresh", async () => {
    await seed(3, { ga4: true });
    // Past the 12-hour lifetime: shown, marked as refreshing, not in totals.
    await setCached(
      cacheKey(id(0), site(0)),
      gsc({ clicks: 7, fetchedAt: hoursAgo(13) }),
      3600,
    );
    // A failure due for retry is still the last thing Google said.
    await setCached(
      ga4CacheKey(id(1), "1234"),
      ga4({
        error: "Could not mint a Google Analytics access token.",
        fetchedAt: hoursAgo(2),
      }),
      3600,
    );

    const overview = await getPortfolioOverview(org);

    expect(overview.rows[0].gsc).toMatchObject({ clicks: 7, stale: true });
    expect(overview.rows[1].ga4?.error).toBe(
      "Could not mint a Google Analytics access token.",
    );
    expect(overview).toMatchObject({
      pendingGsc: 2,
      pendingGa4: 2,
      refreshingGsc: 1,
      refreshingGa4: 0,
    });
    const dashboard = await getFleetDashboard(org);
    expect(dashboard.providerIssues).toContainEqual(
      expect.objectContaining({ provider: "ga4", sites: 1 }),
    );
  });

  it("never shows numbers fetched before the site was re-bound to another account", async () => {
    await seed(1);
    await setCached(
      cacheKey(id(0), site(0)),
      gsc({ clicks: 7, fetchedAt: "2026-10-27T10:00:00Z" }),
      3600,
    );
    await client.execute({
      sql: "UPDATE gsc_connections SET updated_at = ? WHERE project_id = ?",
      args: ["2026-10-27 11:00:00", id(0)],
    });

    const overview = await getPortfolioOverview(org);

    expect(overview.rows[0].gsc).toBeNull();
    expect(overview).toMatchObject({ pendingGsc: 1, refreshingGsc: 0 });
  });
});

function hoursAgo(h: number) {
  return new Date(Date.now() - h * 3600_000).toISOString();
}
