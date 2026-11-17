import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectReportingService } from "@/server/features/reports/services/ProjectReportingService";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
import { generateProjectHealthReportTool } from "./project-health-tools";
import { makeToolContext, textContent } from "./tool-test-support";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: { getProjectForOrganization: vi.fn() },
}));
vi.mock("@/server/features/reports/services/ProjectReportingService", () => ({
  ProjectReportingService: { generate: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(ProjectService.getProjectForOrganization).mockResolvedValue({
    id: "project_1",
    name: "Concrete repair",
    domain: "example.com",
    locationCode: 2840,
    languageCode: "en",
    createdAt: "2026-09-01 00:00:00",
  });
  vi.mocked(ProjectReportingService.generate).mockResolvedValue({
    reportId: "report_1",
    title: "Project health",
    created: true,
    htmlBytes: 200,
    generatedAt: "2026-10-19T00:00:00Z",
    evidence: {
      audit: null,
      rank: [],
      bing: null,
      ai: {
        days: 28,
        comparison: "no_data",
        current: {
          start: "2026-09-21",
          end: "2026-10-19",
          coverage: {
            runs: 0,
            expected: 0,
            answered: 0,
            noAnswer: 0,
            failed: 0,
          },
        },
        previous: {
          start: "2026-08-24",
          end: "2026-09-21",
          coverage: {
            runs: 0,
            expected: 0,
            answered: 0,
            noAnswer: 0,
            failed: 0,
          },
        },
        mentions: {
          current: null,
          previous: null,
          change: null,
          matchedCells: 0,
          currentCells: 0,
          previousCells: 0,
        },
        citations: {
          current: null,
          previous: null,
          change: null,
          matchedCells: 0,
          currentCells: 0,
          previousCells: 0,
        },
        engines: [],
        runs: [],
      },
      google: {
        gsc: {
          status: "unavailable",
          property: null,
          fetchedAt: null,
          periods: null,
          limitations: [],
          current: null,
          previous: null,
        },
        ga4: {
          status: "unavailable",
          property: null,
          fetchedAt: null,
          periods: null,
          limitations: [],
          current: null,
          previous: null,
        },
      },
    },
  });
});

describe("generate_project_health_report", () => {
  it("uses trusted attribution and returns the new private report URL, not raw evidence", async () => {
    const args = {
      projectId: "project_1",
      organizationId: "foreign",
      createdBy: "spoofed",
      createdByUserId: "foreign-user",
    };

    const result = await generateProjectHealthReportTool.handler(
      args,
      makeToolContext({ clientLabel: "Trusted client" }),
    );

    expect(ProjectReportingService.generate).toHaveBeenCalledWith({
      projectId: "project_1",
      organizationId: "org_123",
      createdBy: "Trusted client",
      createdByUserId: "user_123",
    });
    expect(result.structuredContent).toMatchObject({
      reportId: "report_1",
      sharing: "private",
      url: "https://open-seo.test/p/project_1/reports/report_1",
    });
    expect(result.structuredContent).not.toHaveProperty("evidence");
    expect(textContent(result)).toContain(
      "https://open-seo.test/p/project_1/reports/report_1",
    );
  });
});
