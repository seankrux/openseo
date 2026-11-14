import { createClient, type InStatement } from "@libsql/client";
import { getTableColumns, getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  account,
  audits,
  auditIssues,
  bingSiteBindings,
  domainHealthCurrent,
  ga4Connections,
  gscConnections,
  projects,
} from "@/db/schema";
import { getCached, setCached } from "@/server/lib/r2-cache";
import type { BingSnapshot } from "@/server/features/bing/BingSnapshot";
import { GA4_OAUTH_PROVIDER_ID } from "@/shared/ga4";
import { GSC_OAUTH_PROVIDER_ID } from "@/shared/gsc";
import {
  buildFleetDashboard,
  getFleetDashboard,
  getPortfolioOverview,
  runScheduledFleetDashboard,
  warmFleetCaches,
} from "./FleetDashboardService";
import { cacheKey, ga4CacheKey } from "./PortfolioService";

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  performance: vi.fn(),
  runReport: vi.fn(),
  getBing: vi.fn(),
  refreshBing: vi.fn(),
  settings: { AUTH_MODE: "local_noauth" },
  objects: new Map<
    string,
    { value: string; customMetadata: Record<string, string> }
  >(),
  bing: new Map<string, BingSnapshot>(),
  /** Simulated R2 read latency: each read advances the fake clock this much. */
  readDelayMs: 0,
}));
vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));
vi.mock("cloudflare:workers", () => ({
  env: {
    get AUTH_MODE() {
      return mocks.settings.AUTH_MODE;
    },
    R2: {
      get: async (key: string) => {
        if (mocks.readDelayMs)
          vi.setSystemTime(new Date(Date.now() + mocks.readDelayMs));
        const object = mocks.objects.get(key);
        return object
          ? {
              text: async () => object.value,
              customMetadata: object.customMetadata,
            }
          : null;
      },
      put: async (
        key: string,
        value: string,
        options: { customMetadata: Record<string, string> },
      ) => {
        mocks.objects.set(key, {
          value,
          customMetadata: options.customMetadata,
        });
      },
    },
  },
}));
vi.mock("@/server/features/google/googleOAuth", () => ({
  getGoogleAccessToken: mocks.token,
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: { getPerformance: mocks.performance },
}));
vi.mock("@/server/lib/ga4Client", () => ({
  createGa4DataClient: () => ({ runReport: mocks.runReport }),
}));
vi.mock("@/server/features/bing/BingWebmasterService", () => ({
  BingWebmasterService: {
    getStoredSnapshot: mocks.getBing,
    refreshSnapshot: mocks.refreshBing,
  },
}));

const client = createClient({ url: "file::memory:" });
const testDb = drizzle(client);
const org = "delegated-local-admin";
const tables = [
  projects,
  gscConnections,
  ga4Connections,
  bingSiteBindings,
  account,
  audits,
  auditIssues,
  domainHealthCurrent,
];
const id = (i: number) => `p${String(i).padStart(4, "0")}`;
const site = (i: number) => `sc-domain:${id(i)}.example`;
const now = () => new Date().toISOString();
const sqlUpdatedAt = "2026-10-01 00:00:00";

beforeAll(async () => {
  // Real SQL and production column definitions, not mocked ORM builder chains.
  for (const table of tables) {
    const columns = Object.values(getTableColumns(table)).map(
      (c) => `"${c.name}" ${c.getSQLType()}`,
    );
    await client.execute(
      `CREATE TABLE "${getTableName(table)}" (${columns.join(", ")})`,
    );
  }
});
afterAll(() => client.close());
afterEach(() => vi.useRealTimers());
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
  vi.stubEnv("AUTH_MODE", "");
  mocks.settings.AUTH_MODE = "local_noauth";
  mocks.objects.clear();
  mocks.bing.clear();
  mocks.readDelayMs = 0;
  mocks.token.mockResolvedValue("test-token");
  mocks.performance.mockResolvedValue({ rows: [] });
  mocks.runReport.mockResolvedValue({ rows: [] });
  mocks.getBing.mockImplementation(
    async ({ projectId }: { projectId: string }) =>
      mocks.bing.get(projectId) ?? null,
  );
  mocks.refreshBing.mockResolvedValue(null);
  for (const table of tables)
    await client.execute(`DELETE FROM "${getTableName(table)}"`);
  await client.batch(
    [
      {
        sql: "INSERT INTO account (id, user_id, provider_id, account_id, updated_at) VALUES (?, ?, ?, ?, ?)",
        args: [
          "grant-gsc",
          "user-1",
          GSC_OAUTH_PROVIDER_ID,
          "account-gsc",
          Date.parse(sqlUpdatedAt + "Z"),
        ],
      },
      {
        sql: "INSERT INTO account (id, user_id, provider_id, account_id, updated_at) VALUES (?, ?, ?, ?, ?)",
        args: [
          "grant-ga4",
          "user-1",
          GA4_OAUTH_PROVIDER_ID,
          "account-ga4",
          Date.parse(sqlUpdatedAt + "Z"),
        ],
      },
    ],
    "write",
  );
});

