# The legacy fixture

A scrubbed copy of the shapes in the Repl's dev database, so tests can run the
current code against rows older code wrote (Launch Phase 2, increment 5, #631;
plan `docs/plans/PLAN_PHASE2_INC5_LEGACY_FIXTURE.md`). How to load it and how
to refresh it: `docs/tests/TESTING.md`, *The legacy fixture*.

## What it is

- Extracted at source commit `efe0732ffe0ba54a7061486a94f77a9506884b04`, whose journal holds 102 migrations (latest `0101_user_generation_costs_is_estimated`), all applied on the source; scrub ruleset version 2.
- `manifest.json` sha256 `864bfcf551fedd009feb84c951e2e5ba0a9aaa962336cb8dde85ea3c40f3b882`. A recording made over this fixture names that digest.
- 1243 rows in 28 tables, one NDJSON file per table.

| Table | Rows |
|---|---|
| `feature_flags` | 11 |
| `tier_feature_permissions` | 42 |
| `entitlement_grid_revision` | 1 |
| `engines` | 19 |
| `look_styles` | 19 |
| `motion_presets` | 8 |
| `hero_examples` | 0 |
| `fal_pricing_cache` | 18 |
| `users` | 26 |
| `admin_config` | 72 |
| `facts` | 53 |
| `hashtags` | 45 |
| `fact_hashtags` | 132 |
| `pending_reviews` | 102 |
| `fact_enrichment_versions` | 64 |
| `enrichment_override_history` | 206 |
| `fact_text_edit_history` | 0 |
| `image_prompt_attempts` | 110 |
| `memes` | 65 |
| `upload_image_metadata` | 45 |
| `user_ai_images` | 111 |
| `comments` | 9 |
| `ratings` | 10 |
| `reactions` | 19 |
| `external_links` | 0 |
| `membership_entitlements` | 1 |
| `membership_history` | 13 |
| `user_generation_costs` | 42 |

## What was kept, and what was replaced

- **Fact text.** The live text of every active fact is kept (44 texts). Rejected, pending and reported facts carry grammar-valid placeholder templates (9 texts) with the corpus's hashtags.
- **People.** Every user is synthetic: name, email (`fixture-user-<n>@example.test`), avatar and Stripe customer. Every reference to a user follows the same mapping, so ownership and authorship are preserved.
- **Prose.** Notes, scenes, captions, prompts and other free text become content-keyed placeholders, `[fixture text <h>]`. Equal source strings stay equal, so every comparison the readers make answers as on the source. Blank stays blank, and a value a validator refused stays refused.
- **Media.** Every image is a local placeholder written through the storage double at load, at the path and with the ACL its producing writer would have set. Stock and third-party photos become a small inline image.
- **Never exported.** Sessions and auth state, unfinished jobs, child-safety records, credentials, IP data, and live-mode or unverifiable payment rows.
  Payment rows excluded by the test-mode check: membership_entitlements 0, membership_history 0.

## What the readers see

The freshness outcomes of stored renders, concepts and candidates were recorded on the source with the real readers. The loader restores them and re-asks the readers, and refuses to finish if any answer differs.

- Render attempts: stale 77, no-context 12, current 11.
- Candidate text hashes: current 63, stale 1.
- Concept blobs: stale:review_mismatch 30, stale:input_hash_mismatch 40, current 8.
- Facts the embedding backfill would pick up: 0.

The export stopped on any value no rule covered and on any credential-shaped string. It finished this extraction with zero stops.
