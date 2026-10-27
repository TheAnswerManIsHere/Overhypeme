-- Launch Phase 3, increment 3 (#770; plan docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md
-- §3, the config diff).
--
-- The NSFW classifier reads `nsfw_classifier_fail_open` with a code default of
-- "false" (lib/moderation/nsfwClassifier.ts: fail closed), but nothing ever
-- created its row: dev has one only because it was inserted by hand. Without
-- the row a database built from code still fails closed, but the admin config
-- page cannot show or change the setting, because PATCH /admin/config/:key
-- updates an existing row and answers 404 for a missing one. The config diff
-- found it: the one code-owned row dev holds that code does not produce.
--
-- Seeds it with the code default. ON CONFLICT DO NOTHING: a database that
-- already holds the row keeps its value (dev keeps its hand-set "true").
INSERT INTO admin_config (key, value, data_type, label, description, is_public)
VALUES (
  'nsfw_classifier_fail_open',
  'false',
  'boolean',
  'NSFW Classifier Fail-Open',
  'If true, NSFW classifier timeouts/errors allow uploads through instead of returning 503. Set false to fail closed (default).',
  false
)
ON CONFLICT (key) DO NOTHING;