async function seed(
  count: number,
  options: { ga4?: boolean; bing?: boolean; gsc?: boolean } = {},
) {
  const statements: InStatement[] = [];
  for (let i = 0; i < count; i++) {
    statements.push({
      sql: "INSERT INTO projects (id, name, domain, organization_id) VALUES (?, ?, ?, ?)",
      args: [id(i), id(i), `${id(i)}.example`, org],
    });
    if (options.gsc !== false)
      statements.push({
        sql: "INSERT INTO gsc_connections (id, project_id, organization_id, site_url, connected_by_user_id, gsc_account_id, connected_account_email, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        args: [
          `gsc-${id(i)}`,
          id(i),
          org,
          site(i),
          "user-1",
          "account-gsc",
          "gsc@example.test",
          sqlUpdatedAt,
        ],
      });
    if (options.ga4)
      statements.push({
        sql: "INSERT INTO ga4_connections (id, project_id, organization_id, property_id, property_time_zone, connected_by_user_id, ga4_account_id, connected_account_email, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [
          `ga4-${id(i)}`,
          id(i),
          org,
          "1234",
          "Asia/Manila",
          "user-1",
          "account-ga4",
          "ga4@example.test",
          sqlUpdatedAt,
        ],
      });
    if (options.bing)
      statements.push({
        sql: "INSERT INTO bing_site_bindings (id, project_id, organization_id, site_url) VALUES (?, ?, ?, ?)",
        args: [`bing-${id(i)}`, id(i), org, `https://${id(i)}.example/`],
      });
  }
  await client.batch(statements, "write");
}
function gsc(overrides = {}) {
  return {
    fetchedAt: now(),
    clicks: 0,
    prevClicks: 0,
    impressions: 0,
    prevImpressions: 0,
    position: null,
    prevPosition: null,
    daily: [],
    ...overrides,
  };
}
function ga4(overrides = {}) {
  return {
    fetchedAt: now(),
    sessions: 0,
    prevSessions: 0,
    activeUsers: 0,
    prevActiveUsers: 0,
    ...overrides,
  };
}
function bing(i: number, overrides: Partial<BingSnapshot> = {}): BingSnapshot {
  return {
    schemaVersion: 1,
    provider: "bing-webmaster",
    projectId: id(i),
    organizationId: org,
    bindingId: "00000000-0000-4000-8000-000000000001",
    siteUrl: `https://${id(i)}.example/`,
    fetchedAt: now(),
    performance: [
      {
        date: "2026-10-25",
        timestamp: "2026-10-25T00:00:00Z",
        utcOffsetMinutes: 0,
        clicks: 0,
        impressions: 0,
      },
    ],
    crawl: [],
    scope: {
      aggregation: "daily",
      performanceSurfaces: "combined Bing surfaces",
      timezone: null,
      window: "provider-returned dates",
      comparableToGoogleSearchConsole: false,
    },
    limitations: [],
    ...overrides,
  };
}

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
    expect(dashboard.inventory[0]!.gsc.metrics?.clicks).toBe(0);
    // Stale evidence keeps its earlier numbers for display only: the 900
    // clicks must not reach the totals below.
    expect(dashboard.inventory[1]!.gsc).toMatchObject({
      fetchedAt: "2026-10-26T23:00:00Z",
      metrics: { clicks: 900 },
    });
    expect(dashboard.gsc).toMatchObject({ sites: 1, clicks: 0, errors: 2 });
    expect(dashboard.ga4).toMatchObject({
      sites: 1,
      sessions: 0,
      zeroSessionSites: 1,
    });
    expect(dashboard.inventory[4]!.ga4.metrics).toBeNull();
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
    expect(dashboard.inventory[0]!.gsc.status).toBe("stale");
    expect(dashboard.inventory[0]!.ga4.status).toBe("stale");
    expect(dashboard.inventory[1]!.gsc.status).toBe("stale");
    expect(dashboard.gsc.sites).toBe(0);
  });

  it("does not silently use a fresh cache after the exact Google grant is removed", async () => {
    await seed(1);
    await setCached(cacheKey(id(0), site(0)), gsc(), 3600);
    await client.execute("DELETE FROM account WHERE id = 'grant-gsc'");
    expect((await buildFleetDashboard(org)).inventory[0]!.gsc).toMatchObject({
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
    expect(overview.rows[1]!.gsc?.error).toBe("revoked");
    expect(overview.rows[0]!.ga4).toMatchObject({ sessions: 0 });
    expect(overview).toMatchObject({ pendingGsc: 1, pendingGa4: 2, pending: 3 });
    expect(mocks.performance).not.toHaveBeenCalled();
    expect(mocks.runReport).not.toHaveBeenCalled();
  });

  it("keeps showing earlier numbers and failures while expired entries refresh", async () => {
    await seed(3, { ga4: true });
    const hoursAgo = (h: number) =>
      new Date(Date.now() - h * 3600_000).toISOString();
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

    expect(overview.rows[0]!.gsc).toMatchObject({ clicks: 7, stale: true });
    expect(overview.rows[1]!.ga4?.error).toBe(
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

    expect(overview.rows[0]!.gsc).toBeNull();
    expect(overview).toMatchObject({ pendingGsc: 1, refreshingGsc: 0 });
  });
});

describe("Bing inventory", () => {
  it("preserves provider-confirmed zero but leaves empty snapshots and mixed date-window totals unknown", async () => {
    await seed(2, { bing: true, gsc: false });
    mocks.bing.set(id(0), bing(0));
    mocks.bing.set(id(1), bing(1, { performance: [] }));
    const dashboard = await buildFleetDashboard(org);
    expect(dashboard.inventory[0]!.bing.metrics).toMatchObject({
      clicks: 0,
      impressions: 0,
      ctr: null,
    });
    expect(dashboard.inventory[0]!.bing.metrics).not.toHaveProperty("position");
    expect(dashboard.inventory[1]!.bing.metrics).toMatchObject({
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
    expect(dashboard.inventory[0]!.bing).toMatchObject({
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

  it("still runs provider work when reading every site's cache would use up the deadline", async () => {
    // Live tokyo: ~6,500 reads took 55-123 s, so the 100 s warm (which stops
    // scheduling 20 s early) ran nothing for days while 6,467 refreshes waited.
    await seed(400);
    mocks.readDelayMs = 120; // 400 sites x 2 reads x 120 ms = 96 s if read at once.
    const result = await warmFleetCaches(org, 90);
    expect(result.ran).toBeGreaterThan(0);
    expect(mocks.performance).toHaveBeenCalled();
  });

  it("moves past a stretch of up-to-date sites in the same warm", async () => {
    await seed(400);
    for (let i = 0; i < 300; i++) {
      await setCached(cacheKey(id(i), site(i)), gsc(), 43200);
      await setCached(
        `portfolio-gscq:v1:${id(i)}:${site(i)}`,
        { fetchedAt: now(), rows: [] },
        129600,
      );
    }
    await warmFleetCaches(org, 90);
    const called = mocks.performance.mock.calls.map(([input]) => input.projectId);
    expect(called.length).toBeGreaterThan(0);
    expect(called.every((p: string) => p >= id(300))).toBe(true);
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

it("rebuilds a stale snapshot from stored rows instead of rereading every site cache", async () => {
  await seed(400);
  await getFleetDashboard(org);
  const warm = await warmFleetCaches(org, 90);
  expect(warm.ran).toBeGreaterThan(0);
  const fetchedId = mocks.performance.mock.calls[0]![0].projectId as string;
  const stored = (await getCached(
    cacheKey(fetchedId, `sc-domain:${fetchedId}.example`),
  )) as { fetchedAt?: string } | null;
  expect(typeof stored?.fetchedAt).toBe("string");

  mocks.readDelayMs = 120;
  vi.setSystemTime(new Date(Date.now() + 31 * 60 * 1000));
  const beforeGet = Date.now();
  const dashboard = await getFleetDashboard(org);
  const getMoved = Date.now() - beforeGet;
  // The page read writes a new snapshot. Age that one too so the scheduler
  // takes the same stale-snapshot path instead of scanning the fleet to warm.
  vi.setSystemTime(new Date(Date.now() + 31 * 60 * 1000));
  const beforeScheduled = Date.now();
  await runScheduledFleetDashboard();
  const scheduledMoved = Date.now() - beforeScheduled;

  expect(getMoved).toBeLessThan(5_000);
  expect(scheduledMoved).toBeLessThan(5_000);
  expect(dashboard.coverage.projects).toBe(400);
  expect(
    dashboard.inventory.find((row) => row.projectId === fetchedId)?.gsc,
  ).toMatchObject({ status: "available", fetchedAt: stored!.fetchedAt });
  const scheduled = await getFleetDashboard(org);
  expect(scheduled.coverage.projects).toBe(400);
  expect(
    scheduled.inventory.find((row) => row.projectId === fetchedId)?.gsc.status,
  ).toBe("available");
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
