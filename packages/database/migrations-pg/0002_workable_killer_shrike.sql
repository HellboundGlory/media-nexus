CREATE TABLE "media_credit" (
	"id" text PRIMARY KEY NOT NULL,
	"media_type" text NOT NULL,
	"media_id" text NOT NULL,
	"role" text NOT NULL,
	"person_name" text NOT NULL,
	"character" text,
	"job" text,
	"department" text,
	"sort_order" integer,
	"profile_url" text
);
--> statement-breakpoint
CREATE INDEX "media_credit_media_idx" ON "media_credit" USING btree ("media_type","media_id");