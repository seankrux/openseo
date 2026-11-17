import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportService } from "./ReportService";
import { ProjectReportingService } from "./ProjectReportingService";
import { StoredGoogleSnapshotService } from "@/server/features/portfolio/StoredGoogleSnapshotService";
import { BingWebmasterService } from "@/server/features/bing/BingWebmasterService";

vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: { getProjectForOrganization: vi.fn() },
}));
vi.mock("./ReportService", () => ({
  ReportService: { saveReport: vi.fn() },
}));
vi.mock("../repositories/ProjectHealthRepository", () => ({
  ProjectHealthRepository: { getLatestCompletedAudit: vi.fn() },
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: { getConfigsForProject: vi.fn() },
  }),
);
vi.mock("@/server/features/rank-tracking/services/rankTrackingResults", () => ({
  getLatestResults: vi.fn(),
}));

vi.mock("@/server/features/ai-visibility/services/aiVisibilityTrend", () => ({
  loadAiTrend: vi.fn(),
}));

vi.mock("@/server/features/portfolio/StoredGoogleSnapshotService", () => ({
  StoredGoogleSnapshotService: { read: vi.fn() },
}));

vi.mock("@/server/features/bing/BingWebmasterService", () => ({
  BingWebmasterService: { getStoredSnapshot: vi.fn() },
}));

import {
  googleEvidence,
  input,
  setDefaultEvidence,
} from "./project-reporting-test-support";

describe("ProjectReportingService saved Google/Bing evidence", () => {
  beforeEach(setDefaultEvidence);

  it("includes stored Google evidence with property, periods, status and all-channel GA4 limits", async () => {
    const google = googleEvidence();
    google.gsc = {
      status: "available",
      property: "sc-domain:example.com",
      fetchedAt: "2026-10-19T00:00:00Z",
      periods: {
        current: { startDate: "2026-09-19", endDate: "2026-10-16" },
        previous: { startDate: "2026-08-22", endDate: "2026-09-18" },
      },
      limitations: [
        "Final GSC data was requested; provider finality is not independently confirmed.",
      ],
      current: { clicks: 70, impressions: 500, position: 3 },
      previous: { clicks: 100, impressions: 700, position: 4 },
    };
    google.ga4 = {
      ...google.ga4,
      status: "legacy",
      property: "properties/123",
      fetchedAt: "2026-10-19T00:00:00Z",
      current: { sessions: 15, activeUsers: 10 },
      previous: { sessions: 20, activeUsers: 12 },
      limitations: [
        "All-channel traffic; exact periods and quality were not recorded.",
      ],
    };
    vi.mocked(StoredGoogleSnapshotService.read).mockResolvedValue(google);

    const result = await ProjectReportingService.generate(input);

    expect(result.evidence).toHaveProperty("google.gsc", google.gsc);
    const html = vi.mocked(ReportService.saveReport).mock.calls[0]?.[0].html;
    expect(html).toContain("sc-domain:example.com");
    expect(html).toContain("2026-09-19");
    expect(html).toContain("2026-08-22");
    expect(html).toContain("70 clicks");
    expect(html).toContain("legacy");
    expect(html).toContain("All-channel");
    expect(html).toContain("not organic leads or revenue");
  });

  it("shows stored Bing daily evidence without inventing a Google-comparable period", async () => {
    vi.mocked(BingWebmasterService.getStoredSnapshot).mockResolvedValue({
      schemaVersion: 1,
      provider: "bing-webmaster",
      projectId: "project_1",
      organizationId: "org_1",
      bindingId: "c87a1020-fbd2-4e25-93fa-cb39c40505ee",
      siteUrl: "https://example.com/",
      fetchedAt: "2026-10-19T00:00:00Z",
      performance: [
        {
          date: null,
          timestamp: "2026-10-17T00:00:00.000Z",
          utcOffsetMinutes: null,
          clicks: 12,
          impressions: 250,
        },
      ],
      crawl: [
        {
          date: "2026-10-17",
          timestamp: "2026-10-17T00:00:00.000Z",
          utcOffsetMinutes: 0,
          allOtherCodes: 0,
          blockedByRobotsTxt: 1,
          code2xx: 20,
          code301: 2,
          code302: 0,
          code4xx: 1,
          code5xx: 0,
          containsMalware: 0,
          crawlErrors: 1,
          crawledPages: 24,
          inIndex: 19,
          inLinks: 32,
        },
      ],
      scope: {
        aggregation: "daily",
        performanceSurfaces: "combined Bing surfaces",
        timezone: null,
        window: "provider-returned dates",
        comparableToGoogleSearchConsole: false,
      },
      limitations: ["Bing and Google Search Console scopes differ."],
    });

    const result = await ProjectReportingService.generate(input);

    expect(result.evidence).toHaveProperty("bing.provider", "bing-webmaster");
    const html = vi.mocked(ReportService.saveReport).mock.calls[0]?.[0].html;
    expect(html).toContain("combined Bing surfaces");
    expect(html).toContain("provider-returned dates");
    expect(html).toContain("12 clicks");
    expect(html).toContain("24 crawled pages");
    expect(html).toContain("2026-10-17T00:00:00.000Z");
    expect(html).toContain("Timezone: Unknown");
    expect(html).toContain("not directly comparable to Google Search Console");
  });

  it("limits Bing row display and discloses that it is not the whole saved window", async () => {
    vi.mocked(BingWebmasterService.getStoredSnapshot).mockResolvedValue({
      schemaVersion: 1,
      provider: "bing-webmaster",
      projectId: "project_1",
      organizationId: "org_1",
      bindingId: "c87a1020-fbd2-4e25-93fa-cb39c40505ee",
      siteUrl: "https://example.com/",
      fetchedAt: "2026-10-19T00:00:00Z",
      performance: Array.from({ length: 1000 }, (_, index) => ({
        date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
        timestamp: new Date(Date.UTC(2024, 0, 1 + index)).toISOString(),
        utcOffsetMinutes: 0,
        clicks: index,
        impressions: 2500,
      })),
      crawl: [],
      scope: {
        aggregation: "daily",
        performanceSurfaces: "combined Bing surfaces",
        timezone: null,
        window: "provider-returned dates",
        comparableToGoogleSearchConsole: false,
      },
      limitations: [],
    });

    await ProjectReportingService.generate(input);

    const html = vi.mocked(ReportService.saveReport).mock.calls[0]?.[0].html;
    expect(html).toContain("Showing 31 of 1000 saved performance rows");
    expect(html).toContain("not a complete period");
    expect(html).toContain("999 clicks");
    expect(html).not.toContain("968 clicks");
  });
});
