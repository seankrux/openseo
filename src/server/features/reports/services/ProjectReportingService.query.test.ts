import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { ReportService } from "./ReportService";
import { ProjectReportingService } from "./ProjectReportingService";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { loadAiTrend } from "@/server/features/ai-visibility/services/aiVisibilityTrend";
import { StoredGoogleSnapshotService } from "@/server/features/portfolio/StoredGoogleSnapshotService";
import { BingWebmasterService } from "@/server/features/bing/BingWebmasterService";

const state = vi.hoisted(() => ({ database: null as DatabaseSync | null }));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({
  db: drizzle(async (query, params, method) => {
    if (!state.database) throw new Error("Database not initialized");
    const statement = state.database.prepare(query);
    const values = params.map((value: unknown): SQLInputValue => {
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "bigint"
      )
        return value;
      throw new Error("Unexpected SQL parameter");
    });
    if (method === "run") {
      statement.run(...values);
      return { rows: [] };
    }
    return { rows: statement.all(...values).map((row) => Object.values(row)) };
  }),
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: { getProjectForOrganization: vi.fn() },
}));
vi.mock("./ReportService", () => ({ ReportService: { saveReport: vi.fn() } }));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: { getConfigsForProject: vi.fn() },
  }),
);

vi.mock("@/server/features/ai-visibility/services/aiVisibilityTrend", () => ({
  loadAiTrend: vi.fn(),
}));

vi.mock("@/server/features/portfolio/StoredGoogleSnapshotService", () => ({
  StoredGoogleSnapshotService: { read: vi.fn() },
}));

vi.mock("@/server/features/bing/BingWebmasterService", () => ({
  BingWebmasterService: { getStoredSnapshot: vi.fn() },
}));

const input = {
  projectId: "project_1",
  organizationId: "org_1",
  createdBy: "OpenSEO",
  createdByUserId: "user_1",
};

beforeEach(() => {
  state.database = new DatabaseSync(":memory:");
  state.database.exec(`
    CREATE TABLE audits (
      id text PRIMARY KEY, project_id text NOT NULL, start_url text NOT NULL,
      status text NOT NULL, started_at text NOT NULL, completed_at text, pages_crawled integer NOT NULL
    );
    CREATE TABLE audit_issues (id text PRIMARY KEY, audit_id text NOT NULL, severity text NOT NULL);
  `);
  vi.mocked(ProjectRepository.getProjectForOrganization).mockResolvedValue({
    id: "project_1",
    organizationId: "org_1",
    name: "Concrete repair",
    domain: "example.com",
    locationCode: 2840,
    languageCode: "en",
    createdAt: "2026-09-01 00:00:00",
    archivedAt: null,
    aiResearchKeywords: null,
  });
  vi.mocked(RankTrackingRepository.getConfigsForProject).mockResolvedValue([]);
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
  vi.mocked(loadAiTrend).mockResolvedValue({
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
  });
  const missing = {
    status: "unavailable" as const,
    property: null,
    fetchedAt: null,
    periods: null,
    limitations: ["No active connection."],
    current: null,
    previous: null,
  };
  vi.mocked(StoredGoogleSnapshotService.read).mockResolvedValue({
    gsc: { ...missing },
    ga4: { ...missing },
  });
  vi.mocked(BingWebmasterService.getStoredSnapshot).mockResolvedValue(null);
  vi.mocked(ReportService.saveReport).mockResolvedValue({
    reportId: "report_1",
    title: "Project health",
    created: true,
    htmlBytes: 100,
  });
});
afterEach(() => {
  state.database?.close();
  state.database = null;
});

describe("ProjectReportingService saved-audit SQL", () => {
  it("selects only the latest completed project audit and its own issue counts", async () => {
    state.database!.exec(`
      INSERT INTO audits VALUES
        ('old', 'project_1', 'https://example.com/old', 'completed', '2026-10-01T00:00:00Z', '2026-10-01T00:01:00Z', 1),
        ('chosen', 'project_1', 'https://example.com/', 'completed', '2026-10-17T01:00:00Z', '2026-10-17T01:03:00Z', 8),
        ('failed', 'project_1', 'https://example.com/', 'failed', '2026-10-18T00:00:00Z', '2026-10-18T00:03:00Z', 99),
        ('running', 'project_1', 'https://example.com/', 'running', '2026-10-19T00:00:00Z', '2026-10-19T00:03:00Z', 99),
        ('unfinished', 'project_1', 'https://example.com/', 'completed', '2026-10-19T00:00:00Z', NULL, 99),
        ('foreign', 'project_2', 'https://foreign.example/', 'completed', '2026-10-19T00:00:00Z', '2026-10-19T00:03:00Z', 99);
      INSERT INTO audit_issues VALUES
        ('c1', 'chosen', 'critical'), ('c2', 'chosen', 'critical'),
        ('w1', 'chosen', 'warning'), ('i1', 'chosen', 'info'),
        ('other', 'foreign', 'critical'), ('previous', 'old', 'warning');
    `);

    const report = await ProjectReportingService.generate(input);

    expect(report.evidence.audit).toEqual({
      auditId: "chosen",
      startUrl: "https://example.com/",
      startedAt: "2026-10-17T01:00:00Z",
      completedAt: "2026-10-17T01:03:00Z",
      pagesCrawled: 8,
      criticalIssues: 2,
      warningIssues: 1,
      informationalIssues: 1,
    });
  });

  it("keeps a missing completed audit unknown rather than a zero-issue healthy result", async () => {
    state.database!.exec(`
      INSERT INTO audits VALUES
        ('failed', 'project_1', 'https://example.com/', 'failed', '2026-10-18T00:00:00Z', '2026-10-18T00:03:00Z', 0),
        ('foreign', 'project_2', 'https://foreign.example/', 'completed', '2026-10-19T00:00:00Z', '2026-10-19T00:03:00Z', 99);
    `);

    const report = await ProjectReportingService.generate(input);

    expect(report.evidence.audit).toBeNull();
    expect(
      vi.mocked(ReportService.saveReport).mock.calls[0]?.[0].html,
    ).toContain("Unknown: no saved completed audit");
  });
});
