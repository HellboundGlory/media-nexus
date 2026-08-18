ALTER TABLE "root_folder" ADD COLUMN "is_default_movie" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "root_folder" ADD COLUMN "is_default_series" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "root_folder" SET "is_default_movie" = true, "is_default_series" = true WHERE "is_default" = true;--> statement-breakpoint
ALTER TABLE "root_folder" DROP COLUMN "is_default";