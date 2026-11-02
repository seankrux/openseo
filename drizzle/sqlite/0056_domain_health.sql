CREATE TABLE `domain_health_current` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text,
	`domain` text NOT NULL,
	`class` text NOT NULL,
	`http_status` integer,
	`final_url` text,
	`redirect_hops` integer DEFAULT 0 NOT NULL,
	`redirected_other_domain` integer DEFAULT false NOT NULL,
	`response_time_ms` integer,
	`dns_ok` integer DEFAULT false NOT NULL,
	`a_records_json` text DEFAULT '[]' NOT NULL,
	`aaaa_records_json` text DEFAULT '[]' NOT NULL,
	`ns_records_json` text DEFAULT '[]' NOT NULL,
	`on_cloudflare` integer DEFAULT false NOT NULL,
	`ssl_valid` integer,
	`ssl_expires_at` text,
	`ssl_days_remaining` integer,
	`parked` integer DEFAULT false NOT NULL,
	`ga4_ids_json` text DEFAULT '[]' NOT NULL,
	`gtm_ids_json` text DEFAULT '[]' NOT NULL,
	`error` text,
	`checked_at` text NOT NULL,
	`next_check_at` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `domain_health_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`domain` text NOT NULL,
	`class` text NOT NULL,
	`http_status` integer,
	`final_url` text,
	`ssl_days_remaining` integer,
	`on_cloudflare` integer DEFAULT false NOT NULL,
	`ga4_ids_json` text DEFAULT '[]' NOT NULL,
	`gtm_ids_json` text DEFAULT '[]' NOT NULL,
	`error` text,
	`trigger` text NOT NULL,
	`checked_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `domain_health_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`domain` text NOT NULL,
	`kind` text NOT NULL,
	`from_class` text,
	`to_class` text,
	`detail_json` text DEFAULT '{}' NOT NULL,
	`detected_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domain_health_current_org_domain_idx` ON `domain_health_current` (`organization_id`,`domain`);
--> statement-breakpoint
CREATE INDEX `domain_health_current_class_idx` ON `domain_health_current` (`organization_id`,`class`);
--> statement-breakpoint
CREATE INDEX `domain_health_current_next_check_idx` ON `domain_health_current` (`next_check_at`);
--> statement-breakpoint
CREATE INDEX `domain_health_checks_domain_idx` ON `domain_health_checks` (`organization_id`,`domain`,`checked_at`);
--> statement-breakpoint
CREATE INDEX `domain_health_changes_org_detected_idx` ON `domain_health_changes` (`organization_id`,`detected_at`);
--> statement-breakpoint
CREATE INDEX `domain_health_changes_domain_idx` ON `domain_health_changes` (`organization_id`,`domain`);
