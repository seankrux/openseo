import {
  bing,
  client,
  id,
  mocks,
  now,
  org,
  seed,
} from "../../../../tests/support/fleet-dashboard";
import { getCached, setCached } from "@/server/lib/r2-cache";
import { GA4_OAUTH_PROVIDER_ID } from "@/shared/ga4";
import { describe, expect, it, vi } from "vitest";

import {
  buildFleetDashboard,
  getFleetDashboard,
  warmFleetCaches,
} from "./FleetDashboardService";
describe("Bing inventory", () => {
  it("preserves provider-confirmed zero but leaves empty snapshots and mixed date-window totals unknown", async () => {
    await seed(2, { bing: true, gsc: false });
    mocks.bing.set(id(0), bing(0));
    mocks.bing.set(id(1), bing(1, { performance: [] }));
    const dashboard = await buildFleetDashboard(org);
    expect(dashboard.inventory[0].bing.metrics).toMatchObject({
      clicks: 0,
      impressions: 0,
      ctr: null,
    });
    expect(dashboard.inventory[0].bing.metrics).not.toHaveProperty("position");
    expect(dashboard.inventory[1].bing.metrics).toMatchObject({
      clicks: null,
      impressions: null,
    });
    expect(dashboard.bing).toMatchObject({
      sites: 2,
      clicks: null,
      impressions: null,
      dateBasis: "provider-returned",
    });
  });

  it("never exposes or refreshes a Bing binding in hosted mode even with cached provider data", async () => {
    await seed(1, { bing: true, gsc: false });
    mocks.bing.set(id(0), bing(0));
    await getFleetDashboard(org); // Populate a permitted v4 dashboard first.
    mocks.settings.AUTH_MODE = "better_auth";
    const dashboard = await getFleetDashboard(org);
    expect(dashboard.inventory[0].bing).toMatchObject({
      status: "unlinked",
      property: null,
      metrics: null,
    });
    expect(dashboard.coverage.bingLinked).toBe(0);
    await warmFleetCaches(org);
    expect(mocks.refreshBing).not.toHaveBeenCalled();
  });

  it("warms scoped Bing bindings and counts its two requests against the same budget", async () => {
    await seed(4, { bing: true, gsc: false });
    const result = await warmFleetCaches(org, 4);
    expect(result.budgetUsed).toBe(4);
    expect(mocks.refreshBing).toHaveBeenCalledTimes(2);
    expect(mocks.refreshBing).toHaveBeenCalledWith({
      organizationId: org,
      projectId: id(0),
    });
  });
});

describe("bounded resumable warming", () => {
  it("continues beyond a perpetually missing prefix using persisted stable project/provider identities", async () => {
    await seed(4);
    await warmFleetCaches(org, 3); // One account preflight plus two site requests.
    expect(
      mocks.performance.mock.calls.map(([input]) => input.projectId),
    ).toEqual([id(0), id(0)]);
    // Cache eviction makes the first project missing again; it must not reset progress.
    for (const key of mocks.objects.keys())
      if (key.includes("portfolio-gsc")) mocks.objects.delete(key);
    await client.execute({
      sql: "DELETE FROM projects WHERE id = ?",
      args: [id(3)],
    });
    await warmFleetCaches(org, 2);
    expect(
      mocks.performance.mock.calls.slice(2).map(([input]) => input.projectId),
    ).toEqual([id(1), id(1)]);
    expect(mocks.token).toHaveBeenCalledTimes(1);
  });

  it("preflights a revoked account once, projects the failure across its sites, and recovers after grant revision changes", async () => {
    await seed(50, { ga4: true });
    mocks.token.mockImplementation(async ({ providerId }) => {
      if (providerId === GA4_OAUTH_PROVIDER_ID) throw new Error("revoked");
      return "test-token";
    });
    await warmFleetCaches(org, 10);
    expect(mocks.token).toHaveBeenCalledTimes(2);
    expect(mocks.token).toHaveBeenCalledWith({
      providerId: GA4_OAUTH_PROVIDER_ID,
      userId: "user-1",
      accountId: "account-ga4",
    });
    expect(mocks.runReport).not.toHaveBeenCalled();
    expect(
      (await buildFleetDashboard(org)).inventory.every(
        (r) => r.ga4.status === "error" && r.ga4.metrics === null,
      ),
    ).toBe(true);
    mocks.token.mockResolvedValue("reconnected-token");
    await client.execute({
      sql: "UPDATE account SET updated_at = ? WHERE id = 'grant-ga4'",
      args: [Date.now()],
    });
    await warmFleetCaches(org, 10);
    expect(mocks.runReport).toHaveBeenCalled();
    expect(
      (await buildFleetDashboard(org)).inventory.some(
        (r) => r.ga4.status === "available" && r.ga4.metrics?.sessions === 0,
      ),
    ).toBe(true);
  });

  it("stops scheduling at its deadline rather than spawning replacements for three hung provider calls", async () => {
    await seed(100);
    mocks.performance.mockImplementation(() => new Promise(() => {}));
    const warming = warmFleetCaches(org, 90);
    await vi.waitFor(() => expect(mocks.performance).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(100_001);
    expect(await warming).toMatchObject({ timedOut: true, ran: 3 });
    expect(mocks.performance).toHaveBeenCalledTimes(3);
  });
});

it("ignores old snapshot versions and rebuilds a v4 snapshot past the 30-minute max-age without provider calls", async () => {
  await seed(1);
  await setCached(
    `fleet-dashboard:v2:${org}`,
    { generatedAt: now(), coverage: { projects: 9999 } },
    21600,
  );
  const first = await getFleetDashboard(org);
  expect(first.coverage.projects).toBe(1);
  await client.execute({
    sql: "INSERT INTO projects (id, name, organization_id) VALUES ('new', 'new', ?)",
    args: [org],
  });
  expect((await getFleetDashboard(org)).coverage.projects).toBe(1);
  vi.setSystemTime(new Date(Date.now() + 31 * 60 * 1000));
  const second = await getFleetDashboard(org);
  expect(second.coverage.projects).toBe(2);
  expect(second.generatedAt).not.toBe(first.generatedAt);
  expect(mocks.performance).not.toHaveBeenCalled();
  expect(await getCached(`fleet-dashboard:v4:${org}`)).toMatchObject({
    generatedAt: second.generatedAt,
  });
});
