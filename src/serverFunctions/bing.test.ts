import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import {
  disconnectBing,
  getBingConnection,
  listBingSites,
  setBingSite,
} from "./bing";

const { trustedContext, service } = vi.hoisted(() => ({
  trustedContext: {
    projectId: "trusted-project",
    organizationId: "delegated-local-admin",
    userId: "local-admin",
    role: "owner",
  },
  service: {
    getConnection: vi.fn(),
    listSites: vi.fn(),
    bindSite: vi.fn(),
    disconnect: vi.fn(),
  },
}));
vi.mock("@/server/features/bing/BingWebmasterService", () => ({
  BingWebmasterService: service,
}));
vi.mock("@/serverFunctions/middleware", () => ({ requireProjectContext: [] }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    middleware: () => ({
      validator: (schema: z.ZodType) => ({
        handler:
          (
            handler: (input: {
              data: unknown;
              context: typeof trustedContext;
            }) => unknown,
          ) =>
          async ({ data }: { data: unknown }) =>
            handler({ data: schema.parse(data), context: trustedContext }),
      }),
    }),
  }),
}));

beforeEach(() => {
  Object.assign(trustedContext, {
    projectId: "trusted-project",
    organizationId: "delegated-local-admin",
    userId: "local-admin",
    role: "owner",
  });
  service.getConnection.mockResolvedValue({
    connected: false,
    connectorAvailable: true,
    siteUrl: null,
    connectedAt: null,
  });
  service.listSites.mockResolvedValue({ sites: [] });
  service.bindSite.mockResolvedValue({
    siteUrl: "https://example.com/",
    createdAt: "2026-09-05T00:00:00.000Z",
  });
  service.disconnect.mockResolvedValue(undefined);
});

describe("consumed Bing server functions", () => {
  const actions = [
    ["discovery", listBingSites, service.listSites],
    ["binding", setBingSite, service.bindSite],
    ["disconnect", disconnectBing, service.disconnect],
  ] as const;

  it.each(actions)(
    "%s derives project, organization and manager identity only from trusted context",
    async (_, action, serviceAction) => {
      const data = {
        projectId: "forged-project",
        organizationId: "foreign-org",
        userId: "foreign-user",
        role: "owner",
        authMode: "hosted",
        siteUrl: "https://example.com/",
      };
      await action({ data });
      expect(serviceAction).toHaveBeenCalledExactlyOnceWith({
        projectId: "trusted-project",
        organizationId: "delegated-local-admin",
        userId: "local-admin",
        ...(action === setBingSite ? { siteUrl: "https://example.com/" } : {}),
      });
    },
  );

  describe.each(actions)("%s permission", (_, action) => {
    it.each(["member", "unknown", ""])(
      "denies role %s before service access despite a submitted owner role",
      async (role) => {
        trustedContext.role = role;
        const data = {
          projectId: "trusted-project",
          siteUrl: "https://example.com/",
          role: "owner",
        };
        await expect(action({ data })).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
        expect(service.listSites).not.toHaveBeenCalled();
        expect(service.bindSite).not.toHaveBeenCalled();
        expect(service.disconnect).not.toHaveBeenCalled();
      },
    );

    it.each(["owner", "admin", "member, admin", "member,owner"])(
      "allows trusted integration managers including comma roles: %s",
      async (role) => {
        trustedContext.role = role;
        await expect(
          action({
            data: {
              projectId: "trusted-project",
              siteUrl: "https://example.com/",
            },
          }),
        ).resolves.toBeDefined();
      },
    );
  });

  it("reports member status without granting connector management", async () => {
    trustedContext.role = "member";
    expect(
      await getBingConnection({ data: { projectId: "trusted-project" } }),
    ).toMatchObject({ canManage: false });
  });

  it("exposes only the public bind/disconnect lifecycle result", async () => {
    expect(
      await setBingSite({
        data: { projectId: "trusted-project", siteUrl: "https://example.com/" },
      }),
    ).toEqual({
      connected: true,
      siteUrl: "https://example.com/",
      connectedAt: "2026-09-05T00:00:00.000Z",
    });
    expect(
      await disconnectBing({ data: { projectId: "trusted-project" } }),
    ).toEqual({ connected: false });
  });

  it("uses trusted project and organization context for status instead of submitted ids", async () => {
    const data = {
      projectId: "forged-project",
      organizationId: "foreign-org",
      userId: "foreign-user",
      role: "owner",
      authMode: "local_noauth",
    };
    expect(await getBingConnection({ data })).toEqual({
      connected: false,
      connectorAvailable: true,
      siteUrl: null,
      connectedAt: null,
      canManage: true,
    });
    expect(service.getConnection).toHaveBeenCalledExactlyOnceWith({
      projectId: "trusted-project",
      organizationId: "delegated-local-admin",
    });
  });
});
