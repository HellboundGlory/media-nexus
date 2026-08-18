CREATE TABLE "collection" (
	"id" text PRIMARY KEY NOT NULL,
	"tmdb_id" integer NOT NULL,
	"name" text NOT NULL,
	"overview" text,
	"images" jsonb DEFAULT '[]' NOT NULL,
	"monitored" boolean DEFAULT false NOT NULL,
	"quality_profile_id" text,
	"root_folder_path" text DEFAULT '' NOT NULL,
	"minimum_availability" text DEFAULT 'released' NOT NULL,
	"search_on_add" boolean DEFAULT false NOT NULL,
	"parts" jsonb DEFAULT '[]' NOT NULL,
	"last_sync_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collection" ADD CONSTRAINT "collection_quality_profile_id_quality_profile_id_fk" FOREIGN KEY ("quality_profile_id") REFERENCES "public"."quality_profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_tmdb_idx" ON "collection" USING btree ("tmdb_id");