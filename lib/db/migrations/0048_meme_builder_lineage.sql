-- Phase 3: meme builder lineage
--
-- Adds analytics + dedup support for the new meme builder:
--   - memes.image_transform           : analytics flag for AI-stylized vs raw-photo memes
--   - upload_image_metadata.transform : marks a row as a PuLID derivative (or fallback)
--   - upload_image_metadata.source_object_path / fact_id / transform_params_hash :
--       lineage so the picker can show "AI stylings for this fact" and so the AI
--       generate path can dedupe against an existing styling for the same
--       (user, fact, source photo, params hash) tuple.
--
-- All columns are nullable; existing rows are unaffected.

ALTER TABLE "memes" ADD COLUMN "image_transform" varchar(24);--> statement-breakpoint

ALTER TABLE "upload_image_metadata" ADD COLUMN "transform" varchar(24);--> statement-breakpoint
ALTER TABLE "upload_image_metadata" ADD COLUMN "source_object_path" text;--> statement-breakpoint
ALTER TABLE "upload_image_metadata" ADD COLUMN "fact_id" integer;--> statement-breakpoint
ALTER TABLE "upload_image_metadata" ADD COLUMN "transform_params_hash" varchar(64);--> statement-breakpoint

-- The source upload is referenced in transit; if the source row is later hard-deleted
-- we keep the derivative around (set null) since the derivative bytes are still valid.
ALTER TABLE "upload_image_metadata"
  ADD CONSTRAINT "uim_source_object_path_fk"
  FOREIGN KEY ("source_object_path")
  REFERENCES "public"."upload_image_metadata"("object_path")
  ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint

ALTER TABLE "upload_image_metadata"
  ADD CONSTRAINT "uim_fact_id_fk"
  FOREIGN KEY ("fact_id")
  REFERENCES "public"."facts"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint

-- Picker query: "AI stylings for this fact owned by me".
CREATE INDEX "IDX_uim_user_transform_fact" ON "upload_image_metadata"
  USING btree ("user_id","transform","fact_id");--> statement-breakpoint

-- Dedup query: "have I already PuLID'd this (user, fact, source, params)?"
CREATE INDEX "IDX_uim_pulid_dedup" ON "upload_image_metadata"
  USING btree ("user_id","fact_id","source_object_path","transform_params_hash")
  WHERE "transform" = 'pulid';--> statement-breakpoint

-- Constrain the new enum-ish columns. Drizzle does not emit CHECKs.
ALTER TABLE "memes"
  ADD CONSTRAINT "memes_image_transform_chk"
  CHECK ("image_transform" IS NULL OR "image_transform" IN ('pulid','pulid_fallback_text'));--> statement-breakpoint

ALTER TABLE "upload_image_metadata"
  ADD CONSTRAINT "uim_transform_chk"
  CHECK ("transform" IS NULL OR "transform" IN ('pulid','pulid_fallback_text'));
