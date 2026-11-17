import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Ga4RunReportRequest,
  Ga4RunReportResponse,
} from "@/server/lib/ga4Client";
import { Ga4TokenError } from "@/server/lib/ga4Errors";
import { fetchGa4 } from "./PortfolioService";

const mocks = vi.hoisted(() => ({
  runReport:
    vi.fn<(request: Ga4RunReportRequest) => Promise<Ga4RunReportResponse>>(),
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/r2-cache", () => ({
  getCached: vi.fn(),
  setCached: vi.fn(),
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: {},
}));
vi.mock("@/server/lib/ga4Client", () => ({
  createGa4DataClient: () => ({ runReport: mocks.runReport }),
}));

describe("portfolio GA4 reporting periods", () => {
  beforeEach(() => {
    mocks.runReport.mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves a temporary token outage instead of caching it as a dead grant", async () => {
    mocks.runReport.mockRejectedValue(
      new Ga4TokenError(
        "Could not mint a Google Analytics access token.",
        new TypeError("fetch failed"),
      ),
    );
    const result = await fetchGa4({
      projectId: "p1",
      propertyId: "properties/1",
      userId: "u1",
      ga4AccountId: "a1",
    });
    expect(result.error).toContain("temporarily unavailable");
    expect(result.error).not.toContain("Could not mint");
  });

  it.each([
    "2026-10-20T00:01:00Z", // Los Angeles is still on October 19.
    "2026-10-19T21:41:00Z", // Manila has already reached October 20.
    "2026-11-01T09:30:00Z", // Los Angeles daylight-saving transition.
  ])(
    "leaves complete-day boundaries to the property's time zone at %s",
    async (now) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));

      await fetchGa4({
        projectId: "project-1",
        propertyId: "1234",
        userId: "user-1",
        ga4AccountId: "account-1",
      });

      expect(mocks.runReport).toHaveBeenCalledWith(
        expect.objectContaining({
          dateRanges: [
            { startDate: "28daysAgo", endDate: "yesterday" },
            { startDate: "56daysAgo", endDate: "29daysAgo" },
          ],
        }),
      );
    },
  );
});
