import { createClient, type InStatement } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { getAuditSummaries } from "./PortfolioService";

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: {},
}));
vi.mock("@/server/lib/ga4Client", () => ({ createGa4DataClient: vi.fn() }));

const client = createClient({ url: "file::memory:" });
let queryCount = 0;
let largestParameterCount = 0;
const testDb = drizzle(client, {
  logger: {
    logQuery(_query, parameters) {
      queryCount++;
      largestParameterCount = Math.max(
        largestParameterCount,
        parameters.length,
      );
    },
  },
});

beforeAll(async () => {
  await client.executeMultiple(`
    CREATE TABLE audits (
      id TEXT PRIMARY KEY, project_id TEXT, status TEXT, completed_at TEXT,
      pages_crawled INTEGER, started_at TEXT
    );
    -- Child IDs must be present, as in production: an accidentally unqualified
    -- outer audit ID would bind to these inner columns instead.
    CREATE TABLE audit_issues (
      id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      audit_id TEXT, severity TEXT
    );
    CREATE TABLE audit_lighthouse_results (
      id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      audit_id TEXT, seo_score REAL, performance_score REAL
    );
    CREATE INDEX audits_project_started ON audits(project_id, started_at);
    CREATE INDEX issues_audit_severity ON audit_issues(audit_id, severity);
    CREATE INDEX lighthouse_audit ON audit_lighthouse_results(audit_id);
  `);
});
beforeEach(async () => {
  await client.executeMultiple(
    "DELETE FROM audits; DELETE FROM audit_issues; DELETE FROM audit_lighthouse_results;",
  );
  queryCount = 0;
  largestParameterCount = 0;
});
afterAll(() => client.close());

describe("portfolio audit summaries", () => {
  it("reads more than 90 latest audits in one query without a bound audit-ID list", async () => {
    const statements: InStatement[] = Array.from({ length: 91 }, (_, i) => ({
      sql: "INSERT INTO audits VALUES (?, ?, 'completed', 'done', ?, '2026-11-01')",
      args: [`audit-${i}`, `project-${i}`, i],
    }));
    await client.batch(statements, "write");
    const projects = Array.from({ length: 91 }, (_, i) => `project-${i}`);

    const summaries = await getAuditSummaries([...projects, projects[0]!]);

    expect(summaries.size).toBe(91);
    expect(summaries.get("project-0")).toEqual({
      status: "completed",
      completedAt: "done",
      pagesCrawled: 0,
      critical: 0,
      warning: 0,
      lighthouseSeo: null,
      lighthousePerf: null,
    });
    expect(summaries.get("project-90")?.pagesCrawled).toBe(90);
    expect(queryCount).toBe(1);
    expect(largestParameterCount).toBeLessThanOrEqual(4);
  });

  it("keeps failed and running latest audits, excluding obsolete issues and unrequested projects", async () => {
    await client.executeMultiple(`
      INSERT INTO audits VALUES
        ('old','failed-project','completed','old-done',9,'2026-10-01'),
        ('failed','failed-project','failed',NULL,0,'2026-11-01'),
        ('running','running-project','running',NULL,4,'2026-11-02'),
        ('other','unrequested-project','completed','done',7,'2026-11-03');
      INSERT INTO audit_issues (audit_id, severity) VALUES
        ('old','critical'),('old','critical'),('failed','warning'),
        ('running','critical'),('running','warning'),('running','warning'),
        ('running','info'),('other','critical');
      INSERT INTO audit_lighthouse_results (audit_id, seo_score, performance_score) VALUES ('old',99,99);
    `);

    const summaries = await getAuditSummaries([
      "failed-project",
      "running-project",
      "running-project",
      "missing-project",
    ]);

    expect([...summaries.keys()].sort()).toEqual([
      "failed-project",
      "running-project",
    ]);
    expect(summaries.get("failed-project")).toEqual({
      status: "failed",
      completedAt: null,
      pagesCrawled: 0,
      critical: 0,
      warning: 1,
      lighthouseSeo: null,
      lighthousePerf: null,
    });
    expect(summaries.get("running-project")).toMatchObject({
      status: "running",
      completedAt: null,
      pagesCrawled: 4,
      critical: 1,
      warning: 2,
    });
  });

  it("keeps the existing last-encountered Map winner for tied latest timestamps", async () => {
    await client.executeMultiple(`
      INSERT INTO audits VALUES
        ('tie-first','project','completed','done',8,'2026-11-01'),
        ('tie-last','project','failed',NULL,2,'2026-11-01');
      INSERT INTO audit_issues (audit_id, severity) VALUES
        ('tie-first','critical'),('tie-last','warning'),('tie-last','warning');
      INSERT INTO audit_lighthouse_results (audit_id, seo_score, performance_score) VALUES
        ('tie-first',99,99),('tie-last',NULL,NULL);
    `);

    const summaries = await getAuditSummaries(["project"]);

    expect(summaries.size).toBe(1);
    expect(summaries.get("project")).toEqual({
      status: "failed",
      completedAt: null,
      pagesCrawled: 2,
      critical: 0,
      warning: 2,
      lighthouseSeo: null,
      lighthousePerf: null,
    });
  });

  it("averages each non-null Lighthouse score independently and rounds as before", async () => {
    await client.executeMultiple(`
      INSERT INTO audits VALUES
        ('scores','project','completed','done',3,'2026-11-01'),
        ('empty','empty-project','completed','done',1,'2026-11-01');
      INSERT INTO audit_lighthouse_results (audit_id, seo_score, performance_score) VALUES
        ('scores',89,20),('scores',90,NULL),('scores',NULL,30);
    `);

    const summaries = await getAuditSummaries(["project", "empty-project"]);

    expect(summaries.get("project")).toMatchObject({
      lighthouseSeo: 90,
      lighthousePerf: 25,
    });
    expect(summaries.get("empty-project")).toMatchObject({
      lighthouseSeo: null,
      lighthousePerf: null,
    });
  });

  it("does no database work for an empty requested scope", async () => {
    expect((await getAuditSummaries([])).size).toBe(0);
    expect(queryCount).toBe(0);
  });
});
