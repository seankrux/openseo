import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { ReportService } from "./ReportService";
import { ProjectReportingService } from "./ProjectReportingService";
import { ProjectHealthRepository } from "../repositories/ProjectHealthRepository";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { getLatestResults } from "@/server/features/rank-tracking/services/rankTrackingResults";
import { loadAiTrend } from "@/server/features/ai-visibility/services/aiVisibilityTrend";
import {
  aiTrend,
  input,
  project,
  setDefaultEvidence,
} from "./project-reporting-test-support";
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

describe("ProjectReportingService.generate", () => {
  beforeEach(setDefaultEvidence);

  it("creates a new private saved-data report even when no audit exists", async () => {
    const result = await ProjectReportingService.generate(input);

    expect(result).toMatchObject({ reportId: "report_1", created: true });
    expect(ReportService.saveReport).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_1",
        organizationId: "org_1",
        createdBy: "OpenSEO",
        createdByUserId: "user_1",
      }),
    );
    expect(
      vi.mocked(ReportService.saveReport).mock.calls[0]?.[0],
    ).not.toHaveProperty("reportId");
    expect(
      vi.mocked(ReportService.saveReport).mock.calls[0]?.[0].html,
    ).toContain("Stored data only");
  });

  it("includes saved completed-audit evidence with its observation window", async () => {
    const audit = {
      auditId: "audit_1",
      startUrl: "https://example.com/",
      startedAt: "2026-10-17T01:00:00Z",
      completedAt: "2026-10-17T01:03:00Z",
      pagesCrawled: 8,
      criticalIssues: 2,
      warningIssues: 3,
      informationalIssues: 1,
    };
    vi.mocked(
      ProjectHealthRepository.getLatestCompletedAudit,
    ).mockResolvedValue(audit);

    const result = await ProjectReportingService.generate(input);

    expect(result.evidence.audit).toEqual(audit);
    const saved = vi.mocked(ReportService.saveReport).mock.calls[0]?.[0];
    expect(saved?.html).toContain("2026-10-17T01:03:00Z");
    expect(saved?.html).toContain("2 critical");
  });

  it("reports saved ranks with market scope and suppresses unproved period deltas", async () => {
    vi.mocked(RankTrackingRepository.getConfigsForProject).mockResolvedValue([
      {
        id: "tracker_1",
        projectId: "project_1",
        domain: "example.com",
        locationCode: 2840,
        languageCode: "en",
        devices: "desktop",
        serpDepth: 20,
        scheduleInterval: "manual",
        locationName: "Amarillo, Texas",
        isActive: true,
        lastCheckedAt: "2026-10-17 01:00:00",
        nextCheckAt: null,
        lastSkipReason: null,
        createdAt: "2026-09-01 00:00:00",
      },
    ]);
    vi.mocked(getLatestResults).mockResolvedValue({
      run: {
        id: "rank_run_1",
        status: "failed",
        lastCheckedAt: "2026-10-17 01:00:00",
        completedAt: "2026-10-18 01:00:00",
        errorMessage: "private provider error",
      },
      rows: [
        {
          trackingKeywordId: "keyword_1",
          keyword: "concrete leveling",
          matchCase: false,
          pinned: false,
          searchVolume: null,
          keywordDifficulty: null,
          cpc: null,
          desktop: {
            position: 3,
            previousPosition: 97,
            rankingUrl: "https://example.com/",
            serpFeatures: [],
          },
          mobile: {
            position: null,
            previousPosition: null,
            rankingUrl: null,
            serpFeatures: [],
          },
        },
      ],
    });

    const result = await ProjectReportingService.generate(input);

    expect(result.evidence).toHaveProperty("rank");
    const saved = vi.mocked(ReportService.saveReport).mock.calls[0]?.[0].html;
    expect(saved).toContain("Amarillo, Texas");
    expect(saved).toContain("concrete leveling");
    expect(saved).toContain("2026-10-17 01:00:00");
    expect(saved).toContain("failed");
    expect(saved).toContain("Exact period deltas are unavailable");
    expect(result.evidence.rank[0]?.rows[0]).toEqual({
      keyword: "concrete leveling",
      desktop: 3,
      mobile: null,
    });
    expect(JSON.stringify(result.evidence)).not.toContain(
      "private provider error",
    );
  });

  it("bounds large saved ranking inventories and states the omitted scope", async () => {
    vi.mocked(RankTrackingRepository.getConfigsForProject).mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => ({
        id: `tracker_${index}`,
        projectId: "project_1",
        domain: "example.com",
        locationCode: 2840,
        languageCode: "en",
        devices: "desktop",
        serpDepth: 20,
        scheduleInterval: "manual",
        locationName: "Amarillo, Texas",
        isActive: true,
        lastCheckedAt: null,
        nextCheckAt: null,
        lastSkipReason: null,
        createdAt: "2026-09-01 00:00:00",
      })),
    );
    vi.mocked(getLatestResults).mockResolvedValue({
      run: null,
      rows: Array.from({ length: 2000 }, (_, index) => ({
        trackingKeywordId: `keyword_${index}`,
        keyword: `keyword-${index}-${"界".repeat(200)}`,
        matchCase: false,
        pinned: false,
        searchVolume: null,
        keywordDifficulty: null,
        cpc: null,
        desktop: {
          position: 3,
          previousPosition: null,
          rankingUrl: null,
          serpFeatures: [],
        },
        mobile: {
          position: null,
          previousPosition: null,
          rankingUrl: null,
          serpFeatures: [],
        },
      })),
    });

    await ProjectReportingService.generate(input);

    const html =
      vi.mocked(ReportService.saveReport).mock.calls[0]?.[0].html ?? "";
    expect(new TextEncoder().encode(html).length).toBeLessThan(500_000);
    expect(html).toContain("Showing 5 of 6 saved rank trackers");
    expect(html).toContain("Showing 50 of 2000 saved keywords");
    expect(html).not.toContain("keyword-1999-");
  });

  it("keeps incomplete AI evidence qualified by coverage instead of claiming a trend", async () => {
    const ai = aiTrend();
    ai.comparison = "incomplete";
    ai.current.coverage = {
      runs: 1,
      expected: 10,
      answered: 6,
      noAnswer: 0,
      failed: 4,
    };
    ai.mentions = {
      current: 25,
      previous: 50,
      change: null,
      matchedCells: 1,
      currentCells: 1,
      previousCells: 1,
    };
    vi.mocked(loadAiTrend).mockResolvedValue(ai);

    const result = await ProjectReportingService.generate(input);

    expect(result.evidence).toHaveProperty("ai.comparison", "incomplete");
    const html = vi.mocked(ReportService.saveReport).mock.calls[0]?.[0].html;
    expect(html).toContain("2026-09-21T00:00:00Z");
    expect(html).toContain("incomplete");
    expect(html).toContain("6/10 answers");
    expect(html).toContain("Change unavailable");
    expect(html).not.toContain("-25");
  });

  it("uses the newest saved finished AI run as its observation timestamp", async () => {
    const ai = aiTrend();
    ai.runs = [
      {
        runId: "old",
        createdAt: "2026-09-01T12:00:00Z",
        mentionRate: null,
        citationRate: null,
        coverage: ai.previous.coverage,
      },
      {
        runId: "new",
        createdAt: "2026-10-18T12:00:00Z",
        mentionRate: null,
        citationRate: null,
        coverage: ai.current.coverage,
      },
    ];
    vi.mocked(loadAiTrend).mockResolvedValue(ai);

    await ProjectReportingService.generate(input);

    expect(
      vi.mocked(ReportService.saveReport).mock.calls[0]?.[0].html,
    ).toContain("Last saved finished run: 2026-10-18T12:00:00Z");
  });

  it("renders untrusted project and source text without active markup or links", async () => {
    vi.mocked(ProjectRepository.getProjectForOrganization).mockResolvedValue({
      ...project,
      name: '<script>alert("project")</script> & repair',
    });
    vi.mocked(
      ProjectHealthRepository.getLatestCompletedAudit,
    ).mockResolvedValue({
      auditId: "audit_1",
      startUrl: 'javascript:alert(1)<svg onload="alert(2)">',
      startedAt: "2026-10-17T01:00:00Z",
      completedAt: "2026-10-17T01:03:00Z",
      pagesCrawled: 8,
      criticalIssues: 2,
      warningIssues: 3,
      informationalIssues: 1,
    });

    await ProjectReportingService.generate(input);

    const html = vi.mocked(ReportService.saveReport).mock.calls[0]?.[0].html;
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;svg onload=&quot;");
    expect(html).not.toMatch(/<script|<svg|href=|src=/i);
  });

  it("refuses a project outside the caller organization before collecting or saving", async () => {
    vi.mocked(ProjectRepository.getProjectForOrganization).mockResolvedValue(
      null,
    );

    await expect(ProjectReportingService.generate(input)).rejects.toMatchObject(
      {
        code: "NOT_FOUND",
      },
    );
    expect(
      ProjectHealthRepository.getLatestCompletedAudit,
    ).not.toHaveBeenCalled();
    expect(RankTrackingRepository.getConfigsForProject).not.toHaveBeenCalled();
    expect(loadAiTrend).not.toHaveBeenCalled();
    expect(StoredGoogleSnapshotService.read).not.toHaveBeenCalled();
    expect(BingWebmasterService.getStoredSnapshot).not.toHaveBeenCalled();
    expect(ReportService.saveReport).not.toHaveBeenCalled();
  });
});
