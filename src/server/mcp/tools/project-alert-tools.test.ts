import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectAlertService } from "@/server/features/project-alerts/ProjectAlertService";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
import { previewProjectAlertsTool } from "./project-alert-tools";
import { makeToolContext } from "./tool-test-support";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: { getProjectForOrganization: vi.fn() },
}));
vi.mock("@/server/features/project-alerts/ProjectAlertService", () => ({
  ProjectAlertService: { preview: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(ProjectService.getProjectForOrganization).mockResolvedValue({
    id: "project_1",
    name: "Concrete",
    domain: "example.com",
    locationCode: 2840,
    languageCode: "en",
    createdAt: "2026-09-01 00:00:00",
  });
  vi.mocked(ProjectAlertService.preview).mockResolvedValue({
    projectId: "project_1",
    evaluatedAt: "2026-10-19T00:00:00Z",
    alerts: [
      {
        id: "gsc-click-drop",
        state: "unknown",
        reason: "Stored scope cannot qualify this comparison.",
        dropPercent: null,
        evidence: {
          status: "legacy",
          property: "sc-domain:example.com",
          fetchedAt: "2026-10-19T00:00:00Z",
          periods: null,
          limitations: ["Exact period and request scope are unrecorded."],
          current: { clicks: 70, impressions: 1000, position: 3 },
          previous: { clicks: 100, impressions: 1000, position: 4 },
        },
      },
    ],
  });
});

describe("preview_project_alerts", () => {
  it("projects only public comparison scope from populated private provenance", async () => {
    const periods = {
      current: { startDate: "2026-09-21", endDate: "2026-10-18" },
      previous: { startDate: "2026-08-24", endDate: "2026-09-20" },
    };
    vi.mocked(ProjectAlertService.preview).mockResolvedValue({
      projectId: "project_1",
      evaluatedAt: "2026-10-19T00:00:00Z",
      alerts: [
        {
          id: "gsc-click-drop",
          state: "triggered",
          reason: "Finalized clicks fell 30%.",
          dropPercent: 30,
          evidence: {
            status: "available",
            property: "sc-domain:example.com",
            fetchedAt: "2026-10-19T00:00:00Z",
            periods,
            current: { clicks: 70, impressions: 1000, position: 3 },
            previous: { clicks: 100, impressions: 1000, position: 4 },
            limitations: [],
            provenance: {
              version: 1,
              kind: "gsc",
              projectId: "project_1",
              organizationId: "org_123",
              property: "sc-domain:example.com",
              binding: {
                id: "private-binding",
                userId: "private-user",
                accountId: "private-account",
                updatedAt: "2026-09-01T00:00:00Z",
              },
              periods,
              dateBasis: {
                timeZone: "America/Los_Angeles",
                windowAnchor: "utc-date",
                lagDays: 3,
              },
              request: {
                startDate: "2026-08-24",
                endDate: "2026-10-18",
                dimensions: ["date"],
                type: "web",
                dataState: "final",
                rowLimit: 56,
              },
              quality: {
                complete: true,
                requestVerified: true,
                rowsValid: true,
                rowCount: 56,
              },
            },
          },
        },
      ],
    });

    const result = await previewProjectAlertsTool.handler(
      { projectId: "project_1" },
      makeToolContext(),
    );
    const evidence = result.structuredContent?.alerts[0]?.evidence;

    expect(evidence?.scope).toEqual({
      searchType: "web",
      dataState: "final",
      timeZone: "America/Los_Angeles",
      windowAnchor: "utc-date",
      complete: true,
    });
    expect(evidence).not.toHaveProperty("provenance");
    expect(JSON.stringify(result)).not.toMatch(
      /private-binding|private-user|private-account/,
    );
  });

  it("uses trusted project scope and returns a bounded private preview without raw binding provenance", async () => {
    const args = {
      projectId: "project_1",
      organizationId: "foreign",
      destination: "https://foreign.example/",
    };
    const result = await previewProjectAlertsTool.handler(
      args,
      makeToolContext(),
    );

    expect(ProjectAlertService.preview).toHaveBeenCalledWith({
      projectId: "project_1",
      organizationId: "org_123",
    });
    expect(result.structuredContent).toMatchObject({
      projectId: "project_1",
      alerts: [
        {
          id: "gsc-click-drop",
          state: "unknown",
          evidence: {
            property: "sc-domain:example.com",
            currentClicks: 70,
            previousClicks: 100,
            periods: null,
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("foreign");
    expect(result.structuredContent?.alerts[0]?.evidence).not.toHaveProperty(
      "provenance",
    );
    expect(previewProjectAlertsTool.config.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
  });
});
