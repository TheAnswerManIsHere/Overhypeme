-- Add ai_meme_backfill_status to facts so the durable `fact_ai_meme_backfill`
-- queue can surface its lifecycle per-fact ("pending" | "processing" | "ok" |
-- "failed" | "skipped"), mirroring pexels_status. Nullable: legacy facts (and
-- live-fact generation via memes.ts/pulidJobs.ts, which don't use this queue)
-- never ran AI-meme generation through it.

ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "ai_meme_backfill_status" varchar(16);
