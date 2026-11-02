import { vi } from "vitest";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { getLatestResults } from "@/server/features/rank-tracking/services/rankTrackingResults";
import { loadAiTrend } from "@/server/features/ai-visibility/services/aiVisibilityTrend";
import type { AiTrend } from "@/shared/ai-visibility";
import { StoredGoogleSnapshotService } from "@/server/features/portfolio/StoredGoogleSnapshotService";
import { BingWebmasterService } from "@/server/features/bing/BingWebmasterService";
import { ProjectHealthRepository } from "../repositories/ProjectHealthRepository";
import { ReportService } from "./ReportService";

export function googleEvidence(): Awaited<
  ReturnType<typeof StoredGoogleSnapshotService.read>
> {
  const missing = {
    status: "unavailable" as const,
    property: null,
    fetchedAt: null,
    periods: null,
    limitations: ["No active connection."],
    current: null,
    previous: null,
  };
  return { gsc: { ...missing }, ga4: { ...missing } };
}

export function aiTrend(): AiTrend {
  const coverage = {
    runs: 0,
    expected: 0,
    answered: 0,
    noAnswer: 0,
    failed: 0,
  };
  const metric = {
    current: null,
    previous: null,
    change: null,
    matchedCells: 0,
    currentCells: 0,
    previousCells: 0,
  };
  return {
    days: 28,
    comparison: "no_data",
    current: {
      start: "2026-09-21T00:00:00Z",
      end: "2026-10-19T00:00:00Z",
      coverage,
    },
    previous: {
      start: "2026-08-24T00:00:00Z",
      end: "2026-09-21T00:00:00Z",
      coverage,
    },
    mentions: metric,
    citations: metric,
    engines: [],
    runs: [],
  };
}

export const input = {
  projectId: "project_1",
  organizationId: "org_1",
  createdBy: "OpenSEO",
  createdByUserId: "user_1",
};
export const project = {
  id: "project_1",
  organizationId: "org_1",
  name: "Concrete repair",
  domain: "example.com",
  locationCode: 2840,
  languageCode: "en",
  createdAt: "2026-09-01 00:00:00",
  archivedAt: null,
  aiResearchKeywords: null,
  indexnowKey: null,
};

export function setDefaultEvidence() {
  vi.mocked(ProjectRepository.getProjectForOrganization).mockResolvedValue(
    project,
  );
  vi.mocked(ProjectHealthRepository.getLatestCompletedAudit).mockResolvedValue(
    null,
  );
  vi.mocked(RankTrackingRepository.getConfigsForProject).mockResolvedValue([]);
  vi.mocked(getLatestResults).mockResolvedValue({ rows: [], run: null });
  vi.mocked(loadAiTrend).mockResolvedValue(aiTrend());
  vi.mocked(StoredGoogleSnapshotService.read).mockResolvedValue(
    googleEvidence(),
  );
  vi.mocked(BingWebmasterService.getStoredSnapshot).mockResolvedValue(null);
  vi.mocked(ReportService.saveReport).mockResolvedValue({
    reportId: "report_1",
    title: "Project Health",
    created: true,
    htmlBytes: 100,
  });
}
