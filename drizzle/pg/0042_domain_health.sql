CREATE TABLE "domain_health_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"domain" text NOT NULL,
	"kind" text NOT NULL,
	"from_class" text,
	"to_class" text,
	"detail_json" text DEFAULT '{}' NOT NULL,
	"detected_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_health_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"domain" text NOT NULL,
	"class" text NOT NULL,
	"http_status" integer,
	"final_url" text,
	"ssl_days_remaining" integer,
	"on_cloudflare" boolean DEFAULT false NOT NULL,
	"ga4_ids_json" text DEFAULT '[]' NOT NULL,
	"gtm_ids_json" text DEFAULT '[]' NOT NULL,
	"error" text,
	"trigger" text NOT NULL,
	"checked_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_health_current" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text,
	"domain" text NOT NULL,
	"class" text NOT NULL,
	"http_status" integer,
	"final_url" text,
	"redirect_hops" integer DEFAULT 0 NOT NULL,
	"redirected_other_domain" boolean DEFAULT false NOT NULL,
	"response_time_ms" integer,
	"dns_ok" boolean DEFAULT false NOT NULL,
	"a_records_json" text DEFAULT '[]' NOT NULL,
	"aaaa_records_json" text DEFAULT '[]' NOT NULL,
	"ns_records_json" text DEFAULT '[]' NOT NULL,
	"on_cloudflare" boolean DEFAULT false NOT NULL,
	"ssl_valid" boolean,
	"ssl_expires_at" text,
	"ssl_days_remaining" integer,
	"parked" boolean DEFAULT false NOT NULL,
	"ga4_ids_json" text DEFAULT '[]' NOT NULL,
	"gtm_ids_json" text DEFAULT '[]' NOT NULL,
	"error" text,
	"checked_at" text NOT NULL,
	"next_check_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain_health_changes" ADD CONSTRAINT "domain_health_changes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_health_checks" ADD CONSTRAINT "domain_health_checks_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_health_current" ADD CONSTRAINT "domain_health_current_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_health_current" ADD CONSTRAINT "domain_health_current_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domain_health_changes_org_detected_idx" ON "domain_health_changes" USING btree ("organization_id","detected_at");--> statement-breakpoint
CREATE INDEX "domain_health_changes_domain_idx" ON "domain_health_changes" USING btree ("organization_id","domain");--> statement-breakpoint
CREATE INDEX "domain_health_checks_domain_idx" ON "domain_health_checks" USING btree ("organization_id","domain","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_health_current_org_domain_idx" ON "domain_health_current" USING btree ("organization_id","domain");--> statement-breakpoint
CREATE INDEX "domain_health_current_class_idx" ON "domain_health_current" USING btree ("organization_id","class");--> statement-breakpoint
CREATE INDEX "domain_health_current_next_check_idx" ON "domain_health_current" USING btree ("next_check_at");