CREATE TABLE `adaptation_log` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` integer NOT NULL,
	`action` text NOT NULL,
	`surface_id` text,
	`variant_id` text,
	`context_bucket` text,
	`reason` text NOT NULL,
	`stats` text NOT NULL,
	`reward_version` integer NOT NULL,
	`actor` text NOT NULL,
	`actor_ref` text,
	CONSTRAINT "adaptation_action_valid" CHECK(action IN ('generated', 'promoted', 'retired', 'quarantined', 'released', 'pinned', 'unpinned', 'rolled_back', 'config_changed', 'paused', 'resumed'))
);
--> statement-breakpoint
CREATE INDEX `adaptation_log_time_idx` ON `adaptation_log` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `adaptation_log_surface_idx` ON `adaptation_log` (`surface_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `adaptation_log_action_idx` ON `adaptation_log` (`action`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `consent_record` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`anon_id_hash` text,
	`mask` integer NOT NULL,
	`source` text NOT NULL,
	`policy_version` text NOT NULL,
	`recorded_at` integer NOT NULL,
	CONSTRAINT "consent_subject_present" CHECK("consent_record"."user_id" IS NOT NULL OR "consent_record"."anon_id_hash" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `consent_user_idx` ON `consent_record` (`user_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `consent_anon_idx` ON `consent_record` (`anon_id_hash`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `content` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`body` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`trend_signal_id` text,
	`sources` text NOT NULL,
	`generated_by` text,
	`generation_prompt` text,
	`reviewed_by` text,
	`reviewed_at` integer,
	`published_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "content_status_valid" CHECK(status IN ('draft', 'pending_review', 'published', 'rejected', 'archived')),
	CONSTRAINT "content_published_needs_sources" CHECK("content"."status" <> 'published' OR json_array_length("content"."sources") > 0),
	CONSTRAINT "content_generated_needs_review" CHECK("content"."status" <> 'published' OR "content"."generated_by" IS NULL OR "content"."reviewed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_slug_unique` ON `content` (`slug`);--> statement-breakpoint
CREATE INDEX `content_status_idx` ON `content` (`status`,`published_at`);--> statement-breakpoint
CREATE INDEX `content_trend_idx` ON `content` (`trend_signal_id`);--> statement-breakpoint
CREATE TABLE `data_subject_request` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_ref` text NOT NULL,
	`requested_at` integer NOT NULL,
	`completed_at` integer,
	`result` text,
	`error` text,
	CONSTRAINT "dsr_kind_valid" CHECK(kind IN ('export', 'erasure'))
);
--> statement-breakpoint
CREATE INDEX `dsr_pending_idx` ON `data_subject_request` (`completed_at`,`requested_at`);--> statement-breakpoint
CREATE TABLE `engine_config` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`config` text NOT NULL,
	`reward_version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text DEFAULT 'system' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `posterior_snapshot` (
	`taken_at` integer NOT NULL,
	`surface_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`context_bucket` text NOT NULL,
	`is_holdout` integer DEFAULT false NOT NULL,
	`alpha` real NOT NULL,
	`beta` real NOT NULL,
	`impressions` integer NOT NULL,
	`reward_sum` real NOT NULL,
	PRIMARY KEY(`taken_at`, `surface_id`, `variant_id`, `context_bucket`, `is_holdout`)
);
--> statement-breakpoint
CREATE INDEX `posterior_surface_idx` ON `posterior_snapshot` (`surface_id`,`taken_at`);--> statement-breakpoint
CREATE TABLE `variant` (
	`id` text PRIMARY KEY NOT NULL,
	`surface_id` text NOT NULL,
	`label` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`origin` text NOT NULL,
	`prior_alpha` real DEFAULT 1 NOT NULL,
	`prior_beta` real DEFAULT 1 NOT NULL,
	`generation_id` text,
	`parent_ids` text,
	`trend_signal_ids` text,
	`model` text,
	`impressions` integer DEFAULT 0 NOT NULL,
	`conversions` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`activated_at` integer,
	`retired_at` integer,
	`quarantined_at` integer,
	`quarantine_reason` text,
	CONSTRAINT "variant_status_valid" CHECK(status IN ('active', 'quarantined', 'retired', 'pinned')),
	CONSTRAINT "variant_origin_valid" CHECK(origin IN ('baseline', 'authored', 'generated')),
	CONSTRAINT "variant_prior_positive" CHECK("variant"."prior_alpha" > 0 AND "variant"."prior_beta" > 0),
	CONSTRAINT "variant_counts_sane" CHECK("variant"."conversions" <= "variant"."impressions")
);
--> statement-breakpoint
CREATE INDEX `variant_surface_status_idx` ON `variant` (`surface_id`,`status`);--> statement-breakpoint
CREATE INDEX `variant_generation_idx` ON `variant` (`generation_id`);