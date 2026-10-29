import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organization } from "./better-auth-schema";
import { projects } from "./app.schema";

/** Latest health snapshot per fleet domain (one row per domain). */
export const domainHealthCurrent = sqliteTable(
  "domain_health_current",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    domain: text("domain").notNull(),
    class: text("class").notNull(),
    httpStatus: integer("http_status"),
    finalUrl: text("final_url"),
    redirectHops: integer("redirect_hops").notNull().default(0),
    redirectedOtherDomain: integer("redirected_other_domain", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    responseTimeMs: integer("response_time_ms"),
    dnsOk: integer("dns_ok", { mode: "boolean" }).notNull().default(false),
    aRecordsJson: text("a_records_json").notNull().default("[]"),
    aaaaRecordsJson: text("aaaa_records_json").notNull().default("[]"),
    nsRecordsJson: text("ns_records_json").notNull().default("[]"),
    onCloudflare: integer("on_cloudflare", { mode: "boolean" })
      .notNull()
      .default(false),
    sslValid: integer("ssl_valid", { mode: "boolean" }),
    sslExpiresAt: text("ssl_expires_at"),
    sslDaysRemaining: integer("ssl_days_remaining"),
    parked: integer("parked", { mode: "boolean" }).notNull().default(false),
    ga4IdsJson: text("ga4_ids_json").notNull().default("[]"),
    gtmIdsJson: text("gtm_ids_json").notNull().default("[]"),
    error: text("error"),
    checkedAt: text("checked_at").notNull(),
    nextCheckAt: text("next_check_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("domain_health_current_org_domain_idx").on(
      table.organizationId,
      table.domain,
    ),
    index("domain_health_current_class_idx").on(
      table.organizationId,
      table.class,
    ),
    index("domain_health_current_next_check_idx").on(table.nextCheckAt),
  ],
);

/** Append-only check history for status-change detection. */
export const domainHealthChecks = sqliteTable(
  "domain_health_checks",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    class: text("class").notNull(),
    httpStatus: integer("http_status"),
    finalUrl: text("final_url"),
    sslDaysRemaining: integer("ssl_days_remaining"),
    onCloudflare: integer("on_cloudflare", { mode: "boolean" })
      .notNull()
      .default(false),
    ga4IdsJson: text("ga4_ids_json").notNull().default("[]"),
    gtmIdsJson: text("gtm_ids_json").notNull().default("[]"),
    error: text("error"),
    trigger: text("trigger").notNull(), // scheduled_full | scheduled_problem | recheck | manual
    checkedAt: text("checked_at").notNull(),
  },
  (table) => [
    index("domain_health_checks_domain_idx").on(
      table.organizationId,
      table.domain,
      table.checkedAt,
    ),
  ],
);

/** Status-change feed for the all-sites dashboard. */
export const domainHealthChanges = sqliteTable(
  "domain_health_changes",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    kind: text("kind").notNull(),
    fromClass: text("from_class"),
    toClass: text("to_class"),
    detailJson: text("detail_json").notNull().default("{}"),
    detectedAt: text("detected_at").notNull(),
  },
  (table) => [
    index("domain_health_changes_org_detected_idx").on(
      table.organizationId,
      table.detectedAt,
    ),
    index("domain_health_changes_domain_idx").on(
      table.organizationId,
      table.domain,
    ),
  ],
);
