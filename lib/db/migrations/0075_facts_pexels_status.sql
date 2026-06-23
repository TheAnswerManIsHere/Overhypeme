-- Add pexels_status to facts so the durable `fact_pexels` image-prep queue can
-- surface its lifecycle per-fact ("pending" | "ok" | "failed"), mirroring
-- enrichment_status. Nullable: legacy facts (and live-fact edits that
-- fire-and-forget via runFactImagePipeline) never ran prep through the queue.
-- "failed" is set only after the queue exhausts its retries, so it stays
-- distinct from a job that is still running (which remains "pending").

ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "pexels_status" varchar(16);
