import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import type { runBatch } from "@/db/runBatch";

const {
  getProject,
  getMembership,
  fetchMock,
  settings,
  objects,
  getObject,
  putObject,
  withPgClient,
} = vi.hoisted(() => ({
  getProject: vi.fn(),
  getMembership: vi.fn(),
  withPgClient: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  fetchMock: vi.fn<typeof fetch>(),
  settings: {
    AUTH_MODE: "local_noauth",
    BING_WEBMASTER_ENABLED: "true",
    BING_WEBMASTER_API_KEY: "mock-bing-key",
  },
  objects: new Map<string, string>(),
  getObject:
    vi.fn<
      (
        key: string,
      ) => Promise<{ text: () => Promise<string>; size: number } | null>
    >(),
  putObject: vi.fn<
    (
      key: string,
      value: string,
      options?: {
        httpMetadata?: { contentType: string; cacheControl: string };
      },
    ) => Promise<void>
  >(),
}));
export {
  getProject,
  getMembership,
  fetchMock,
  settings,
  objects,
  getObject,
  putObject,
  withPgClient,
};
vi.mock("cloudflare:workers", () => ({
  env: {
    get AUTH_MODE() {
      return settings.AUTH_MODE;
    },
    get BING_WEBMASTER_ENABLED() {
      return settings.BING_WEBMASTER_ENABLED;
    },
    get BING_WEBMASTER_API_KEY() {
      return settings.BING_WEBMASTER_API_KEY;
    },
    R2: { get: getObject, put: putObject },
  },
}));
vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
  withPgClient,
}));
vi.mock("@/db/runBatch", () => ({
  runBatch: async (build: Parameters<typeof runBatch>[0]) => {
    if (writeHooks.beforeWrite) await writeHooks.beforeWrite();
    // Keep one connection: libSQL's transaction() hands off the in-memory DB.
    await client.execute("BEGIN");
    try {
      // Execute production statement builders atomically on real SQLite.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same Drizzle statement surface as D1
      const executor = testDb as unknown as Parameters<typeof build>[0];
      for (const statement of build(executor)) await statement;
      await client.execute("COMMIT");
    } catch (error) {
      await client.execute("ROLLBACK");
      throw error;
    }
  },
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: { getProjectForOrganization: getProject },
}));
vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: { getMembership },
}));

export const client = createClient({ url: "file::memory:" });
const testDb = drizzle(client);
export const writeHooks: { beforeWrite: (() => Promise<void>) | null } = {
  beforeWrite: null,
};
export const scope = {
  projectId: "project-a",
  organizationId: "delegated-local-admin",
};
export const bindingInput = {
  ...scope,
  userId: "local-admin",
  siteUrl: "https://example.com/",
};
export const project = {
  id: scope.projectId,
  organizationId: scope.organizationId,
  domain: "example.com",
  archivedAt: null,
};

beforeAll(async () => {
  await client.executeMultiple(`PRAGMA foreign_keys=ON;
    CREATE TABLE organization (id text PRIMARY KEY);
    CREATE TABLE user (id text PRIMARY KEY);
    CREATE TABLE projects (id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organization(id), domain text, archived_at text);
    ${readFileSync("drizzle/sqlite/0056_bing_site_bindings.sql", "utf8")}`);
});
afterAll(() => client.close());
beforeEach(async () => {
  writeHooks.beforeWrite = null;
  settings.AUTH_MODE = "local_noauth";
  settings.BING_WEBMASTER_ENABLED = "true";
  settings.BING_WEBMASTER_API_KEY = "mock-bing-key";
  getProject.mockImplementation(
    async (projectId: string, organizationId: string) =>
      projectId === scope.projectId && organizationId === scope.organizationId
        ? project
        : null,
  );
  getMembership.mockResolvedValue({ role: "owner" });
  objects.clear();
  getObject.mockImplementation(async (key) => {
    const value = objects.get(key);
    return value === undefined
      ? null
      : {
          text: async () => value,
          size: new TextEncoder().encode(value).byteLength,
        };
  });
  putObject.mockImplementation(async (key, value) => {
    objects.set(key, value);
  });
  vi.stubEnv("AUTH_MODE", "");
  vi.stubEnv("BING_WEBMASTER_ENABLED", "true");
  vi.stubEnv("BING_WEBMASTER_API_KEY", "mock-bing-key");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async () =>
    Response.json({
      d: [
        {
          Url: bindingInput.siteUrl,
          IsVerified: true,
          AuthenticationCode: "do-not-store",
          DnsVerificationCode: "do-not-store",
        },
      ],
    }),
  );
  await client.executeMultiple(`DELETE FROM bing_site_bindings; DELETE FROM projects; DELETE FROM organization; DELETE FROM user;
    INSERT INTO organization VALUES ('delegated-local-admin'), ('org-b');
    INSERT INTO user VALUES ('local-admin');
    INSERT INTO projects VALUES ('project-a', 'delegated-local-admin', 'example.com', NULL), ('project-b', 'org-b', 'foreign.com', NULL);`);
});

export function providerUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

export function useMetrics() {
  fetchMock.mockImplementation(async (input) =>
    Response.json({
      d: providerUrl(input).includes("GetRankAndTrafficStats")
        ? [
            {
              Date: "/Date(1788564600000+0200)/",
              Clicks: 7,
              Impressions: 91,
              secret: "do-not-store",
            },
          ]
        : [
            {
              Date: "/Date(1788564600000)/",
              AllOtherCodes: 1,
              BlockedByRobotsTxt: 2,
              Code2xx: 3,
              Code301: 4,
              Code302: 5,
              Code4xx: 6,
              Code5xx: 7,
              ContainsMalware: 8,
              CrawlErrors: 9,
              CrawledPages: 10,
              InIndex: 11,
              InLinks: 12,
              DnsFailures: 4,
              secret: "do-not-store",
            },
          ],
    }),
  );
}
