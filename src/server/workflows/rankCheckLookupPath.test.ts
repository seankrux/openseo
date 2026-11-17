import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import { AppError } from "@/server/lib/errors";
import { runSerpLookupCheck } from "./rankCheckLookupPath";

type SavedRow = {
  trackingKeywordId: string;
  device: string;
  position: number | null;
  url: string | null;
};

const mocks = vi.hoisted(() => ({
  insertSnapshots: vi.fn<(rows: SavedRow[]) => Promise<void>>(),
  updateRun: vi.fn(),
  setRunErrorIfEmpty: vi.fn(),
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({ RankTrackingRepository: mocks }),
);
vi.mock("@/server/workflows/pgStep", () => ({
  pgStep: (
    _step: unknown,
    _name: string,
    _config: unknown,
    fn: () => unknown,
  ) => fn(),
}));

const keywords = Array.from({ length: 11 }, (_, index) => ({
  id: `kw_${index}`,
  keyword: `keyword ${index}`,
}));

function savedRows() {
  return mocks.insertSnapshots.mock.calls.flatMap(([rows]) => rows);
}

describe("runSerpLookupCheck", () => {
  const organicSerp = vi.fn();

  function runLookupCheck(devices: "desktop" | "both") {
    return runSerpLookupCheck(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pgStep is mocked, so the step is never used
      {} as unknown as WorkflowStep,
      {
        provider: { id: "semrush", organicSerp },
        keywords,
        devices,
        serpDepth: 20,
        domain: "openseo.so",
        locationCode: 2826,
        languageCode: "en",
        runId: "run_1",
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    organicSerp.mockImplementation(async ({ keyword }: { keyword: string }) =>
      keyword === "keyword 0"
        ? []
        : [
            { position: 1, domain: "other.com", url: "https://other.com/" },
            {
              position: 6,
              domain: "www.openseo.so",
              url: `https://www.openseo.so/${keyword}`,
            },
          ],
    );
  });

  it("looks up every keyword and device for the tracked country and saves each position", async () => {
    await runLookupCheck("both");

    expect(organicSerp).toHaveBeenCalledTimes(22);
    expect(organicSerp).toHaveBeenCalledWith({
      keyword: "keyword 3",
      countryCode: "gb",
      locationName: null,
      device: "mobile",
      depth: 20,
    });
    const saved = mocks.insertSnapshots.mock.calls.flatMap(
      ([rows]: [
        Array<{
          trackingKeywordId: string;
          device: string;
          position: number | null;
        }>,
      ]) => rows,
    );
    expect(saved).toHaveLength(22);
    expect(saved).toContainEqual(
      expect.objectContaining({
        trackingKeywordId: "kw_0",
        device: "desktop",
        position: null,
      }),
    );
    expect(saved).toContainEqual(
      expect.objectContaining({
        trackingKeywordId: "kw_10",
        device: "mobile",
        position: 6,
        url: "https://www.openseo.so/keyword 10",
      }),
    );
    expect(mocks.setRunErrorIfEmpty).not.toHaveBeenCalled();
  });

  it("records the provider's reason and saves the pairs that succeeded", async () => {
    organicSerp.mockImplementation(async ({ keyword }: { keyword: string }) => {
      if (keyword === "keyword 2") {
        throw new AppError(
          "RATE_LIMITED",
          "Semrush: ERROR 132 :: API UNITS BALANCE IS ZERO",
        );
      }
      return [];
    });

    await runLookupCheck("desktop");

    expect(mocks.setRunErrorIfEmpty).toHaveBeenCalledWith(
      "run_1",
      "Semrush: ERROR 132 :: API UNITS BALANCE IS ZERO",
    );
    const saved = savedRows();
    expect(saved.map((row) => row.trackingKeywordId)).toEqual(
      keywords.filter((kw) => kw.id !== "kw_2").map((kw) => kw.id),
    );
  });
});
