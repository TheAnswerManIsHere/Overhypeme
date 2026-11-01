-- Launch Phase 5, increment 4b (plan docs/plans/PLAN_PHASE5_ACCOUNT_IDENTITY.md,
-- "The purge job"; David's answer 1, 2026-10-30).
--
-- Everything in My content stays restorable for a window after its owner
-- deletes it; the content purger destroys it after. The window is
-- `content.restore_window_days`, read with a code default of 30
-- (lib/contentVisibility.ts). Seeding the row lets the admin config page show
-- and change it: PATCH /admin/config/:key answers 404 for a missing row (the
-- reason 0113 seeded its row).
--
-- ON CONFLICT DO NOTHING: a database that already holds the row keeps its value.
INSERT INTO admin_config (key, value, data_type, label, description, min_value, max_value, is_public)
VALUES (
  'content.restore_window_days',
  '30',
  'integer',
  'My content: restore window (days)',
  'How many days a photo, generated image or meme a member deleted stays in Recently deleted, restorable, before the content purger removes it from Overhype.me. Changing it applies to deletions made after the change. Default: 30.',
  1,
  365,
  false
)
ON CONFLICT (key) DO NOTHING;

-- The storage byte path asks, for every object it serves, whether a deleted
-- generated image names it (lib/objectAccess.ts, objectIsWithdrawn), and the
-- content purger asks whether another row still names an image before it
-- destroys it. Both look rows up by storage_path, which had no index.
CREATE INDEX IF NOT EXISTS "IDX_uai_storage_path" ON user_ai_images (storage_path);
