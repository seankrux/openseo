import { beforeEach, describe, expect, it, vi } from "vitest";
import { listGoogleGrantsForUser } from "./listGrants";

const mocks = vi.hoisted(() => {
  const state: {
    mode: "gateway" | "own_client";
    gatewayConnected: boolean;
    rows: Array<{ id: string; accountId: string; ownerUserId: string }>;
  } = {
    mode: "own_client",
    gatewayConnected: false,
    rows: [],
  };
  return {
    state,
    getGoogleAccessMode: vi.fn(async () => state.mode),
    getGatewayGoogleStatus: vi.fn(async () => ({
      connected: state.gatewayConnected,
    })),
    dbSelect: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(state.rows)),
      })),
    })),
  };
});

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: { select: mocks.dbSelect } }));
vi.mock("@/server/features/google/googleAccess", () => ({
  getGoogleAccessMode: mocks.getGoogleAccessMode,
}));
vi.mock("@/server/features/google/gatewayGoogle", () => ({
  GATEWAY_GOOGLE_ACCOUNT_ID: "everyapp",
  getGatewayGoogleStatus: mocks.getGatewayGoogleStatus,
}));

describe("listGoogleGrantsForUser", () => {
  beforeEach(() => {
    mocks.state.mode = "own_client";
    mocks.state.gatewayConnected = false;
    mocks.state.rows = [];
    mocks.dbSelect.mockClear();
  });

  it("returns only the caller's stored grants outside gateway mode", async () => {
    mocks.state.rows = [{ id: "g1", accountId: "sub-a", ownerUserId: "u1" }];
    await expect(
      listGoogleGrantsForUser("u1", "google-search-console"),
    ).resolves.toEqual([{ id: "g1", accountId: "sub-a", ownerUserId: "u1" }]);
  });

  it("unions the gateway connection with local-admin imported grants", async () => {
    mocks.state.mode = "gateway";
    mocks.state.gatewayConnected = true;
    mocks.state.rows = [
      {
        id: "imported-a",
        accountId: "109108278415777391778",
        ownerUserId: "local-admin",
      },
      {
        id: "imported-b",
        accountId: "110332904218061700649",
        ownerUserId: "local-admin",
      },
    ];
    await expect(
      listGoogleGrantsForUser("gateway-member", "google-search-console"),
    ).resolves.toEqual([
      {
        id: "everyapp",
        accountId: "everyapp",
        ownerUserId: "gateway-member",
      },
      {
        id: "imported-a",
        accountId: "109108278415777391778",
        ownerUserId: "local-admin",
      },
      {
        id: "imported-b",
        accountId: "110332904218061700649",
        ownerUserId: "local-admin",
      },
    ]);
  });

  it("lists imported grants even when the gateway Google account is not connected", async () => {
    mocks.state.mode = "gateway";
    mocks.state.gatewayConnected = false;
    mocks.state.rows = [
      {
        id: "imported-a",
        accountId: "109108278415777391778",
        ownerUserId: "local-admin",
      },
    ];
    await expect(
      listGoogleGrantsForUser("gateway-member", "google-search-console"),
    ).resolves.toEqual([
      {
        id: "imported-a",
        accountId: "109108278415777391778",
        ownerUserId: "local-admin",
      },
    ]);
  });
});
