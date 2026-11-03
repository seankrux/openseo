import { audits, projects } from "@/db/schema";
import { AppError } from "@/server/lib/errors";
import { createClient, type InStatement } from "@libsql/client";
import { getTableColumns, getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  clearFleetReauditQueue,
  getFleetReauditStatus,
  queueFleetReaudit,
  runFleetReauditTick,
  runScheduledFleetReaudit,
  setFleetReauditMode,
} from "./FleetReauditService";

const mocks = vi.hoisted(() => ({
  startAudit: vi.fn<(input: StartInput) => Promise<{ auditId: string }>>(),
  objects: new Map<
    string,
    { value: string; customMetadata: Record<string, string> }
  >(),
}));
vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
}));
vi.mock("cloudflare:workers", () => ({
  env: {
    AUTH_MODE: "local_noauth",
    R2: {
      get: async (key: string) => {
        const object = mocks.objects.get(key);
        return object
          ? {
              text: async () => object.value,
              customMetadata: object.customMetadata,
            }
          : null;
      },
      put: async (
        key: string,
        value: string,
        options: { customMetadata: Record<string, string> },
      ) => {
        mocks.objects.set(key, {
          value,
          customMetadata: options.customMetadata,
        });
      },
    },
  },
}));
// The crawler boundary: starting an audit probes the live site and launches a
// workflow. Everything on this side of it runs for real.
vi.mock("@/server/features/audit/services/AuditService", () => ({
  AuditService: {
    startAudit: mocks.startAudit,
    resolveAuditLimitTier: async () => "self_hosted",
  },
}));

const client = createClient({ url: "file::memory:" });
const testDb = drizzle(client);
const org = "delegated-local-admin";
const actor = { userId: "local-admin", userEmail: "admin@localhost" };
const tables: SQLiteTable[] = [projects, audits];
type StartInput = { projectId: string; startUrl: string };

beforeAll(async () => {
  for (const table of tables) {
    const columns = Object.values(getTableColumns(table)).map(
      (c) => `"${c.name}" ${c.getSQLType()}`,
    );
    await client.execute(
      `CREATE TABLE "${getTableName(table)}" (${columns.join(", ")})`,
    );
  }
});
afterAll(() => client.close());
afterEach(() => vi.useRealTimers());
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
  mocks.objects.clear();
  mocks.startAudit.mockReset();
  // Like the real startAudit, a started audit is a "running" row.
  mocks.startAudit.mockImplementation(async (input) => {
    const auditId = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO audits (id, project_id, started_by_user_id, start_url, status, config, started_at) VALUES (?, ?, ?, ?, 'running', '{}', ?)",
      args: [
        auditId,
        input.projectId,
        "local-admin",
        input.startUrl,
        new Date().toISOString(),
      ],
    });
    return { auditId };
  });
  for (const table of tables)
    await client.execute(`DELETE FROM "${getTableName(table)}"`);
});

/** One project per entry; `audit` is the latest audit's start time and status. */
async function seed(
  sites: Array<{
    id: string;
    audit?: { at: string; status?: "running" | "completed" | "failed" };
    archived?: boolean;
  }>,
) {
  const statements: InStatement[] = [];
  for (const s of sites) {
    statements.push({
      sql: "INSERT INTO projects (id, name, domain, organization_id, archived_at) VALUES (?, ?, ?, ?, ?)",
      args: [
        s.id,
        s.id,
        `${s.id}.example`,
        org,
        s.archived ? "2026-10-01 00:00:00" : null,
      ],
    });
    if (s.audit)
      statements.push({
        sql: "INSERT INTO audits (id, project_id, started_by_user_id, start_url, status, config, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [
          `audit-${s.id}`,
          s.id,
          "local-admin",
          `https://${s.id}.example/`,
          s.audit.status ?? "completed",
          '{"maxPages":10,"lighthouseStrategy":"none","renderJavaScript":false}',
          s.audit.at,
        ],
      });
  }
  await client.batch(statements, "write");
}

const started = () =>
  mocks.startAudit.mock.calls.map((call: StartInput[]) => call[0].projectId);

