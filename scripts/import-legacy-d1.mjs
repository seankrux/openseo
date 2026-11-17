#!/usr/bin/env node
/**
 * Copy rows from a legacy self-hosted D1 SQLite export into a database that
 * already has this app's migrations applied.
 *
 *   node scripts/import-legacy-d1.mjs --from old.sqlite --to new.sqlite
 *
 * The fork's drizzle history is not replayed. Upstream reused migration
 * numbers from 0056 upward, and the fork's bing_site_bindings SQL used
 * 0056, so an old D1's migration table does not match this journal. Apply
 * drizzle/sqlite (this app's journal) to an empty database first, then copy.
 *
 * What the copy does:
 * - For every table present on both sides, insert the columns the two
 *   schemas share. Columns this app added (guest accounts, signup source,
 *   local SEO, Stripe projects, AI-mode engine, and the rest of the upstream
 *   migrations after the fork point) stay at their defaults.
 * - Fork tables this app still creates are copied the same way:
 *   bing_site_bindings, domain_health_current, domain_health_checks,
 *   domain_health_changes.
 * - Tables that exist only in the old file are listed and skipped.
 * - Migration bookkeeping is not copied: d1_migrations,
 *   __drizzle_migrations, sqlite_sequence.
 *
 * Export the old D1 with `wrangler d1 export`, and point --to at a sqlite
 * file you can later import (`wrangler d1 execute --file`, or the EveryApp
 * database tools) after checking the printed summary.
 */
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const SKIP = new Set([
  "d1_migrations",
  "__drizzle_migrations",
  "sqlite_sequence",
  "sqlite_stat1",
]);

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    to: { type: "string" },
  },
});

if (!values.from || !values.to) {
  console.error(
    "usage: node scripts/import-legacy-d1.mjs --from old.sqlite --to new.sqlite",
  );
  process.exit(1);
}

const source = new DatabaseSync(values.from, { readOnly: true });
const target = new DatabaseSync(values.to);

function tables(db) {
  return db
    .prepare(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
    )
    .all()
    .map((row) => row.name);
}

function columns(db, table) {
  return db
    .prepare(`pragma table_info(${quote(table)})`)
    .all()
    .map((row) => row.name);
}

function quote(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

const sourceTables = new Set(tables(source));
const targetTables = new Set(tables(target));
const onlyOld = [...sourceTables].filter(
  (name) => !targetTables.has(name) && !SKIP.has(name),
);
const copied = [];

target.exec("pragma foreign_keys = off");
target.exec("begin");
try {
  for (const table of sourceTables) {
    if (SKIP.has(table) || !targetTables.has(table)) continue;
    const shared = columns(source, table).filter((name) =>
      columns(target, table).includes(name),
    );
    if (shared.length === 0) {
      onlyOld.push(`${table} (no shared columns)`);
      continue;
    }
    const rows = source
      .prepare(`select ${shared.map(quote).join(", ")} from ${quote(table)}`)
      .all();
    const insert = target.prepare(
      `insert or replace into ${quote(table)} (${shared.map(quote).join(", ")}) values (${shared.map(() => "?").join(", ")})`,
    );
    for (const row of rows) {
      insert.run(...shared.map((name) => row[name]));
    }
    copied.push({ table, rows: rows.length, columns: shared.length });
  }
  target.exec("commit");
} catch (error) {
  target.exec("rollback");
  throw error;
} finally {
  target.exec("pragma foreign_keys = on");
}

console.log(
  JSON.stringify(
    {
      copied,
      skippedOldOnly: onlyOld,
      emptyNewTables: [...targetTables].filter(
        (name) => !sourceTables.has(name) && !SKIP.has(name),
      ),
    },
    null,
    2,
  ),
);
