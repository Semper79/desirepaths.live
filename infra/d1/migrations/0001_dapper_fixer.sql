CREATE TABLE `auth_session` (
	`session_token` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_session_user_idx` ON `auth_session` (`user_id`);--> statement-breakpoint
CREATE INDEX `auth_session_expires_idx` ON `auth_session` (`expires`);--> statement-breakpoint
CREATE TABLE `authenticator` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer DEFAULT false NOT NULL,
	`transports` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `authenticator_user_idx` ON `authenticator` (`user_id`);--> statement-breakpoint
CREATE TABLE `social_identity` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`verified_email` text,
	`handle` text,
	`linked_at` integer NOT NULL,
	`link_confirmed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "social_identity_provider_valid" CHECK(provider IN ('google', 'apple', 'discord', 'tiktok', 'x', 'twitch', 'instagram', 'reddit', 'spotify', 'github', 'email', 'passkey'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `social_identity_provider_account_unique` ON `social_identity` (`provider`,`provider_account_id`);--> statement-breakpoint
CREATE INDEX `social_identity_user_idx` ON `social_identity` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text,
	`email_verified_at` integer,
	`display_name` text,
	`avatar_url` text,
	`locale` text,
	`first_provider` text NOT NULL,
	`signup_assignment_hash` text,
	`signup_context_bucket` text,
	`shadow_banned` integer DEFAULT false NOT NULL,
	`shadow_ban_reason` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "user_first_provider_valid" CHECK(first_provider IN ('google', 'apple', 'discord', 'tiktok', 'x', 'twitch', 'instagram', 'reddit', 'spotify', 'github', 'email', 'passkey', 'pending'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`) WHERE "user"."email" IS NOT NULL AND "user"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `user_created_at_idx` ON `user` (`created_at`);--> statement-breakpoint
CREATE INDEX `user_first_provider_idx` ON `user` (`first_provider`);--> statement-breakpoint
CREATE TABLE `verification_token` (
	`identifier` text NOT NULL,
	`token` text NOT NULL,
	`expires` integer NOT NULL,
	PRIMARY KEY(`identifier`, `token`)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_consent_record` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`anon_id_hash` text,
	`mask` integer NOT NULL,
	`source` text NOT NULL,
	`policy_version` text NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "consent_subject_present" CHECK("__new_consent_record"."user_id" IS NOT NULL OR "__new_consent_record"."anon_id_hash" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_consent_record`("id", "user_id", "anon_id_hash", "mask", "source", "policy_version", "recorded_at") SELECT "id", "user_id", "anon_id_hash", "mask", "source", "policy_version", "recorded_at" FROM `consent_record`;--> statement-breakpoint
DROP TABLE `consent_record`;--> statement-breakpoint
ALTER TABLE `__new_consent_record` RENAME TO `consent_record`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `consent_user_idx` ON `consent_record` (`user_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `consent_anon_idx` ON `consent_record` (`anon_id_hash`,`recorded_at`);