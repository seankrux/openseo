import { afterEach, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  project: vi.fn(),
  gscConnection: vi.fn(),
  ga4Connection: vi.fn(),
  getCached: vi.fn(),
}));
export { mocks };
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: { getProjectForOrganization: mocks.project },
}));
vi.mock("@/server/features/gsc/repositories/GscConnectionRepository", () => ({
  GscConnectionRepository: { getByProjectId: mocks.gscConnection },
}));
vi.mock("@/server/features/ga4/repositories/Ga4ConnectionRepository", () => ({
  Ga4ConnectionRepository: { getByProjectId: mocks.ga4Connection },
}));
vi.mock("@/server/lib/r2-cache", () => ({ getCached: mocks.getCached }));

export const scope = { projectId: "project-1", organizationId: "org-1" };
export const gscConnection = {
  ...scope,
  id: "gsc-1",
  siteUrl: "sc-domain:example.com",
  connectedByUserId: "user-1",
  gscAccountId: "google-1",
  updatedAt: "2026-10-01 00:00:00",
};
export const ga4Connection = {
  ...scope,
  id: "ga4-1",
  propertyId: "1234",
  connectedByUserId: "user-1",
  ga4AccountId: "google-2",
  updatedAt: "2026-10-01 00:00:00",
};
export function ga4Cache(overrides = {}) {
  return {
    sessions: 70,
    activeUsers: 60,
    prevSessions: 100,
    prevActiveUsers: 90,
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}
export function gscCache(overrides = {}) {
  return {
    clicks: 70,
    impressions: 800,
    position: 4,
    prevClicks: 100,
    prevImpressions: 1000,
    prevPosition: 3,
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

export const periods = {
  current: { startDate: "2026-09-19", endDate: "2026-10-16" },
  previous: { startDate: "2026-08-22", endDate: "2026-09-18" },
};
export function gscProvenance(overrides = {}) {
  return {
    version: 1,
    kind: "gsc",
    ...scope,
    property: gscConnection.siteUrl,
    binding: {
      id: gscConnection.id,
      userId: gscConnection.connectedByUserId,
      accountId: gscConnection.gscAccountId,
      updatedAt: gscConnection.updatedAt,
    },
    periods,
    dateBasis: {
      timeZone: "America/Los_Angeles",
      windowAnchor: "utc-date",
      lagDays: 3,
    },
    request: {
      startDate: periods.previous.startDate,
      endDate: periods.current.endDate,
      dimensions: ["date"],
      type: "web",
      dataState: "final",
      rowLimit: 200,
    },
    quality: {
      complete: true,
      requestVerified: true,
      rowsValid: true,
      rowCount: 2,
    },
    ...overrides,
  };
}

export const ga4Periods = {
  current: { startDate: "2026-09-21", endDate: "2026-10-18" },
  previous: { startDate: "2026-08-24", endDate: "2026-09-20" },
};
export function ga4Provenance(overrides = {}) {
  return {
    version: 1,
    kind: "ga4",
    ...scope,
    property: ga4Connection.propertyId,
    binding: {
      id: ga4Connection.id,
      userId: ga4Connection.connectedByUserId,
      accountId: ga4Connection.ga4AccountId,
      updatedAt: ga4Connection.updatedAt,
    },
    periods: ga4Periods,
    dateBasis: {
      timeZone: "Asia/Manila",
      windowAnchor: "utc-date",
      lagDays: 1,
    },
    request: {
      dateRanges: [ga4Periods.current, ga4Periods.previous],
      dimensions: [],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }],
      offset: "0",
      limit: "10",
      orderBys: [],
      keepEmptyRows: false,
      returnPropertyQuota: true,
    },
    quality: {
      complete: true,
      rowsValid: true,
      rowCount: 2,
      sampled: false,
      thresholded: false,
      otherRowLoss: false,
      restricted: false,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
  mocks.project.mockResolvedValue({
    id: scope.projectId,
    organizationId: scope.organizationId,
  });
  mocks.gscConnection.mockResolvedValue(null);
  mocks.ga4Connection.mockResolvedValue(null);
  mocks.getCached.mockResolvedValue(null);
});

afterEach(() => vi.useRealTimers());
