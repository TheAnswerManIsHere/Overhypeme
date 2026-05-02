-- Add a free-form `source` column to affiliate_clicks so we can attribute
-- click-throughs by the page/context the user clicked from
-- (e.g. "meme-page", "wear-page", "fact-detail"). The existing
-- (source_type, source_id) columns describe *what* the click is about
-- (a fact or a meme); `source` describes *where* in the product the
-- user clicked from. Nullable so historical rows stay valid.
ALTER TABLE "affiliate_clicks"
  ADD COLUMN IF NOT EXISTS "source" varchar(64);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "affiliate_clicks_source_idx"
  ON "affiliate_clicks" ("source");
