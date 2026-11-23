# The legacy fixture

A scrubbed copy of the shapes in the Repl's dev database, so tests can run the
current code against rows older code wrote (Launch Phase 2, increment 5, #631;
plan `docs/plans/PLAN_PHASE2_INC5_LEGACY_FIXTURE.md`). How to load it and how
to refresh it: `docs/tests/TESTING.md`, *The legacy fixture*.

## What it is

- Extracted at source commit `efe0732ffe0ba54a7061486a94f77a9506884b04`, whose journal holds 102 migrations (latest `0101_user_generation_costs_is_estimated`), all applied on the source; scrub ruleset version 2.
- `manifest.json` sha256 `40dd6915a4a01cc466af2014db7d77827122aa33f7c21c53ed84487e2256f61b`. A recording made over this fixture names that digest. (Edited by hand at increment 2.1c of the fact lifecycle rebuild, Issue #1018: the tables and columns migration 0160 dropped were removed from the fixture, its manifest and the `engine_revision` setting; nothing else was re-extracted. Edited by hand again for migration 0162, Issue #849: the users' `avatar_style` and `avatar_source` columns and the `custom_avatar` feature-flag and tier rows were removed.)
- 1146 rows in 28 tables, one NDJSON file per table.

| Table | Rows |
|---|---|
| `feature_flags` | 7 |
| `tier_feature_permissions` | 26 |
| `entitlement_grid_revision` | 1 |
| `look_styles` | 19 |
| `motion_presets` | 8 |
| `hero_examples` | 0 |
| `fal_pricing_cache` | 9 |
| `users` | 26 |
| `admin_config` | 46 |
| `facts` | 49 |
| `hashtags` | 45 |
| `fact_hashtags` | 115 |
| `pending_reviews` | 89 |
| `fact_text_edit_history` | 0 |
| `image_prompt_attempts` | 104 |
| `memes` | 64 |
| `upload_image_metadata` | 45 |
| `user_ai_images` | 111 |
| `comments` | 9 |
| `ratings` | 10 |
| `reactions` | 18 |
| `external_links` | 0 |
| `membership_entitlements` | 1 |
| `membership_history` | 13 |
| `user_generation_costs` | 42 |

## What was kept, and what was replaced

- **Fact text.** The live text of every active fact is kept (40 texts). Rejected, pending and reported facts carry grammar-valid placeholder templates (9 texts) with the corpus's hashtags.
- **People.** Every user is synthetic: name, email (`fixture-user-<n>@example.test`), avatar and Stripe customer. Every reference to a user follows the same mapping, so ownership and authorship are preserved.
- **Prose.** Notes, scenes, captions, prompts and other free text become content-keyed placeholders, `[fixture text <h>]`. Equal source strings stay equal, so every comparison the readers make answers as on the source. Blank stays blank, and a value a validator refused stays refused.
- **Media.** Every image is a local placeholder written through the storage double at load, at the path and with the ACL its producing writer would have set. Stock and third-party photos become a small inline image.
- **Never exported.** Sessions and auth state, unfinished jobs, child-safety records, credentials, IP data, and live-mode or unverifiable payment rows.
  Payment rows excluded by the test-mode check: membership_entitlements 0, membership_history 0.

## What the readers see

The freshness outcomes of stored renders and concepts were recorded on the source with the real readers. The loader restores them and re-asks the readers, and refuses to finish if any answer differs.

- Render attempts: stale 65, no-context 21, current 11.
- Concept blobs: stale:review_mismatch 21, stale:input_hash_mismatch 38, current 6.
- Facts the embedding backfill would pick up: 0.

The export stopped on any value no rule covered and on any credential-shaped string. It finished this extraction with zero stops.
