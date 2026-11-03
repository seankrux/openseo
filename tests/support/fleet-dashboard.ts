import {
  account,
  auditIssues,
  audits,
  bingSiteBindings,
  domainHealthCurrent,
  ga4Connections,
  gscConnections,
  projects,
} from "@/db/schema";
import type { BingSnapshot } from "@/server/features/bing/BingSnapshot";
import { GA4_OAUTH_PROVIDER_ID } from "@/shared/ga4";
import { GSC_OAUTH_PROVIDER_ID } from "@/shared/gsc";
import { createClient, type InStatement } from "@libsql/client";
import { Column, getTableColumns, getTableName, is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  performance: vi.fn<(input: { projectId: string }) => Promise<unknown>>(),
  runReport: vi.fn(),
  getBing: vi.fn(),
  refreshBing: vi.fn(),
  settings: { AUTH_MODE: "local_noauth" },
  objects: new Map<
    string,
    { value: string; customMetadata: Record<string, string> }
  >(),
  bing: new Map<string, BingSnapshot>(),
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

export const client = createClient({ url: "file::memory:" });

const testDb = drizzle(client);

export const org = "delegated-local-admin";

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

export const id = (i: number) => `p${String(i).padStart(4, "0")}`;

export const site = (i: number) => `sc-domain:${id(i)}.example`;

export const now = () => new Date().toISOString();

const sqlUpdatedAt = "2026-10-01 00:00:00";

beforeAll(async () => {
  // Real SQL and production column definitions, not mocked ORM builder chains.
  for (const table of tables) {
    const columns = Object.values(getTableColumns(table))
      .filter((column): column is Column => is(column, Column))
      .map((c) => `"${c.name}" ${c.getSQLType()}`);
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

export async function seed(
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

export function gsc(overrides = {}) {
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

export function ga4(overrides = {}) {
  return {
    fetchedAt: now(),
    sessions: 0,
    prevSessions: 0,
    activeUsers: 0,
    prevActiveUsers: 0,
    ...overrides,
  };
}

export function bing(
  i: number,
  overrides: Partial<BingSnapshot> = {},
): BingSnapshot {
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

export { mocks };
