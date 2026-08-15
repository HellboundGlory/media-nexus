CREATE TABLE "auto_tag" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"remove_tags_automatically" boolean DEFAULT false NOT NULL,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"specifications" jsonb DEFAULT '[]' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
