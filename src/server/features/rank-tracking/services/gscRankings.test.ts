vi.mock("cloudflare:workers", () => ({ env: {} }));
import { beforeEach, expect, it, vi } from "vitest";
import { getGscRankings } from "./gscRankings";

const { connection, getConnection, getCache, setCache, performance } =
  vi.hoisted(() => ({
    connection: {
      siteUrl: "sc-domain:example.com",
      connectedByUserId: "user",
      gscAccountId: "account",
      updatedAt: "2026-11-03 00:00:00",
    },
    getConnection: vi.fn(),
    getCache: vi.fn(),
    setCache: vi.fn(),
    performance: vi.fn(),
  }));
vi.mock("@/server/features/gsc/repositories/GscConnectionRepository", () => ({
  GscConnectionRepository: { getByProjectId: getConnection },
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: { getPerformance: performance },
}));
vi.mock("@/server/lib/r2-cache", () => ({
  getCached: getCache,
  setCached: setCache,
}));
beforeEach(() => {
  getConnection.mockResolvedValue({ ...connection });
  getCache.mockResolvedValue(null);
  setCache.mockResolvedValue(undefined);
  performance.mockResolvedValue({
    siteUrl: connection.siteUrl,
    rows: [{ keys: ["repair"], position: 4, clicks: 1, impressions: 10 }],
  });
});
it("does not serve cached rankings after a property is disconnected", async () => {
  getConnection.mockResolvedValue(null);
  expect(await getGscRankings("project")).toMatchObject({
    connected: false,
    rows: [],
  });
  expect(getCache).not.toHaveBeenCalled();
  expect(performance).not.toHaveBeenCalled();
});
it("uses a new cache identity when the selected Google property changes", async () => {
  await getGscRankings("project");
  const previousKey: unknown = getCache.mock.calls[0][0];
  getConnection.mockResolvedValue({
    ...connection,
    siteUrl: "sc-domain:other.com",
  });
  await getGscRankings("project");
  expect(getCache.mock.calls[1][0]).not.toBe(previousKey);
  expect(performance).toHaveBeenCalledTimes(4);
});
it("refetches malformed stored rankings rather than trusting their shape", async () => {
  getCache.mockResolvedValue({
    connected: true,
    rows: "broken",
    fetchedAt: "today",
  });
  expect(await getGscRankings("project")).toMatchObject({
    connected: true,
    rows: [{ query: "repair", position: 4 }],
  });
  expect(performance).toHaveBeenCalledTimes(2);
});
