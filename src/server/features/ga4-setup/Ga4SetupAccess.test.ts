import { AppError } from "@/server/lib/errors";
import { gscOnboardDomainTool } from "@/server/mcp/tools/gsc-onboard-tool";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listMissingGa4,
  readLog,
  readState,
  runBulk,
  setupSite,
} from "./Ga4SetupService";

const { settings, getProject, listProperties, kvGet, kvPut } = vi.hoisted(
  () => ({
    settings: { AUTH_MODE: "local_noauth", KV: { get: vi.fn(), put: vi.fn() } },
    getProject: vi.fn(),
    listProperties: vi.fn(),
    kvGet: vi.fn(),
    kvPut: vi.fn(),
  }),
);
vi.mock("cloudflare:workers", () => ({ env: settings }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: { getProjectForOrganization: getProject },
}));
vi.mock("@/server/features/ga4/services/Ga4Service", () => ({
  Ga4Service: { listPropertiesForUserWithGrantStatus: listProperties },
}));

const context = {
  organizationId: "delegated-local-admin",
  userId: "local-admin",
  role: "owner",
};
const actions = [
  [
    "site",
    () => setupSite({ ...context, projectId: "foreign-project", apply: true }),
  ],
  ["bulk", () => runBulk({ ...context, apply: true, limit: 1 })],
  ["missing", () => listMissingGa4(context)],
  ["state", () => readState(context)],
  ["log", () => readLog(context)],
] as const;

beforeEach(() => {
  settings.AUTH_MODE = "local_noauth";
  Object.assign(context, {
    organizationId: "delegated-local-admin",
    userId: "local-admin",
    role: "owner",
  });
  settings.KV.get = kvGet;
  settings.KV.put = kvPut;
  kvGet.mockResolvedValue(null);
  kvPut.mockResolvedValue(undefined);
  getProject.mockResolvedValue(null);
  listProperties.mockResolvedValue({ accounts: [] });
});

describe.each(actions)("GA4 setup %s boundary", (_, action) => {
  it.each(["hosted", "unknown", ""])(
    "denies deployment mode %s before data or provider access",
    async (mode) => {
      settings.AUTH_MODE = mode;
      await expect(action()).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(getProject).not.toHaveBeenCalled();
      expect(kvGet).not.toHaveBeenCalled();
      expect(listProperties).not.toHaveBeenCalled();
    },
  );

  it("denies another workspace before reading shared setup state", async () => {
    context.organizationId = "foreign-org";
    await expect(action()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(kvGet).not.toHaveBeenCalled();
    expect(getProject).not.toHaveBeenCalled();
  });

  it.each(["member", "unknown", ""])(
    "denies non-manager role %s",
    async (role) => {
      context.role = role;
      await expect(action()).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(kvGet).not.toHaveBeenCalled();
      expect(listProperties).not.toHaveBeenCalled();
    },
  );
});

it("authorizes the requested project within the verified organization before providers", async () => {
  await expect(
    setupSite({ ...context, projectId: "foreign-project", apply: true }),
  ).rejects.toThrow();
  expect(getProject).toHaveBeenCalledExactlyOnceWith(
    context.organizationId,
    "foreign-project",
  );
  expect(listProperties).not.toHaveBeenCalled();
  expect(kvPut).not.toHaveBeenCalled();
});

it.each(["owner", "admin", "member,admin"])(
  "allows canonical Access managers to read status (%s)",
  async (role) => {
    settings.AUTH_MODE = "cloudflare_access";
    await expect(
      readState({
        organizationId: "shared-workspace",
        userId: "verified-access-user",
        role,
      }),
    ).resolves.toEqual({});
    expect(kvGet).toHaveBeenCalledExactlyOnceWith("ga4setup:state", {
      type: "json",
    });
  },
);

it("denies hosted Search Console DNS setup before touching the installed credential", async () => {
  settings.AUTH_MODE = "hosted";
  const upstream = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected upstream request"));
  const result = await gscOnboardDomainTool.handler(
    { domain: "example.com", accountId: "account", dryRun: false },
    {
      auth: {
        ...context,
        userEmail: "local@example.com",
        scopes: [],
        clientId: null,
        baseUrl: "http://localhost",
      },
    },
  );
  expect(result.structuredContent).toMatchObject({
    ok: false,
    error: new AppError("FORBIDDEN").message,
  });
  expect(upstream).not.toHaveBeenCalled();
});
