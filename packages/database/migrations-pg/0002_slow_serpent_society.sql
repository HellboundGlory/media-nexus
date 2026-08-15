ALTER TABLE "episode" ADD COLUMN "media_file_id" text;--> statement-breakpoint
ALTER TABLE "episode" ADD CONSTRAINT "episode_media_file_id_media_file_id_fk" FOREIGN KEY ("media_file_id") REFERENCES "public"."media_file"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "episode_media_file_idx" ON "episode" USING btree ("media_file_id");