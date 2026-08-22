ALTER TABLE "media_file" ADD COLUMN "indexer_flags" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_file" ADD COLUMN "release_type" text;