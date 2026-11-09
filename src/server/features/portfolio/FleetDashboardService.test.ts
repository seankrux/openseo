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
import { cacheKey, ga4CacheKey, windows } from "./PortfolioService";

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
  /** Every R2 write, for counting snapshot and parts persists. */
  puts: [] as Array<{ key: string; bytes: number }>,
  /** Holds the first read of a matching key until `wait` resolves. */
  gate: null as null | { match: string; hit: boolean; wait: Promise<void> },
  /** Makes every read of a matching key throw. */
  failRead: null as null | string,
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
        if (mocks.failRead && key.includes(mocks.failRead))
          throw new Error("R2 read failed");
        if (mocks.gate && !mocks.gate.hit && key.includes(mocks.gate.match)) {
          mocks.gate.hit = true;
          await mocks.gate.wait;
        }
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
        mocks.puts.push({ key, bytes: value.length });
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
  mocks.puts.length = 0;
  mocks.gate = null;
  mocks.failRead = null;
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

describe("snapshot aggregates come from per-site parts", () => {
  const queriesKey = (i: number) => `portfolio-gscq:v1:${id(i)}:${site(i)}`;
  const minutes = (n: number) =>
    vi.setSystemTime(new Date(Date.now() + n * 60 * 1000));
  const dayOf = (offset: number, from = windows().curStart) =>
    new Date(Date.parse(`${from}T00:00:00Z`) + offset * 86400_000)
      .toISOString()
      .slice(0, 10);
  const query = (rows: Array<[string, number, number, number]>) => ({
    fetchedAt: now(),
    rows,
  });
  async function cacheSite(
    i: number,
    daily: Array<[string, number, number]>,
    rows: Array<[string, number, number, number]>,
    clicks = 0,
  ) {
    await setCached(cacheKey(id(i), site(i)), gsc({ daily, clicks }), 43200);
    await setCached(queriesKey(i), query(rows), 129600);
  }
  const statusOf = (
    dashboard: Awaited<ReturnType<typeof getFleetDashboard>>,
    i: number,
  ) => dashboard.inventory.find((r) => r.projectId === id(i))!;

  it("re-aggregates the chart, top queries and coverage from sites a fold rereads", async () => {
    await seed(3);
    for (let i = 0; i < 3; i++)
      await cacheSite(i, [[dayOf(0), 10, 100]], [["alpha", 5, 50, 3]], 10);
    const first = await getFleetDashboard(org);
    expect(first.daily[0]).toMatchObject({ clicks: 30, impressions: 300 });
    expect(first.topQueries[0]).toMatchObject({ query: "alpha", clicks: 15 });
    // A cache write outside the warm (for example the site table refresh).
    await cacheSite(0, [[dayOf(0), 40, 400]], [["beta", 20, 90, 2]], 40);
    minutes(31);
    const folded = await getFleetDashboard(org);
    expect(folded.daily[0]).toMatchObject({ clicks: 60, impressions: 600 });
    expect(folded.topQueries.map((q) => q.query)).toContain("beta");
    expect(folded.topQueries.find((q) => q.query === "alpha")).toMatchObject({
      clicks: 10,
      sites: 2,
    });
    expect(folded.coverage.queriesCached).toBe(3);
    expect(folded.dailySites).toBe(3);
  });

  it("re-slices the chart to the new windows across UTC midnight", async () => {
    await seed(3);
    vi.setSystemTime(new Date("2026-10-27T23:50:00Z"));
    const before = windows();
    for (let i = 0; i < 3; i++)
      await cacheSite(i, [[dayOf(0, before.curStart), 10, 100]], [["a", 1, 1, 1]]);
    const first = await getFleetDashboard(org);
    expect(first.daily[0]).toMatchObject({
      date: before.curStart,
      clicks: 30,
    });
    vi.setSystemTime(new Date("2026-10-28T00:40:00Z"));
    const after = windows();
    expect(after.curStart).not.toBe(before.curStart);
    // Nothing refreshed yet: yesterday's totals must not sit under new labels.
    const stale = await getFleetDashboard(org);
    expect(stale.windows.curStart).toBe(after.curStart);
    expect(stale.daily[0]!.date).toBe(after.curStart);
    expect(stale.dailySites).toBe(0);
    expect(stale.daily.every((d) => d.clicks === 0)).toBe(true);
    // The warm refreshes the sites against the new windows.
    for (let i = 0; i < 3; i++)
      await cacheSite(i, [[dayOf(1, after.curStart), 7, 70]], [["a", 1, 1, 1]]);
    minutes(31);
    const fresh = await getFleetDashboard(org);
    expect(fresh.daily.map((d) => d.date)).toEqual(
      Array.from({ length: 28 }, (_, n) => dayOf(n, after.curStart)),
    );
    expect(fresh.daily[1]).toMatchObject({ clicks: 21, impressions: 210 });
    expect(fresh.dailySites).toBe(3);
  });

  it("rereads every site within a bounded number of folds", async () => {
    await seed(100);
    for (let i = 0; i < 100; i++) await cacheSite(i, [], [], 1);
    await getFleetDashboard(org);
    await cacheSite(95, [], [], 777);
    let folds = 0;
    let seen = 0;
    while (folds < 3 && seen !== 777) {
      minutes(31);
      folds++;
      seen =
        statusOf(await getFleetDashboard(org), 95).gsc.metrics?.clicks ?? 0;
    }
    expect(seen).toBe(777);
  });

  it("rereads sites with a missing or error status ahead of the rotation", async () => {
    await seed(100);
    for (let i = 0; i < 100; i++) await cacheSite(i, [], [], 1);
    await setCached(
      cacheKey(id(70), site(70)),
      gsc({ error: "boom" }),
      3600,
    );
    const first = await getFleetDashboard(org);
    expect(statusOf(first, 70).gsc.status).toBe("error");
    await cacheSite(70, [], [], 5);
    minutes(31);
    const folded = await getFleetDashboard(org);
    expect(statusOf(folded, 70).gsc).toMatchObject({
      status: "available",
      error: null,
    });
  });

  it("drops a missing-grant error once the grant is reconnected, without rereading the site", async () => {
    await seed(100);
    for (let i = 0; i < 100; i++) await cacheSite(i, [], [], 1);
    await client.execute("DELETE FROM account WHERE id = 'grant-gsc'");
    const broken = await getFleetDashboard(org);
    expect(statusOf(broken, 99).gsc).toMatchObject({
      status: "error",
      error: "Google account grant is missing; reconnect this account.",
    });
    await client.execute({
      sql: "INSERT INTO account (id, user_id, provider_id, account_id, updated_at) VALUES (?, ?, ?, ?, ?)",
      args: [
        "grant-gsc",
        "user-1",
        GSC_OAUTH_PROVIDER_ID,
        "account-gsc",
        Date.parse(sqlUpdatedAt + "Z"),
      ],
    });
    minutes(31);
    const reconnected = await getFleetDashboard(org);
    expect(statusOf(reconnected, 99).gsc.status).toBe("available");
    expect(reconnected.gsc.errors).toBe(0);
    expect(reconnected.providerIssues).toEqual([]);
  });

  it("matches a full build for rows the fold did not reread", async () => {
    await seed(100, { ga4: true, bing: true });
    const hoursAgo = (h: number) =>
      new Date(Date.now() - h * 3600_000).toISOString();
    for (let i = 0; i < 100; i++) {
      const kind = i % 5;
      const value =
        kind === 0
          ? gsc({ clicks: i, daily: [[dayOf(0), i, 10]] })
          : kind === 1
            ? gsc({ clicks: i, fetchedAt: hoursAgo(13) })
            : kind === 2
              ? gsc({ error: "boom" })
              : kind === 3
                ? gsc({ clicks: "bad" })
                : null;
      if (value) await setCached(cacheKey(id(i), site(i)), value, 43200);
      if (i % 2 === 0)
        await setCached(
          ga4CacheKey(id(i), "1234"),
          i % 4 === 0 ? ga4({ sessions: i }) : ga4({ error: "ga4 down" }),
          43200,
        );
      if (i % 3 === 0) mocks.bing.set(id(i), bing(i));
      if (i % 7 === 0) await setCached(queriesKey(i), query([["q", 1, 2, 3]]), 129600);
    }
    await getFleetDashboard(org);
    minutes(31);
    const folded = await getFleetDashboard(org);
    const built = await buildFleetDashboard(org);
    expect(folded.inventory).toEqual(built.inventory);
    // foldCursor is rotation bookkeeping, not dashboard data.
    expect({
      ...folded,
      generatedAt: "",
      health: null,
      foldCursor: null,
    }).toEqual({
      ...built,
      generatedAt: "",
      health: null,
      foldCursor: null,
    });
  });

  it("refreshes Bing limitations from reread snapshots", async () => {
    await seed(2, { bing: true, gsc: false });
    mocks.bing.set(id(0), bing(0));
    const first = await getFleetDashboard(org);
    expect(first.bing.limitations).toHaveLength(3);
    mocks.bing.set(id(0), bing(0, { limitations: ["Bing note one"] }));
    minutes(31);
    const folded = await getFleetDashboard(org);
    expect(folded.bing.limitations).toContain("Bing note one");
  });

  it("keeps per-site parts out of the snapshot and small enough for the 1,628-site live fleet", { timeout: 60_000 }, async () => {
    await seed(1628, { ga4: true, bing: true });
    const w = windows();
    for (let i = 0; i < 1628; i++) {
      const daily = Array.from(
        { length: 56 },
        (_, n): [string, number, number] => [
          dayOf(n, w.prevStart),
          (i * 7 + n) % 90,
          1000 + ((i * 13 + n * 17) % 4000),
        ],
      );
      const rows = Array.from(
        { length: 25 },
        (_, n): [string, number, number, number] => [
          `emergency plumber near site ${i} query ${n}`,
          n,
          100 + n,
          3.4,
        ],
      );
      await cacheSite(i, daily, rows, 100);
      await setCached(ga4CacheKey(id(i), "1234"), ga4({ sessions: i }), 43200);
      mocks.bing.set(
        id(i),
        bing(i, {
          performance: Array.from({ length: 30 }, (_, n) => ({
            date: dayOf(n, w.curStart),
            timestamp: `${dayOf(n, w.curStart)}T00:00:00Z`,
            utcOffsetMinutes: 0,
            clicks: n,
            impressions: n * 5,
          })),
          limitations: ["Bing combines search surfaces for this site."],
        }),
      );
    }
    const dashboard = await getFleetDashboard(org);
    const stored = (key: string) =>
      [...mocks.objects.entries()].find(([k]) => k.endsWith(key))?.[1].value;
    const snapshotBytes = stored(`fleet-dashboard:v4:${org}`)!.length;
    const partsBytes = stored(`fleet-dashboard-parts:v2:${org}`)!.length;
    console.info(
      `[fleet-size] sites=1628 snapshotKB=${Math.round(snapshotBytes / 1024)} partsKB=${Math.round(partsBytes / 1024)}`,
    );
    expect(partsBytes).toBeLessThan(5_000_000);
    expect(JSON.stringify(dashboard)).not.toContain("fleet-dashboard-parts");
    expect(dashboard.dailySites).toBe(1628);
    expect(snapshotBytes).toBeLessThan(partsBytes);
  });
});

