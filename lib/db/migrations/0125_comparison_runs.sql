-- Launch Phase 8, increment 2b: what a comparison run writes as it spends.
-- Expand only: new nullable columns on tables increment 2a created, which
-- hold no production rows yet.
--
-- comparison_panels.reference_image_url: the resized default reference a
--   panel's edit cells all receive, frozen at preparation.
-- comparison_cells.fal_request_id: the one submission a cell's attempt made,
--   stored before polling so a resumed job polls and never resubmits.
-- comparison_cells.vendor_result_url: the vendor's image URL, kept so a
--   storage failure is retried without buying a second image.
-- comparison_cells.image_object_path: where the rendered image is stored.
-- comparison_cells.request_settings: the endpoint settings the cell sent.
ALTER TABLE "comparison_panels" ADD COLUMN IF NOT EXISTS "reference_image_url" text;--> statement-breakpoint
ALTER TABLE "comparison_cells" ADD COLUMN IF NOT EXISTS "fal_request_id" varchar(128);--> statement-breakpoint
ALTER TABLE "comparison_cells" ADD COLUMN IF NOT EXISTS "vendor_result_url" text;--> statement-breakpoint
ALTER TABLE "comparison_cells" ADD COLUMN IF NOT EXISTS "image_object_path" text;--> statement-breakpoint
ALTER TABLE "comparison_cells" ADD COLUMN IF NOT EXISTS "request_settings" jsonb;
