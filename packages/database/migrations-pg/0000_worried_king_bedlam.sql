CREATE TABLE "admin_credential" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"password_version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"encrypted_key" text,
	"scopes" jsonb DEFAULT '[]' NOT NULL,
	"last_used_at" text,
	"expires_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"correlation_id" text,
	"actor" text DEFAULT 'system' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"details" jsonb DEFAULT '{}' NOT NULL,
	"ip" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocklist_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"media_type" text NOT NULL,
	"media_id" text NOT NULL,
	"indexer_id" text,
	"title" text NOT NULL,
	"torrent_infohash" text,
	"reason" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_format" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"specs" jsonb DEFAULT '[]' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "custom_format_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "download_client" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"implementation" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 1 NOT NULL,
	"settings" jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "download_queue_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"media_type" text NOT NULL,
	"media_id" text NOT NULL,
	"download_client_id" text,
	"download_id" text,
	"title" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"remaining_time" integer,
	"error_message" text,
	"data" jsonb DEFAULT '{}' NOT NULL,
	"added_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "episode" (
	"id" text PRIMARY KEY NOT NULL,
	"series_id" text NOT NULL,
	"season_id" text NOT NULL,
	"episode_number" integer NOT NULL,
	"absolute_number" integer,
	"title" text DEFAULT '' NOT NULL,
	"overview" text DEFAULT '' NOT NULL,
	"air_date_utc" text,
	"monitored" boolean DEFAULT true NOT NULL,
	"has_file" boolean DEFAULT false NOT NULL,
	"scene_season_number" integer,
	"scene_episode_number" integer
);
--> statement-breakpoint
CREATE TABLE "event_outbox" (
	"seq" serial PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"type" text NOT NULL,
	"version" integer NOT NULL,
	"occurred_at" text NOT NULL,
	"correlation_id" text NOT NULL,
	"aggregate" jsonb DEFAULT '[]' NOT NULL,
	"payload" jsonb DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_check_result" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"checked_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "history_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"media_type" text NOT NULL,
	"media_id" text NOT NULL,
	"action" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_exclusion" (
	"id" text PRIMARY KEY NOT NULL,
	"media_type" text NOT NULL,
	"external_id" text NOT NULL,
	"reason" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_list" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb NOT NULL,
	"last_synced_at" text,
	"last_error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexer" (
	"id" text PRIMARY KEY NOT NULL,
	"definition_key" text NOT NULL,
	"name" text NOT NULL,
	"protocol" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"implementation" text NOT NULL,
	"settings" jsonb NOT NULL,
	"proxy" jsonb,
	"priority" integer DEFAULT 25 NOT NULL,
	"status" text DEFAULT 'disabled' NOT NULL,
	"last_error" text,
	"last_sync_at" text,
	"capabilities" jsonb,
	"session_state" text,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexer_definition" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"protocol" text NOT NULL,
	"implementation" text NOT NULL,
	"built_in" boolean DEFAULT true NOT NULL,
	"capabilities" jsonb DEFAULT '[]' NOT NULL,
	"category_ids" jsonb DEFAULT '[]' NOT NULL,
	"cardigann_yml" text,
	"created_at" text NOT NULL,
	CONSTRAINT "indexer_definition_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "job_definition" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"schedule" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"timeout_ms" integer DEFAULT 60000 NOT NULL,
	"max_retries" integer DEFAULT 2 NOT NULL,
	"retry_backoff_ms" integer DEFAULT 5000 NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"concurrency_limit" integer DEFAULT 1 NOT NULL,
	"last_executed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "job_definition_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "job_run" (
	"id" text PRIMARY KEY NOT NULL,
	"job_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'scheduled' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"message" text,
	"error" text,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"result" jsonb,
	"correlation_id" text,
	"due_at" text,
	"started_at" text,
	"finished_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_availability" (
	"id" text PRIMARY KEY NOT NULL,
	"media_type" text NOT NULL,
	"media_id" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"plex_id" text,
	"jellyfin_id" text,
	"tmdb_rating" integer,
	"tmdb_vote_count" integer,
	"last_availability_sync_at" text
);
--> statement-breakpoint
CREATE TABLE "media_file" (
	"id" text PRIMARY KEY NOT NULL,
	"media_type" text NOT NULL,
	"media_id" text NOT NULL,
	"episode_ids" jsonb DEFAULT '[]' NOT NULL,
	"relative_path" text NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"quality" jsonb DEFAULT '[]' NOT NULL,
	"media_info" jsonb DEFAULT '[]' NOT NULL,
	"languages" jsonb DEFAULT '[]' NOT NULL,
	"date_added" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_server" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"implementation" text NOT NULL,
	"kind" text DEFAULT 'media' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"settings" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "movie" (
	"id" text PRIMARY KEY NOT NULL,
	"tmdb_id" integer,
	"imdb_id" text,
	"title" text NOT NULL,
	"original_title" text,
	"overview" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"release_date" text,
	"monitored" boolean DEFAULT true NOT NULL,
	"quality_profile_id" text,
	"root_folder_path" text DEFAULT '' NOT NULL,
	"minimum_availability" text DEFAULT 'announced' NOT NULL,
	"genres" jsonb DEFAULT '[]' NOT NULL,
	"images" jsonb DEFAULT '[]' NOT NULL,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"has_file" boolean DEFAULT false NOT NULL,
	"added_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"event_types" jsonb DEFAULT '[]' NOT NULL,
	"settings" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_status" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_type" text NOT NULL,
	"provider_id" text NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"escalation_level" integer DEFAULT 0 NOT NULL,
	"disabled_until" text,
	"auto_disabled" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"last_failure_at" text,
	"last_success_at" text,
	"rate_limit" jsonb DEFAULT '[]' NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_definition" (
	"id" integer PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"min_size" integer,
	"max_size" integer,
	"preferred_size" integer,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_profile" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"items" jsonb DEFAULT '[]' NOT NULL,
	"cutoff_quality_id" integer DEFAULT 0 NOT NULL,
	"upgrade_allowed" boolean DEFAULT true NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"format_scores" jsonb DEFAULT '{}' NOT NULL,
	"min_format_score" integer DEFAULT 0 NOT NULL,
	"cutoff_format_score" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "quality_profile_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "remote_path_mapping" (
	"id" text PRIMARY KEY NOT NULL,
	"download_client_id" text NOT NULL,
	"remote_path" text NOT NULL,
	"local_path" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "root_folder" (
	"id" text PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "season" (
	"id" text PRIMARY KEY NOT NULL,
	"series_id" text NOT NULL,
	"season_number" integer NOT NULL,
	"monitored" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seen_release" (
	"id" text PRIMARY KEY NOT NULL,
	"indexer_id" text NOT NULL,
	"guid" text NOT NULL,
	"first_seen_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "series" (
	"id" text PRIMARY KEY NOT NULL,
	"tvdb_id" integer,
	"tmdb_id" integer,
	"imdb_id" text,
	"title" text NOT NULL,
	"overview" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"series_type" text DEFAULT 'standard' NOT NULL,
	"network" text,
	"first_air_year" integer,
	"monitored" boolean DEFAULT true NOT NULL,
	"quality_profile_id" text,
	"root_folder_path" text DEFAULT '' NOT NULL,
	"genres" jsonb DEFAULT '[]' NOT NULL,
	"images" jsonb DEFAULT '[]' NOT NULL,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"alternate_titles" jsonb DEFAULT '[]' NOT NULL,
	"added_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"color" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "download_queue_entry" ADD CONSTRAINT "download_queue_entry_download_client_id_download_client_id_fk" FOREIGN KEY ("download_client_id") REFERENCES "public"."download_client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode" ADD CONSTRAINT "episode_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode" ADD CONSTRAINT "episode_season_id_season_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."season"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movie" ADD CONSTRAINT "movie_quality_profile_id_quality_profile_id_fk" FOREIGN KEY ("quality_profile_id") REFERENCES "public"."quality_profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_path_mapping" ADD CONSTRAINT "remote_path_mapping_download_client_id_download_client_id_fk" FOREIGN KEY ("download_client_id") REFERENCES "public"."download_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season" ADD CONSTRAINT "season_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seen_release" ADD CONSTRAINT "seen_release_indexer_id_indexer_id_fk" FOREIGN KEY ("indexer_id") REFERENCES "public"."indexer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_quality_profile_id_quality_profile_id_fk" FOREIGN KEY ("quality_profile_id") REFERENCES "public"."quality_profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_hash_idx" ON "api_key" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "queue_media_idx" ON "download_queue_entry" USING btree ("media_type","media_id");--> statement-breakpoint
CREATE INDEX "episode_series_idx" ON "episode" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "episode_season_idx" ON "episode" USING btree ("season_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_outbox_id_idx" ON "event_outbox" USING btree ("id");--> statement-breakpoint
CREATE INDEX "event_outbox_occurred_idx" ON "event_outbox" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "health_check_result_key_idx" ON "health_check_result" USING btree ("key");--> statement-breakpoint
CREATE INDEX "history_media_idx" ON "history_entry" USING btree ("media_type","media_id");--> statement-breakpoint
CREATE INDEX "history_created_idx" ON "history_entry" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_exclusion_media_ext_idx" ON "import_exclusion" USING btree ("media_type","external_id");--> statement-breakpoint
CREATE INDEX "jobrun_key_idx" ON "job_run" USING btree ("job_key");--> statement-breakpoint
CREATE INDEX "jobrun_status_idx" ON "job_run" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobrun_created_idx" ON "job_run" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "availability_media_idx" ON "media_availability" USING btree ("media_type","media_id");--> statement-breakpoint
CREATE INDEX "media_file_media_idx" ON "media_file" USING btree ("media_type","media_id");--> statement-breakpoint
CREATE UNIQUE INDEX "movie_tmdb_idx" ON "movie" USING btree ("tmdb_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_status_type_id_idx" ON "provider_status" USING btree ("provider_type","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "remote_path_mapping_client_remote_idx" ON "remote_path_mapping" USING btree ("download_client_id","remote_path");--> statement-breakpoint
CREATE INDEX "remote_path_mapping_client_idx" ON "remote_path_mapping" USING btree ("download_client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "root_folder_path_idx" ON "root_folder" USING btree ("path");--> statement-breakpoint
CREATE UNIQUE INDEX "season_series_num_idx" ON "season" USING btree ("series_id","season_number");--> statement-breakpoint
CREATE INDEX "season_series_idx" ON "season" USING btree ("series_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seen_release_indexer_guid_idx" ON "seen_release" USING btree ("indexer_id","guid");--> statement-breakpoint
CREATE INDEX "seen_release_first_seen_idx" ON "seen_release" USING btree ("first_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "series_tvdb_idx" ON "series" USING btree ("tvdb_id");--> statement-breakpoint
CREATE UNIQUE INDEX "series_tmdb_idx" ON "series" USING btree ("tmdb_id");