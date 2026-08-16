ALTER TABLE "movie" ADD COLUMN "certification" text;--> statement-breakpoint
ALTER TABLE "movie" ADD COLUMN "runtime" integer;--> statement-breakpoint
ALTER TABLE "movie" ADD COLUMN "studio" text;--> statement-breakpoint
ALTER TABLE "movie" ADD COLUMN "in_cinemas" text;--> statement-breakpoint
ALTER TABLE "movie" ADD COLUMN "digital_release" text;--> statement-breakpoint
ALTER TABLE "movie" ADD COLUMN "physical_release" text;--> statement-breakpoint
ALTER TABLE "movie" ADD COLUMN "trailer_id" text;--> statement-breakpoint
ALTER TABLE "movie" ADD COLUMN "tmdb_rating" real;--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "certification" text;--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "runtime" integer;--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "trailer_id" text;--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "tmdb_rating" real;