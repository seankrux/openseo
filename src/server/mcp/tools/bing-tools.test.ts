import { beforeEach, describe, expect, it, vi } from "vitest";
import { BingWebmasterService } from "@/server/features/bing/BingWebmasterService";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
import { refreshBingWebmasterSnapshotTool } from "./bing-tools";
import { makeToolContext } from "./tool-test-support";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: { getProjectForOrganization: vi.fn() },
}));
vi.mock("@/server/features/bing/BingWebmasterService", () => ({
  BingWebmasterService: { refreshSnapshot: vi.fn() },
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
  vi.mocked(BingWebmasterService.refreshSnapshot).mockResolvedValue({
    schemaVersion: 1,
    provider: "bing-webmaster",
    projectId: "project_1",
    organizationId: "org_123",
    bindingId: "c87a1020-fbd2-4e25-93fa-cb39c40505ee",
    siteUrl: "https://example.com/",
    fetchedAt: "2026-10-19T00:00:00Z",
    performance: [],
    crawl: [],
    scope: {
      aggregation: "daily",
      performanceSurfaces: "combined Bing surfaces",
      timezone: null,
      window: "provider-returned dates",
      comparableToGoogleSearchConsole: false,
    },
    limitations: [
      "Provider-returned daily scope is not directly comparable to Google Search Console.",
    ],
  });
});

describe("refresh_bing_webmaster_snapshot", () => {
  it("uses only authenticated project scope and returns compact read-only-provider evidence", async () => {
    const args = {
      projectId: "project_1",
      siteUrl: "https://foreign.example/",
      organizationId: "foreign",
      apiKey: "untrusted-model-input",
    };
    const result = await refreshBingWebmasterSnapshotTool.handler(
      args,
      makeToolContext(),
    );

    expect(BingWebmasterService.refreshSnapshot).toHaveBeenCalledWith({
      projectId: "project_1",
      organizationId: "org_123",
    });
    expect(result.structuredContent).toMatchObject({
      siteUrl: "https://example.com/",
      performanceRows: 0,
      crawlRows: 0,
      scope: { comparableToGoogleSearchConsole: false },
    });
    expect(result.structuredContent).not.toHaveProperty("organizationId");
    expect(result.structuredContent).not.toHaveProperty("bindingId");
    expect(JSON.stringify(result)).not.toContain("untrusted-model-input");
  });
});