describe("fold, warm patch and page views write the snapshot one at a time", () => {
  const snapshotEnd = `fleet-dashboard:v4:${org}`;
  const partsEnd = `fleet-dashboard-parts:v2:${org}`;
  const putsOf = (end: string) =>
    mocks.puts.filter((p) => p.key.endsWith(end));
  const minutes = (n: number) =>
    vi.setSystemTime(new Date(Date.now() + n * 60 * 1000));
  async function cacheAll(count: number, clicks = 1) {
    for (let i = 0; i < count; i++)
      await setCached(cacheKey(id(i), site(i)), gsc({ clicks }), 43200);
  }

  it("keeps every warm-patched row when a fold that started earlier persists later", async () => {
    await seed(120);
    await getFleetDashboard(org);
    minutes(31);
    let release!: () => void;
    mocks.gate = {
      match: "portfolio-gsc:v1:p0000:",
      hit: false,
      wait: new Promise<void>((resolve) => (release = resolve)),
    };
    const folding = getFleetDashboard(org);
    await vi.waitFor(() => expect(mocks.gate?.hit).toBe(true));
    const warming = warmFleetCaches(org, 90);
    await vi.waitFor(() =>
      expect(mocks.performance.mock.calls.length).toBeGreaterThan(30),
    );
    await vi.advanceTimersByTimeAsync(10);
    release();
    const [, warm] = await Promise.all([folding, warming]);
    expect(warm.ran).toBeGreaterThan(30);
    const touched = new Set<string>(
      mocks.performance.mock.calls.map(([input]) => input.projectId),
    );
    const stored = (await getCached(
      `fleet-dashboard:v4:${org}`,
    )) as Awaited<ReturnType<typeof getFleetDashboard>>;
    const lost = stored.inventory.filter(
      (row) => touched.has(row.projectId) && row.gsc.status !== "available",
    );
    expect(touched.size).toBeGreaterThan(30);
    expect(lost.map((row) => row.projectId)).toEqual([]);
  });

  it("shares one fold and one write across concurrent stale page views", async () => {
    await seed(20);
    await cacheAll(20);
    await getFleetDashboard(org);
    minutes(31);
    mocks.puts.length = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => getFleetDashboard(org)),
    );
    expect(putsOf(snapshotEnd)).toHaveLength(1);
    expect(new Set(results.map((r) => r.generatedAt)).size).toBe(1);
  });

  it("does not rewrite the parts when a fold changed nothing, and does when a site changed", async () => {
    await seed(20);
    await cacheAll(20);
    await getFleetDashboard(org);
    minutes(31);
    mocks.puts.length = 0;
    await getFleetDashboard(org);
    expect(putsOf(snapshotEnd)).toHaveLength(1);
    expect(putsOf(partsEnd)).toHaveLength(0);
    await setCached(cacheKey(id(3), site(3)), gsc({ clicks: 50 }), 43200);
    minutes(31);
    const folded = await getFleetDashboard(org);
    expect(putsOf(partsEnd)).toHaveLength(1);
    expect(
      folded.inventory.find((r) => r.projectId === id(3))!.gsc.metrics?.clicks,
    ).toBe(50);
  });

  it("serves a stale snapshot whose parts are missing to page views, and lets the scheduler build", async () => {
    await seed(5);
    await cacheAll(5);
    await getFleetDashboard(org);
    for (const key of [...mocks.objects.keys()])
      if (key.endsWith(partsEnd)) mocks.objects.delete(key);
    await setCached(cacheKey(id(2), site(2)), gsc({ clicks: 99 }), 43200);
    minutes(35);
    mocks.puts.length = 0;
    const views = await Promise.all(
      Array.from({ length: 4 }, () => getFleetDashboard(org)),
    );
    expect(views[0]!.inventory[2]!.gsc.metrics?.clicks).toBe(1);
    expect(mocks.puts).toHaveLength(0);
    await runScheduledFleetDashboard();
    expect(putsOf(snapshotEnd)).toHaveLength(1);
    expect(putsOf(partsEnd)).toHaveLength(1);
    const after = await getFleetDashboard(org);
    expect(after.inventory[2]!.gsc.metrics?.clicks).toBe(99);
  });

  it("does not queue a page view behind a full build the scheduler is running", async () => {
    await seed(3);
    await cacheAll(3);
    await getFleetDashboard(org);
    for (const key of [...mocks.objects.keys()])
      if (key.endsWith(partsEnd)) mocks.objects.delete(key);
    minutes(35);
    mocks.puts.length = 0;
    let release!: () => void;
    mocks.gate = {
      match: "portfolio-gsc:v1:p0000:",
      hit: false,
      wait: new Promise<void>((resolve) => (release = resolve)),
    };
    const building = runScheduledFleetDashboard();
    await vi.waitFor(() => expect(mocks.gate?.hit).toBe(true));
    const view = await getFleetDashboard(org);
    expect(view.coverage.projects).toBe(3);
    release();
    await building;
    expect(putsOf(partsEnd)).toHaveLength(1);
  });

  it("builds on a page view only when no snapshot exists or refresh is asked for", async () => {
    await seed(3);
    await cacheAll(3);
    const first = await getFleetDashboard(org);
    expect(first.coverage.projects).toBe(3);
    expect(putsOf(snapshotEnd)).toHaveLength(1);
    await setCached(cacheKey(id(1), site(1)), gsc({ clicks: 7 }), 43200);
    const forced = await getFleetDashboard(org, true);
    expect(forced.inventory[1]!.gsc.metrics?.clicks).toBe(7);
  });

  it.each([
    ["an unknown version", '{"v":2,"sites":{}}'],
    ["a malformed part", '{"v":1,"sites":{"p0000":{"gsc":null}}}'],
  ])(
    "serves stale to page views and rebuilds on the scheduler for parts with %s",
    async (_name, raw) => {
      await seed(3);
      await cacheAll(3);
      await getFleetDashboard(org);
      const key = [...mocks.objects.keys()].find((k) => k.endsWith(partsEnd))!;
      mocks.objects.get(key)!.value = raw;
      await setCached(cacheKey(id(1), site(1)), gsc({ clicks: 7 }), 43200);
      minutes(31);
      mocks.puts.length = 0;
      const stale = await getFleetDashboard(org);
      expect(stale.inventory[1]!.gsc.metrics?.clicks).toBe(1);
      expect(mocks.puts).toHaveLength(0);
      await runScheduledFleetDashboard();
      const rebuilt = await getFleetDashboard(org);
      expect(rebuilt.inventory.map((r) => r.gsc.status)).toEqual([
        "available",
        "available",
        "available",
      ]);
      expect(rebuilt.inventory[1]!.gsc.metrics?.clicks).toBe(7);
    },
  );

  it("stores parts under the v2 key and ignores a v1 object", async () => {
    await seed(3);
    await cacheAll(3);
    await setCached(
      `fleet-dashboard-parts:v1:${org}`,
      { v: 1, cursor: null, sites: {} },
      3600,
    );
    mocks.puts.length = 0;
    await getFleetDashboard(org);
    expect(putsOf(`fleet-dashboard-parts:v2:${org}`)).toHaveLength(1);
    expect(putsOf(`fleet-dashboard-parts:v1:${org}`)).toHaveLength(0);
  });

  it("releases the lock when work inside it hangs, so queued callers and the warm patch proceed", async () => {
    await seed(3);
    await setCached(cacheKey(id(0), site(0)), gsc(), 43200);
    await setCached(cacheKey(id(1), site(1)), gsc(), 43200);
    await getFleetDashboard(org);
    minutes(31);
    mocks.gate = {
      match: "fleet-dashboard-parts:",
      hit: false,
      wait: new Promise<void>(() => {}),
    };
    const stuck = getFleetDashboard(org);
    await vi.waitFor(() => expect(mocks.gate?.hit).toBe(true));
    const warming = warmFleetCaches(org, 10);
    await vi.waitFor(() => expect(mocks.performance).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(201_000);
    // The stale view falls back to the snapshot it already holds.
    expect((await stuck).coverage.projects).toBe(3);
    // The warm patch got the lock and finished.
    expect(await warming).toMatchObject({ ran: expect.any(Number) });
    const stored = (await getCached(snapshotEnd)) as Awaited<
      ReturnType<typeof getFleetDashboard>
    >;
    expect(stored.inventory[2]!.gsc.status).toBe("available");
  });

  it("logs and returns when the warm patch cannot read the snapshot", async () => {
    await seed(3);
    await getFleetDashboard(org);
    mocks.failRead = "fleet-dashboard:v4";
    const warm = await warmFleetCaches(org, 10);
    expect(warm.ran).toBeGreaterThan(0);
  });

  it("rereads a site whose Bing binding was replaced, ahead of the rotation", async () => {
    await seed(60, { bing: true, gsc: false });
    for (let i = 0; i < 60; i++) mocks.bing.set(id(i), bing(i));
    await getFleetDashboard(org);
    await client.execute({
      sql: "UPDATE bing_site_bindings SET id = ? WHERE project_id = ?",
      args: ["bing-replaced", id(59)],
    });
    mocks.bing.set(id(59), bing(59, { limitations: ["Replaced binding note"] }));
    minutes(31);
    const folded = await getFleetDashboard(org);
    expect(folded.bing.limitations).toContain("Replaced binding note");
  });
});
