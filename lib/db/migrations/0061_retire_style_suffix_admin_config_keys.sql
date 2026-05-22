-- Admin-panel cleanup: retire the `style_suffix_*` and `style_suffix_ref_*`
-- admin_config keys.
--
-- These keys held the visual-style prompt suffixes appended to AI image
-- generation prompts. The same data now lives on the `look_styles` DB
-- table (look_styles.promptSuffix + promptSuffixReference) and is seeded
-- by migration 0057_mbfo4_seed_engines_and_look_styles. After Phase 6 +
-- the admin-panel cleanup, no runtime code reads the admin_config rows,
-- and the admin UI no longer exposes them — so the rows are pure dead
-- weight.
--
-- Pure DML — no schema delta. Listed in SNAPSHOT_EXEMPT_TAGS.

DELETE FROM admin_config
WHERE key LIKE 'style_suffix_%';