describe("fleet re-audit", () => {
  it("a scheduled tick re-audits the oldest stale sites first, up to the mode's batch size", async () => {
    await seed([
      { id: "fresh", audit: { at: "2026-10-28 09:00:00" } },
      { id: "old-3", audit: { at: "2026-10-18 09:00:00" } },
      { id: "old-1", audit: { at: "2026-10-16 09:00:00" } },
      { id: "never" },
      { id: "old-2", audit: { at: "2026-10-17 09:00:00" } },
      { id: "old-5", audit: { at: "2026-10-20 09:00:00" } },
      { id: "old-4", audit: { at: "2026-10-19 09:00:00" } },
      { id: "gone", audit: { at: "2026-10-01 09:00:00" }, archived: true },
    ]);
    await setFleetReauditMode(org, "gentle", actor);

    await runFleetReauditTick(org);

    // Gentle starts 3 per tick: never audited first, then oldest.
    expect(started()).toEqual(["never", "old-1", "old-2"]);
    expect(mocks.startAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "local-admin",
        startUrl: "https://never.example",
        maxPages: 10,
        lighthouseStrategy: "none",
        renderJavaScript: false,
        limitTier: "self_hosted",
      }),
    );
    expect(await getFleetReauditStatus(org)).toMatchObject({
      mode: "gentle",
      // 6 were due; 3 started and are now running.
      due: 3,
      running: 3,
      lastTick: { started: 3, failed: 0 },
    });
  });

  it("never lets running audits pass the mode's cap or re-audits a running site", async () => {
    // Gentle allows 6 running; 4 are already running, so only 2 may start.
    await seed([
      ...["r1", "r2", "r3", "r4"].map((id) => ({
        id,
        audit: { at: "2026-10-01 09:00:00", status: "running" as const },
      })),
      { id: "old-1", audit: { at: "2026-10-10 09:00:00" } },
      { id: "old-2", audit: { at: "2026-10-11 09:00:00" } },
      { id: "old-3", audit: { at: "2026-10-12 09:00:00" } },
    ]);
    await setFleetReauditMode(org, "gentle", actor);

    await runFleetReauditTick(org);

    expect(started()).toEqual(["old-1", "old-2"]);
  });

  it("does nothing while the schedule is off", async () => {
    await seed([{ id: "never" }]);
    await setFleetReauditMode(org, "off", actor);

    await runFleetReauditTick(org);

    expect(mocks.startAudit).not.toHaveBeenCalled();
  });

  it("records a site that cannot start and carries on with the batch", async () => {
    await seed([
      { id: "broken", audit: { at: "2026-10-01 09:00:00" } },
      { id: "ok", audit: { at: "2026-10-02 09:00:00" } },
    ]);
    const realStart = mocks.startAudit.getMockImplementation()!;
    mocks.startAudit.mockImplementation(async (input) => {
      if (input.projectId === "broken")
        throw new AppError("VALIDATION_ERROR", "Start URL did not resolve");
      return realStart(input);
    });
    await setFleetReauditMode(org, "normal", actor);

    await runFleetReauditTick(org);

    expect(started()).toEqual(["broken", "ok"]);
    expect((await getFleetReauditStatus(org)).lastTick).toMatchObject({
      started: 1,
      failed: 1,
      errors: [{ projectId: "broken", code: "VALIDATION_ERROR" }],
    });
  });

  it("re-audits sites picked on demand, even fresh ones and while the schedule is off", async () => {
    await seed([
      { id: "stale", audit: { at: "2026-10-01 09:00:00" } },
      { id: "fresh-a", audit: { at: "2026-10-29 09:00:00" } },
      { id: "fresh-b", audit: { at: "2026-10-29 10:00:00" } },
      { id: "busy", audit: { at: "2026-10-30 11:00:00", status: "running" } },
    ]);

    expect(
      await queueFleetReaudit(
        org,
        ["fresh-b", "fresh-a", "busy", "unknown"],
        actor,
      ),
    ).toEqual({ queued: 3 });
    expect(await getFleetReauditStatus(org)).toMatchObject({
      mode: "off",
      queued: 3,
    });

    await runFleetReauditTick(org);

    // Picked sites go in the order asked; a running site waits its turn and
    // a site outside the fleet is dropped. The stale site is not picked.
    expect(started()).toEqual(["fresh-b", "fresh-a"]);
    expect((await getFleetReauditStatus(org)).queued).toBe(1);
  });

  it("drains picked sites at the mode's rate before stale ones", async () => {
    await seed([
      { id: "stale", audit: { at: "2026-10-01 09:00:00" } },
      ...["a", "b", "c", "d"].map((id) => ({
        id,
        audit: { at: "2026-10-29 09:00:00" },
      })),
    ]);
    await setFleetReauditMode(org, "gentle", actor);
    await queueFleetReaudit(org, ["a", "b", "c", "d"], actor);

    await runFleetReauditTick(org);
    expect(started()).toEqual(["a", "b", "c"]);

    await runFleetReauditTick(org);
    expect(started()).toEqual(["a", "b", "c", "d", "stale"]);
  });

  it("can cancel picked sites that have not started", async () => {
    await seed([{ id: "a", audit: { at: "2026-10-29 09:00:00" } }]);
    await queueFleetReaudit(org, ["a"], actor);

    await clearFleetReauditQueue(org);
    await runFleetReauditTick(org);

    expect(mocks.startAudit).not.toHaveBeenCalled();
    expect((await getFleetReauditStatus(org)).queued).toBe(0);
  });

  it("drains picked sites 5 per tick while the schedule is off", async () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    await seed(ids.map((id) => ({ id, audit: { at: "2026-10-29 09:00:00" } })));
    await queueFleetReaudit(org, ids, actor);

    await runFleetReauditTick(org);

    expect(started()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("starts a site once when it is both picked and stale", async () => {
    await seed([
      { id: "stale-picked", audit: { at: "2026-10-01 09:00:00" } },
      { id: "stale", audit: { at: "2026-10-02 09:00:00" } },
    ]);
    await setFleetReauditMode(org, "gentle", actor);
    await queueFleetReaudit(org, ["stale-picked"], actor);

    await runFleetReauditTick(org);

    expect(started()).toEqual(["stale-picked", "stale"]);
  });

  it("the 5-minute scheduler runs one tick for each organization", async () => {
    await seed([{ id: "never" }]);
    await setFleetReauditMode(org, "normal", actor);

    await runScheduledFleetReaudit();

    expect(started()).toEqual(["never"]);
  });
});
