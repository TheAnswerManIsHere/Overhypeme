-- Phase 6: share_intents log + admin_config seeds for share-copy templates.
--
-- The share modal on the meme detail page fires a row into share_intents
-- every time a user clicks one of its buttons. This is *intent*, not a
-- confirmed share — the actual share happens off-platform (OS share sheet,
-- Twitter/X composer, mail client, clipboard) where we cannot observe it.
-- A `web_share` row still tells us the native flow was invoked; that is
-- the dominant share path on mobile.
--
-- Insert-only; no soft-delete. Cascade on user/meme deletion. Retention is
-- indefinite — rows are small (4 ints + a short string + a timestamp) and
-- high-value for platform-distribution analytics.
--
-- The seed rows at the bottom register the six share-copy templates in
-- admin_config so they can be edited without a redeploy. Supported template
-- variables: {name}, {fact_text}, {permalink}.

CREATE TABLE IF NOT EXISTS "share_intents" (
  "id"         serial PRIMARY KEY NOT NULL,
  "meme_id"    integer NOT NULL REFERENCES "memes"("id") ON DELETE CASCADE,
  "user_id"    varchar NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "platform"   varchar(20) NOT NULL CHECK ("platform" IN ('twitter','web_share','copy_link','email')),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_share_intents_meme_created"
  ON "share_intents" ("meme_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_share_intents_user_platform_created"
  ON "share_intents" ("user_id", "platform", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_share_intents_platform_created"
  ON "share_intents" ("platform", "created_at");
--> statement-breakpoint

-- Seed share-copy templates. Idempotent — re-running the migration will not
-- overwrite values an admin has edited.

INSERT INTO "admin_config" ("key", "value", "data_type", "label", "description")
VALUES
  (
    'share_copy_twitter_template',
    '{fact_text}',
    'text',
    'Share copy — Twitter/X body',
    'Tweet body for the Twitter/X share button. The permalink is appended automatically by the share-intent URL; do not include it in this template. Variables: {name}, {fact_text}, {permalink}.'
  ),
  (
    'share_copy_twitter_hashtags',
    'overhype,legendsaremadeup',
    'text',
    'Share copy — Twitter/X hashtags',
    'Comma-separated hashtags (no # prefix). Passed to the Twitter/X intent URL as &hashtags=…'
  ),
  (
    'share_copy_email_subject_template',
    'A meme of {name} on overhype.me',
    'text',
    'Share copy — Email subject',
    'mailto: subject line for desktop browsers without Web Share API. Variables: {name}, {fact_text}, {permalink}.'
  ),
  (
    'share_copy_email_body_template',
    E'{name} thought you''d appreciate this:\n\n"{fact_text}"\n\nSee it: {permalink}\n\n— Sent from overhype.me, where legends are made up.',
    'text',
    'Share copy — Email body',
    'mailto: body for desktop browsers without Web Share API. Plain text (mailto: does not support HTML). Variables: {name}, {fact_text}, {permalink}.'
  ),
  (
    'share_copy_web_share_title_template',
    '{name} on overhype.me',
    'text',
    'Share copy — Web Share title',
    'Title passed to navigator.share() — shown as the headline in the OS share sheet. Variables: {name}, {fact_text}, {permalink}.'
  ),
  (
    'share_copy_web_share_text_template',
    '{fact_text}',
    'text',
    'Share copy — Web Share text',
    'Body passed to navigator.share() — shown beneath the title in the OS share sheet. Variables: {name}, {fact_text}, {permalink}.'
  )
ON CONFLICT ("key") DO NOTHING;
