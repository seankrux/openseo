import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./better-auth-schema";
import { projects } from "./app.schema";

const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// Keep structurally identical to ../domain-health.schema.ts.
export const domainHealthCurrent = pgTable(
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
    redirectedOtherDomain: boolean("redirected_other_domain")
      .notNull()
      .default(false),
    responseTimeMs: integer("response_time_ms"),
    dnsOk: boolean("dns_ok").notNull().default(false),
    aRecordsJson: text("a_records_json").notNull().default("[]"),
    aaaaRecordsJson: text("aaaa_records_json").notNull().default("[]"),
    nsRecordsJson: text("ns_records_json").notNull().default("[]"),
    onCloudflare: boolean("on_cloudflare").notNull().default(false),
    sslValid: boolean("ssl_valid"),
    sslExpiresAt: text("ssl_expires_at"),
    sslDaysRemaining: integer("ssl_days_remaining"),
    parked: boolean("parked").notNull().default(false),
    ga4IdsJson: text("ga4_ids_json").notNull().default("[]"),
    gtmIdsJson: text("gtm_ids_json").notNull().default("[]"),
    error: text("error"),
    checkedAt: text("checked_at").notNull(),
    nextCheckAt: text("next_check_at"),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
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

export const domainHealthChecks = pgTable(
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
    onCloudflare: boolean("on_cloudflare").notNull().default(false),
    ga4IdsJson: text("ga4_ids_json").notNull().default("[]"),
    gtmIdsJson: text("gtm_ids_json").notNull().default("[]"),
    error: text("error"),
    trigger: text("trigger").notNull(),
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

export const domainHealthChanges = pgTable(
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
