# PLAN — Phase 2 increment 5: the legacy fixture scrub · technical design · v5 (for David's approval; scope exchange and rounds 1–3 with Astra incorporated)

Parent: `docs/plans/PLAN_PHASE2_VERIFICATION.md` v4 (sha256 `db036f0f…`,
approved by David 2026-10-08 / 2026-10-11), *Settled Decisions*, increment 5:
"The scrub design first (David's privacy call), then the fixture and a
loader." This document is that scrub design. Nothing here changes scope;
anything that would is marked **for David**.

```plan-oracle
# Oracle — Phase 2 increment 5: the legacy fixture scrub

Status: the scope below is the approved parent plan's increment 5
(`docs/plans/PLAN_PHASE2_VERIFICATION.md` v4, sha256
db036f0fbe7b86812a8b83dbe85f694f144c1f5dc5786c522cd188d4b0461ae1, approved by
David 2026-10-08 / 2026-10-11), quoted, plus David's answers of 2026-10-08
and the settled list he gave when starting this increment on 2026-10-13.
Nothing here is new scope. This sub-plan is the "scrub design" the parent
reserves for this increment; the fixture is extracted only after David
approves it.

## Direction (parent, quoted)

"`launch-definition.md`, *Verification is a prerequisite*: every later phase
ships with its mechanical checks scripted, and David's share of a UAT is the
human residue. Phase 2 delivers reusable verification infrastructure and
proves it through a named baseline of journeys that exist today."

## Product intent for this increment (parent, quoted)

Product Intent 4: "A legacy fixture lets those runs execute against the row
shapes the real catalogue has, not only against a freshly created database."

Settled Decisions, increment 5: "**Legacy fixture.** The scrub design first
(David's privacy call), then the fixture and a loader."

## What is fixed whatever David chooses (parent, quoted)

"the export is an **allowlist** — only named tables and columns leave the
source, so an excluded class (sessions and auth state, non-terminal jobs,
child-safety records, live-mode payment obligations) never enters even an
intermediate file; personal identities, credentials, emails, IP data and
Stripe identifiers become synthetic; uploaded and generated media become
synthetic local placeholders so every media reference in the fixture resolves
locally; relationships and structural variation (old enrichment versions,
waivers, stale renders, partial states) are preserved. The fixture is
extracted only after the scrub is approved."

Security section: "The fixture is published in a public repository: whatever
it contains is public. Its scrub is designed and approved before any row is
extracted."

## Must not change (parent, the items this increment can touch)

- "**The child-safety boundary.** No quarantined evidence, NCMEC report or
  safety-ledger row enters a fixture, a log, a test artefact or the
  repository."
- "**The four excluded row classes** of the 2026-08-28 decision never enter
  the fixture."
- "**No real external effect from a test**" and "**No credential in CI**, in
  any form, for any vendor."
- "Existing tests keep passing unmodified."
- "Data Model and Migration Impact: None planned. … any increment that finds
  it needs a product-schema change stops and comes back."

## Settled by David — do not re-open

- **Option 1 (2026-10-08):** the fixture keeps shapes only, is committed, and
  keeps the approved live fact text. Rejected, pending and reported facts get
  placeholder text. (`decisions.md`, 2026-10-08: "every identity, credential,
  Stripe id and image becomes synthetic; rejected, pending and reported facts
  get placeholder text; the 2026-08-28 excluded row classes never leave the
  source.")
- **Pre-launch, the disclosure check is not applied to security details.**
  Secrets and private customer data are still never public.
- **The recording spend ceiling is David's $20, with $2.94 used.** A later
  re-record draws on what remains.
- **The utility model is gpt-6-luna (#666).**
- Out of scope: increment 6 (the acceptance workflow, the image-content
  check), #651, #668, the Stripe fake (#566), handbook or contract changes,
  anything in increment 4.

## Ceremony

Internal tier (the parent: "Tier: internal, except the Stripe stub"). Feature
mode, production phase, standard review loop. The fixture is public the moment
it is pushed, so the scrub is the security boundary and the plan treats it as
one.
```

## What increment 5 must deliver (from the parent, quoted)

- Product Intent 4: "A legacy fixture lets those runs execute against the row
  shapes the real catalogue has, not only against a freshly created database."
- The fixed part of the design: "the export is an **allowlist** — only named
  tables and columns leave the source … personal identities, credentials,
  emails, IP data and Stripe identifiers become synthetic; uploaded and
  generated media become synthetic local placeholders so every media reference
  in the fixture resolves locally; relationships and structural variation (old
  enrichment versions, waivers, stale renders, partial states) are preserved."
- David's privacy call, option 1: "Shapes only, committed; approved live fact
  text kept (rejected, pending and reported facts get placeholder text). CI
  runs against it."
- The excluded classes: "sessions and environment-bound auth state;
  non-terminal async jobs; child-safety records; live-mode payment
  obligations" — "never copied anywhere" (`decisions.md`, 2026-08-28, which
  also says: "treat it as the set known today rather than a proof of
  completeness, and enumerate afresh against the current schema before any
  copy").

## The surface, measured (2026-10-13, read from source at `1186f19`)

**The schema.** `git grep -c "= pgTable(" lib/db/src/schema` sums to **59
tables** (an earlier count of 62 took comment and import hits; Astra round
1). Every one is classified in D2 below; the test in D9 refuses an
unclassified one. The source's `public` schema holds 58 relations
(`pg_tables`, read 2026-10-13): the 59 minus `conversations` and `messages`
(both excluded here, both absent in dev), plus a stray `video_styles`
relation no Drizzle table declares. The exporter never queries an excluded
table, so an absent excluded relation is nothing; an absent **included**
relation stops the run.

**The source database** (the Repl's development database, read through the
connector on 2026-10-13 with `count(*)` on `public.*`): `users` 26 (24 with
a password, 3 Google-linked, 1 admin, 4 with a Stripe customer id, 0 with a
non-UUID id), `facts` 53 (44 active; 49 with Pexels images, 40 with AI
images), `pending_reviews` 102 (the stage counts in #631: 13 + 41 + 10 + 21
+ 17), `fact_enrichment_versions` 64, `image_prompt_attempts` 106, `memes`
66, `upload_image_metadata` 45, `comments` 9, `reactions` 19,
`membership_entitlements` 1, `async_jobs` with a non-terminal status 0;
`engines` 19, `fal_pricing_cache` 18, `admin_config` 72,
`tier_feature_permissions` 42, `sessions` 8, `password_reset_tokens` 1,
`quarantined_memes` 0, `ncmec_reports` 0, `route_stat_events` 2473. The
`public` schema's tables total 12 MB. **Two findings from that read that the
design has to answer:**

1. **The database holds schemas other than `public`** — `pg_stat_user_tables`
   grouped by schema: `public` 58, `stripe` 29, `heliumdb_test` 47,
   `drizzle` 1, `drizzle_test` 1. The `stripe` schema is a Stripe data sync
   (`customers` 5, `charges` 14, `subscriptions` 11, `invoices` 12,
   `payment_methods` 7, `_managed_webhooks`, `_sync_status`), which
   `scripts/db-sync-prod.mjs` already excludes by name
   (`--exclude-schema=stripe --exclude-schema=_system`); a Stripe customer
   row is a payment identity with an email. `heliumdb_test` is a second copy
   of the app's tables living inside the development database under the
   test database's name, with its own `drizzle_test` ledger. None of it is
   in the Drizzle schema. **The allowlist is schema-qualified: every query
   the exporter runs names `public.<table>`, and only tables the allowlist
   includes are queried (D1).** Nothing in any other schema can enter.
2. **The Stripe sync schema is also the evidence for payment eligibility**
   (D2, C5): `information_schema.columns` shows `livemode` on
   `stripe.subscriptions`, `customers`, `invoices`, `payment_intents` and
   `disputes`; grouped by `livemode`, subscriptions are 11 × `false`,
   invoices 12 × `false`, payment intents 14 × `false`, customers 3 × `false`
   and 2 × null; and the one `membership_entitlements` row
   (`stripe_subscription`, `active`, with a `provider_ref`, not admin
   granted) joins to a subscription with `livemode = false`. All 13
   `membership_history` rows carry a Stripe id (`invoice_paid` 3,
   `lifetime_purchase` 1, `subscription_activated` 7,
   `subscription_cancelled` 2). The embedding backfill's own predicate
   (`is_active AND (embedding IS NULL OR canonical_text IS NULL)`) counts
   **0** on the source.

**The structural states the fixture exists to carry** (same read, `count(*)`
on `public.*`): 62 reviews carry a refresh-candidate pointer
(`candidate_version_id`), 84 reference a staging fact, 3 carry a visual
render approval waiver, 0 approved reviews point at an inactive fact;
`fact_enrichment_versions` by status: 42 `candidate`, 18 `rejected`, 2
`promoted`, 2 `superseded` (62 `refresh_candidate`, 2
`prior_active_snapshot` by source); 46 of 53 facts have a null
`last_processed_signature`, 6 carry non-empty overrides, 5 have no visual
concept status; 96 of 106 render attempts are review renders, 105 carry an
image, 0 carry an error; `enrichment_override_history` 206 rows,
`user_ai_images` 111, `user_generation_costs` 42, `membership_history` 13,
`hashtags` 47 / `fact_hashtags` 132, `ratings` 10; memes: 58 live public
images, 7 live private images, 1 live public video; 0 uploads with an
Arachnid match, 4 profile uploads; `fact_text_edit_history`,
`external_links` and `hero_examples` are empty; `engine_revision_bumps` 1.
What the counts say about the design: the variation David asked to keep is
real and mostly on **refresh cycles of active facts** (62 candidates, 96
review renders) and on **stale processing signatures** (46 of 53), so the
predicate-preserving rule in D4 is where the fixture's value lives; the
empty tables are classified anyway, because the classification is of the
schema, not of today's rows.

**Where the excluded classes live today** (the 2026-08-28 enumeration,
re-run against the current schema):

- *Sessions and environment-bound auth state:* `sessions` (`sid`, `sess`
  jsonb), `email_verification_tokens`, `password_reset_tokens`,
  `oauth_pending_states` (all `lib/db/src/schema/auth.ts`); plus the
  per-user credential columns `users.password_hash`, `users.pending_email`,
  `users.captcha_verified`, `users.email_verified_at`.
- *Non-terminal async jobs:* `async_jobs.status` (`asyncJobs.ts:26`,
  `pending` / `processing` executable). `video_jobs` is a second job table
  with its own lifecycle columns (`videoJobs.ts:77-83`), an `ip_address`
  column (`:59`) and an `authorization_snapshot` jsonb (`:75`).
- *Child-safety records:* `quarantined_memes`, `ncmec_reports`,
  `ncmec_safety_audit_log` (`moderation.ts`). Adjacent: `memes.status =
  'quarantined'` and `memes.quarantine_reason` (`memes.ts:43-45`), and the
  Arachnid result columns on `upload_image_metadata`
  (`arachnid_classification`, `arachnid_match_type`, `arachnid_sha1_base32`,
  `arachnid_sha256_hex`, `arachnid_scanned_at`; `memes.ts:94-104`).
- *Live-mode payment obligations:* `membership_entitlements.provider_ref`
  (`membershipEntitlements.ts:152`, the row `getMutationTarget()` starts
  from), `users.stripe_customer_id`, `membership_history.stripe_*_id`
  (`memberships.ts:20-23`), `stripe_processed_events`,
  `stripe_webhook_audit`, `stripe_checkout_request_ledger`,
  `entitlement_source_disputes`. The schema carries no live/test mode column
  on any of them (`git grep -n "livemode\|live_mode" lib/db/src/schema`:
  no hits).
- *IP data:* `video_jobs.ip_address`, `transient_renders.ip_hash`,
  `rate_limit_counters.key_raw` (`git grep -n "ipAddress\|ip_hash\|key_raw"
  lib/db/src/schema`: exactly these three), plus `request_metadata` jsonb on
  the two child-safety tables.
- *Identity text outside `users`:* `membership_entitlements.granted_by_admin_label`
  / `revoked_by_admin_label`, `ncmec_safety_audit_log.actor_label`,
  `image_prompt_attempts.eval_by` (varchar, `imagePromptAttempts.ts:108`),
  `comments.text`, `search_history.query`, `activity_feed.message`.

**Where fact content lives** (the text David's option 1 governs, and the
columns derived from it): `facts.text`, `facts.canonical_text`,
`pending_reviews.submitted_text`, `fact_text_edit_history.old_text` /
`new_text`; and the AI-derived jsonb: `facts.enrichment`,
`facts.enrichment_ai_derived`, `facts.enrichment_overrides`,
`facts.visual_concept_candidates`, `facts.ai_scene_prompts`,
`pending_reviews.enrichment`, `fact_enrichment_versions.enrichment` /
`enrichment_ai_derived` / `enrichment_overrides` / `visual_override`,
`enrichment_override_history.old_value` / `new_value`,
`image_prompt_attempts.fact_enrichment_snapshot` / `visual_plan` /
`compiled_prompt` / `rendered_fact_text` / `subject_fact_compatibility` /
`source_image_analysis` / `error` / `eval_notes`,
`pending_reviews.visual_render_approval_waiver`. Their schemas:
`factEnrichmentSchema` (`lib/api-zod/src/taxonomy.ts:575`, whose only
refinement is `enforceSubtypeBelongsToArchetype`),
`enrichmentOverridesSchema` (`enrichmentOverrides.ts:57`),
`visualConceptCandidatesBlobSchema` (`visualConcepts.ts:318`),
`imagePromptPlanWireSchema` (`imagePromptGeneration.ts:567`).

**Where media references live:** `users.profile_image_url`,
`memes.image_url`, `memes.video_object_path`, `memes.image_source` (the
`upload` variant's key and the `stock` variant's `photoUrl` /
`photographerName`, `validators/memeBuilder.ts:77-91`),
`upload_image_metadata.object_path` / `source_object_path`,
`user_ai_images.storage_path`,
`image_prompt_attempts.generated_image_object_path`,
`facts.ai_meme_images` (`{male, female, neutral}: string[]` of object paths,
`aiMemePipeline.ts:193`), `facts.pexels_images` (`FactPexelsImages`:
per-gender Pexels photos with their URLs and photographer attribution,
`factImagePipeline.ts:169`), `hero_examples.asset_url` / `poster_url`,
`look_styles.preview_image_path`, `motion_presets.preview_gif_path`. Private
objects are served at `/storage/objects/*` through the real access check and
public ones at `/storage/public-objects/*` (`routes/storage.ts:147,189`).
Keys follow `storageKeys.ts` (`<kind>/<hash2>/<filename>`).

**What a loaded fixture meets at boot:** the embedding backfill walks
`is_active = true AND (embedding IS NULL OR canonical_text IS NULL)`
(`embeddings.ts:104-106`); the fal pricing warm-up refreshes rows older than
an hour and `getCachedPrice` throws only when no row exists after a refresh
attempt (`falPricing.ts:135-166`); journey 3's duplicate check embeds the
submission and asks the utility model about the nearest neighbours above a
threshold (`routes/ai.ts:266-304`), so its requests depend on what the
catalogue holds.

**Migrations seed** `engines`, `look_styles`, `admin_config`,
`feature_flags`, `tier_feature_permissions`, `entitlement_grid_revision` and
`feature_permissions_migration_log` (`grep -l "INSERT INTO"
lib/db/migrations/*.sql`, 15 files); the two data-table inserts
(`0035_reactions_polymorphic.sql`, `0055_upload_image_metadata_is_profile.sql`)
copy from existing rows and insert nothing on an empty database.

## Design

### D1. The allowlist is a construct, and the exporter can only read what it names

`artifacts/api-server/scripts/legacyFixture/allowlist.ts` classifies **every
table in the Drizzle schema**, by Drizzle table object (so it is typed
against the real columns):

- `{ include: { columns: { <column>: <rule> } } }` — a column absent from the
  map is **not selected**; the `SELECT` is built from the map, so an
  unnamed column never leaves the source, not even into memory.
- `{ exclude: "<class>" }` — one of `auth-state`, `job-state`,
  `child-safety`, `payment-obligation`, `runtime-state`, `telemetry`,
  `not-catalogue`, `cut-feature`, each with a one-line reason.

The column rules: `keep` (copied as is), `map-user` (a user id, rewritten
through the identity map, D3), `map-id` (another remapped key), `synthetic`
(replaced by a generated value, per column), `null`, `fact-text` (D4),
`prose` (free text replaced by a content-keyed placeholder, D4),
`shape:<name>` (a jsonb column handed to the named transformer of D4's
table, which is written against that shape's own validator), `predicate-hash`
(D4), `media` (D5), `admin-label` (D3). **There is no generic jsonb rule**:
a jsonb column with no `shape:` transformer cannot be included (the
allowlist's type refuses it), so an unknown nested field never passes
unchanged (Astra LF1, round 1 C2).

**The exporter addresses `public.<table>` only**, and only for tables the
allowlist includes; it never runs `pg_dump`, never `SELECT *`, and never
reads a table it will not write. It opens one `READ ONLY` transaction
(`SET TRANSACTION READ ONLY`, which makes Postgres refuse any write for the
run's life — a construct, not a convention) at `REPEATABLE READ`, so the
fixture is one consistent snapshot.

The test in D9 enumerates the Drizzle schema and refuses an unclassified
table, which turns the 2026-08-28 instruction "enumerate afresh against the
current schema before any copy" into a CI guard: the next table anyone adds
has to be classified before the exporter will typecheck.

### D2. The classification

**Excluded whole** (never queried):

| Class | Tables | Why this class, in one line |
|---|---|---|
| `auth-state` | `sessions`, `email_verification_tokens`, `password_reset_tokens`, `oauth_pending_states` | a copied session or token is valid against whatever it is loaded into |
| `job-state` | `async_jobs`, `video_jobs`, `worker_lane_heartbeats`, `membership_leases` | the rule covers non-terminal rows; the whole table goes because job payloads carry recipient emails and results, no journey reads job history, and `video_jobs` carries IPs and authorisation snapshots for a cut feature |
| `child-safety` | `quarantined_memes`, `ncmec_reports`, `ncmec_safety_audit_log` | the boundary; both child-safety tables are empty in dev today (0 rows), and the design does not rely on that |
| `payment-obligation` | `stripe_processed_events`, `stripe_webhook_audit`, `stripe_checkout_request_ledger`, `entitlement_source_disputes` | Stripe identifiers and webhook plumbing; the Stripe fake (#566) owns this evidence |
| `runtime-state` | `rate_limit_counters`, `transient_renders` | IP-keyed abuse controls; nothing a catalogue shape needs |
| `telemetry` | `route_stats`, `route_stat_events`, `affiliate_clicks`, `search_history`, `share_intents`, `activity_feed`, `user_fact_preferences` | per-visitor behaviour, free text, 2.5k event rows of no shape value |
| `not-catalogue` | `conversations`, `messages`, `reference_research_cache`, `eval_runs`, `tier_feature_permission_audit`, `feature_permissions_migration_log`, `engine_revision_bumps` | admin-side history and scratch state; `eval_runs` goes with `image_prompt_attempts.eval_*` (below) |

**Included, with every column named.** Columns not listed are dropped.

- `users` — `id` (`map-user`), `email` (`synthetic`:
  `fixture-user-<n>@example.test`, `<n>` the row's rank by `created_at`),
  `first_name` / `last_name` / `display_name` (`synthetic`: from two fixed
  word lists by `<n>`), `profile_image_url` (`media`), `google_linked`,
  `apple_linked`, `is_admin`, `admin_notifications`, `dispute_notifications`,
  `is_active`, `stripe_customer_id` (`synthetic`: `cus_fixture<n>` where the source id
  resolves in `stripe.customers` with `livemode = false`, else `null` — the
  eligibility predicate of the payment paragraph below; so "has a
  customer" survives only where test provenance is established),
  `membership_tier`, `membership_valid_until`, `avatar_style`,
  `avatar_source`, `pronouns`, `monthly_generation_limit_override_usd`,
  `nsfw_mode_enabled`, `created_at`, `updated_at`. Dropped: `password_hash`,
  `pending_email`, `captcha_verified`, `email_verified_at` (the loader writes
  `email_verified_at = created_at` and `captcha_verified = true` so a fixture
  user is a settled account rather than one mid-onboarding; no fixture user
  can sign in, since none has a password or a linked provider that resolves —
  the seeded test accounts are the sign-in path).
- `facts` — `id`, `text` (`fact-text`), `submitted_by_id` (`map-user`),
  `parent_id`, `use_case`, `upvotes`, `downvotes`, `score`, `wilson_score`,
  `comment_count`, `share_count`, `has_pronouns`, `is_active`,
  `canonical_text` (`fact-text`), `split_token_index`, `pexels_images`
  (`shape:factPexelsImages`), `pexels_status`, `visual_concept_candidates`
  (`shape:visualConceptCandidatesBlob`), `visual_concept_status`,
  `ai_scene_prompts` (`shape:aiScenePrompts`), `ai_meme_images`
  (`shape:aiMemeImages`), `ai_meme_backfill_status`, `enrichment` /
  `enrichment_ai_derived` (`shape:factEnrichment`), `enrichment_overrides`
  (`shape:enrichmentOverrides`),
  `enrichment_baseline_changed`, `enrichment_status`, `primary_archetype`,
  `subtype`, `overhype_fit`, `adult_suitability`, `last_processed_signature`
  (`keep`: version numbers and the engine revision), `eval_golden`,
  `eval_golden_reason` (`prose`), `embedding` (`keep` for kept-text facts,
  `null` otherwise), `created_at`, `updated_at`.
- `pending_reviews` — every column, with `submitted_text` (`fact-text`),
  `submitted_by_id` / `reviewed_by_id` / `production_rejected_by_id`
  (`map-user`), `enrichment` (`shape:factEnrichment`), `hashtags` (`keep`
  for a kept-text row, replaced by the placeholder's hashtags otherwise),
  `admin_note` / `production_rejection_note` (`prose`, always: admin prose
  never acquires permission through an active fact),
  `visual_render_approval_waiver` (`shape:visualRenderApprovalWaiver`),
  `candidate_version_id` (`map-id`).
- `fact_enrichment_versions` — every column, with `created_by` (`map-user`),
  `source_review_id` (`map-id`), `enrichment` / `enrichment_ai_derived`
  (`shape:factEnrichment`), `enrichment_overrides`
  (`shape:enrichmentOverrides`), `visual_override`
  (`shape:visualStrategyOverride`), `note` (`prose`), `signature` (`keep`)
  and `fact_text_hash` (`predicate-hash`, D4).
- `enrichment_override_history` — every column; `performed_by` (`map-user`),
  `old_value` / `new_value` (`shape:overrideValue`, keyed by the row's
  `path`), `reason` (`prose`), `ai_generation_id` (`keep`: an opaque id).
  `fact_text_edit_history` — every column; `performed_by` (`map-user`),
  `old_text` / `new_text` (`fact-text`), `reason` (`prose`).
- `image_prompt_attempts` — every column except `eval_by`, `eval_notes`,
  `eval_at`, `eval_run_id`, `eval_scenario_key`, `eval_input_hash`,
  `moderator_rating`, `failure_tag` (the eval lane, dropped with
  `eval_runs`); `user_id` (`map-user`), `review_id` (`map-id`),
  `generated_image_object_path` (`media`), `fact_enrichment_snapshot`
  (`shape:factEnrichment`), `visual_plan` (`shape:imagePromptPlan`),
  `compiled_prompt` (`shape:compiledPrompt`), `render_controls`
  (`shape:renderControls`), `identity_policy` (`shape:identityPolicy`),
  `source_image_analysis` (`shape:sourceImageAnalysis`),
  `subject_fact_compatibility` (`shape:subjectFactCompatibility`),
  `rendered_fact_text` (`shape:renderedFactText`: re-rendered, D4),
  `review_render_input_hash` (`predicate-hash`, D4), `error`
  (`synthetic`: `"[fixture: vendor error redacted]"` where non-null, since
  vendor messages embed request ids and URLs; `error_code` kept),
  `request_id` /
  `render_job_id` / `review_render_batch_id` (`synthetic`: opaque ids
  regenerated, same shape, consistent within the fixture).
- `memes` — every column except `quarantine_reason`, `video_object_path`
  and `video_job_id`; rows with `status = 'quarantined'` and rows with
  `artifact_type = 'video'` are **not exported** (and nothing referencing
  them is): a video needs real MP4 bytes to be usable and video is cut from
  launch (one such row in dev). `image_url` (`media`), `permalink_slug`
  (`keep`: a random nanoid, and the key the image route derives, D5),
  `image_source` (`shape:imageSource`), `text_options`
  (`shape:textOptions`: `topText` / `bottomText` `prose`, the rest kept),
  `framing_transform` (`keep`), `created_by_id` (`map-user`),
  `rendered_fact_text` (`fact-text`).
- `upload_image_metadata` — `object_path` / `source_object_path` (`media`),
  `width`, `height`, `is_low_res`, `file_size_bytes`, `created_at`, `user_id`
  (`map-user`), `is_nsfw`, `is_profile`, `transform`, `fact_id`,
  `transform_params_hash`. Dropped: the five `arachnid_*` columns,
  `source_image_analysis`, `source_image_analysis_version` (an analysis of a
  person's photo). A row whose `arachnid_match_type` is non-null is **not
  exported**.
- `user_ai_images` — every column; `user_id` (`map-user`), `storage_path`
  (`media`).
- `comments` — every column; `author_id` (`map-user`), `text` (`prose`,
  always — user-authored prose is not catalogue text and option 1 did not
  ask about it), `flag_reason` (`prose` where non-null).
- `ratings`, `reactions`, `hashtags`, `fact_hashtags`, `external_links`
  (`url` / `title` `synthetic`: `https://example.test/fixture/<n>`,
  `added_by_id` `map-user`) — every column.
- `membership_entitlements` — every column; `user_id` / `granted_by_admin_id`
  / `revoked_by_admin_id` (`map-user`), `provider_ref` (`synthetic`:
  `<prefix>_fixture<n>` keeping the Stripe object prefix so the row's
  source shape survives), `plan` (`synthetic`: `price_fixture<n>` where it
  is a Stripe price id), `granted_by_admin_label` / `revoked_by_admin_label`
  (`admin-label`), `grant_reason` / `revoked_reason` (`prose`). **Row
  predicate (Astra round 1, C5):** an admin-granted row is always eligible;
  a provider-backed row is eligible only when its `provider_ref` resolves,
  **in the sync table its `source_type` names** (`stripe_subscription` →
  `stripe.subscriptions`, `stripe_lifetime_payment` →
  `stripe.payment_intents`; Astra round 2), with `livemode = false`. A row whose reference does
  not resolve, or resolves with `livemode` true or null, is excluded and
  counted in the manifest. The sync schema is **read for this one boolean
  per reference and nothing of it is written** — the allowlist still names
  only `public` tables as sources.
- `membership_history` — every column; `user_id` / `performed_by_admin_id`
  (`map-user`), the four `stripe_*_id` columns (`synthetic` where non-null).
  **Row predicate:** every Stripe id the row carries must resolve in its
  sync table (`subscriptions`, `payment_intents`, `invoices`, `disputes`)
  with `livemode = false`; otherwise the row is excluded and counted.
  Measured today (the surface above) every reference is test mode, so the
  fixture is expected to carry the 1 entitlement and the 13 history rows;
  the predicate is what makes that a fact rather than an assumption about
  where the database lives. If the sync schema is ever absent, every
  provider-backed row is ineligible — the predicate fails closed.
- `entitlement_source_disputes` stays excluded (Stripe-fake territory,
  #566), and the Stripe webhook tables with it.
- `user_generation_costs` — every column; `user_id` (`map-user`; the column
  is `text` with no FK, `falPricing.ts:17`, so it is on D3's named list),
  `job_reference_id` (`synthetic`).
- Catalogue configuration, every column, `keep`: `engines`, `look_styles`
  (`preview_image_path` `media`), `motion_presets` (`preview_gif_path`
  `media`), `hero_examples` (`asset_url` / `poster_url` `media`),
  `admin_config` (`updated_by_id` `map-user`; the 72 keys are product
  settings — the migration-seeded key list in `lib/db/migrations` names
  `ai_*`, `budget_*`, `pexels_*`, `user_max_images`, `fact_image_prompt_system`
  — and the exporter refuses any value that matches a credential shape,
  D6), `feature_flags`, `tier_feature_permissions`,
  `entitlement_grid_revision`, `fal_pricing_cache`.

### D3. Identities become synthetic, and every reference follows

- **One identity map per extraction.** A random 32-byte key is generated at
  run start and never written; each user id maps to
  `uuidv4(HMAC-SHA256(key, id))`. Nothing in the fixture can be mapped back,
  and the mapping is consistent across every column in the run.
- **Which columns are remapped is derived, not recalled.** The exporter
  reads `information_schema.referential_constraints` for every FK that
  targets `public.users` and remaps those, plus a **named list of FK-less
  user columns** (`user_generation_costs.user_id`; the test in D9 fails
  when a column named `user_id`, `*_by_id`, `*_by`, `actor_*` or `owner_*`
  is neither an FK to `users` nor on that list, so the next one added has to
  be classified).
- **Other remapped keys** (`map-id`): rows are exported with their real
  primary keys (ints and bigints carry no identity), so `fact_id`,
  `review_id`, `candidate_version_id` and `source_review_id` need no
  rewriting; `map-id` only enforces that the target row was exported (a
  dangling pointer is an exporter error, not a nulled column).
- **Nested actor references are on the same map** (Astra round 1, C1): the
  shape transformers of D4 route `visualPromptStrategyOverride.updatedBy`
  (an admin's display name or email, `enrichmentOverrideLayers.ts:64-75`)
  through `admin-label`, `renderControls.reviewAudit.adminUserId`
  (`imagePromptAttempts.ts:49`) and the waiver's `waivedByAdminUserId`
  (`renderScenarios.ts:213`) through `map-user`, and the visual-concept
  blob's provenance (`visualConceptProvenanceSchema`) through the same two.
  The sentinel test plants an admin email and id in each of those places.
- **Admin labels** (`admin-label`) are rewritten to the mapped admin's
  synthetic display name, or `"Fixture Admin"` when the admin row is absent.
- **`is_admin` is kept** as a shape, and it is inert: a fixture admin has no
  credential, and the dev-admin login resolves the configured bootstrap
  email, which no synthetic email matches.

### D4. What is kept is the fact template; every linked row is transformed, whatever its fact's status

- **The principle** (Astra round 1, C1, replacing v2's "kept facts keep
  everything"): the only content that passes through unchanged because of
  David's option 1 is **the fact template text and its canonical
  rendering**, on rows where that text is the live text. Identity, prose
  and media transformations apply to **every included row**, active facts'
  linked records included. An active fact never lends its permission to a
  personalised rendering of it, an admin's note about it, a historical
  snapshot of it, or a provenance stamp on it.
- **Which rows keep the template.** A `facts` row keeps `text` and
  `canonical_text` iff `is_active = true` at extraction. A `pending_reviews`
  row keeps `submitted_text` iff its fact is kept **and** `submitted_text`
  equals that fact's kept text byte for byte — for the approved review (an
  old submission can differ from today's live text after a protected text
  edit, `confirmedFactTextEdit.ts`) and for a refresh review alike
  (`sendBackToReview.ts:147` writes `submittedText: fact.text`). A
  `fact_text_edit_history` row keeps a text iff it is a kept text. Every
  other text-bearing row gets a placeholder. "Approved live fact text" is
  read as the active catalogue; a deactivated fact, a staging fact, a
  rejected one and a flagged one get placeholders, so "reported" needs no
  column of its own.
- **Placeholder text is already-tokenised, from a committed corpus**
  (`legacyFixture/placeholderFacts.ts`: a dozen templates in the grammar,
  half with pronoun tokens, distinct from `scripts/src/seed.ts`'s facts). A
  placeholder row takes template `<n> mod 12` from the half matching its
  `has_pronouns`; `canonical_text`, `split_token_index` and `has_pronouns`
  are recomputed by the real pure functions (`renderCanonical`,
  `renderCanonical.ts:48`; the `normalizeFactTemplateForStorage.ts` path).
  No AI call.
- **Absent, null, empty and whitespace-only states are preserved; only
  substantive prose is replaced** (Astra round 2, C2, whose probe showed a
  blank core scene and a half-filled bubble becoming "complete" under v3).
  The readers decide on presence: the approval gate requires a non-empty
  trimmed core scene (`moderationStaging.ts:237-239`), and the override
  signal ignores a bubble unless both halves have text
  (`visualStrategyOverride.ts:505-510`). So a string that is empty or
  whitespace after `trim()` is emitted exactly as stored, an absent field
  stays absent, a null stays null, and schema parsing never materialises a
  default into the exported shape (transformers run on the raw stored
  value and validate a copy). The same holds for media collections: an
  empty-string slot in `ai_meme_images` is a deleted slot
  (`routes/memes.ts:1664` writes `""` on deletion) and stays `""`, never a
  placeholder image.
- **Substantive prose becomes a content-keyed placeholder** (`prose`, and
  inside every shape transformer): a non-blank free-text value `v` becomes
  `"[fixture text <h>]"` with `<h>` the first 8 hex of
  `HMAC-SHA256(run key, v)`. Equal source strings therefore map to equal
  placeholders and distinct ones to distinct ones, within the run and
  nowhere else — so every reader that compares two stored copies
  (`overrideValuesEqual`, `enrichment_baseline_changed`, the override
  layers' content comparison, `stableStringify` equality) answers on the
  fixture as it did on the source, without the exporter knowing which
  comparisons exist. A length-bounded field gets a placeholder that fits
  its bound.
- **One transformer per stored shape, written against the shape's own
  validator** (Astra round 1, C2, replacing v2's generic leaf walk). The
  table below is the inventory; each transformer parses its input with the
  named validator, applies the listed field rules, and parses its output
  with the same validator **and** the reader named in the last column
  before the row is emitted; a failure names the row and column and stops
  the run. Structural identifiers (scenario keys, modifier ids, archetypes,
  subtypes, version stamps, policy versions, hashes the predicate rule
  owns) are kept; null and absent stay null and absent.

  | Shape | Validator | Rules | Reader proved |
  |---|---|---|---|
  | `factEnrichment` | `factEnrichmentSchema` (`taxonomy.ts:575`) | enum/number/boolean fields kept; `adultSuitabilityNotes`, `adminReviewNotes`, `semanticEntities[*]` and `culturalReferences[*]` text, `visualPromptStrategyOverride` prose → `prose` (blank stays blank); `visualPromptStrategyOverride.updatedBy` — a display name or email (`enrichmentOverrideLayers.ts:64-75`) → `admin-label`; `suggestedHashtags` kept on a kept-text fact, the placeholder's otherwise | `validateEnrichment`; `resolveEnrichment`; the concept gate of `moderationStaging.ts:237` and `nonOverrideRenderedPaths` answer as on the source |
  | `enrichmentOverrides` | `enrichmentOverridesSchema` + `OVERRIDABLE_PATHS[path].schema` per entry (`enrichmentOverrides.ts:83,121`) | `value` and `overriddenFrom` transformed by the **path's own schema**: an enum/number/boolean path kept, a text path → `prose` that still satisfies the path schema; `createdBy` / `updatedBy` — admin **ids** (`enrichmentOverrideLayers.ts:261`) → `map-user`; `reason` → `prose`; `aiGenerationId`, timestamps kept | `resolveEnrichment`: `invalidPaths` and `baselineChangedPaths` equal the source's |
  | `overrideValue` (history `old_value` / `new_value`) | `OVERRIDABLE_PATHS[row.path].schema` | as above, keyed by the row's `path` | the path schema |
  | `visualStrategyOverride` | `visualStrategyOverride.ts` schema | prose → `prose`; provenance → `admin-label` | the schema |
  | `visualConceptCandidatesBlob` | `visualConceptCandidatesBlobSchema` (`visualConcepts.ts:318`) | concept and bubble text → `prose` (blank stays blank); `reviewId`, `candidateVersionId` kept; `inputHash` → `predicate-hash`; `provenance` is engine/model/version data (`visualConceptProvenanceSchema`, `visualConcepts.ts:303-312`), kept | `buildVisualConceptsResponse` (`visualConceptJobs.ts:276`): `current` and `staleReason` equal the source's |
  | `aiScenePrompts` | the column's documented shape (`facts.ts:62`) | every string → `prose` | the schema |
  | `imagePromptPlan` (`visual_plan`) | `imagePromptPlanWireSchema.shape.visualPlan` (`imagePromptGeneration.ts:567-569`; the column stores the inner `visualPlan`, not the enclosing pair — Astra round 2) | prose → `prose`; enums, versions, identity forms kept; names inside identity forms → the row's synthetic identity | the schema |
  | `compiledPrompt` | a fixture-local projection check against `CompiledImagePrompt` (`imagePrompt/types.ts:163-185`): the worker persists the compiler's output (`imagePromptJobs.ts:244-247`), which omits `negativePrompt` and may omit `engineNotes`, so the planner's wire schema rejects it (Astra round 3, withdrawing its round-2 advice; probed through the real compiler) | `prompt`, `imagePrompt`, `negativePrompt`, `engineNotes`, `promptBreakdown[*]` text and `diagnostics` prose → `prose`; `referenceImageUrl` → `media` (the shared mapping); statuses, budget numbers and optional-field presence kept | the projection check, fed real compiler output including an i2i reference and nested diagnostic text |
  | `renderControls` | `RenderControlsWithRefs` (`imagePromptAttempts.ts:29-49`) **plus the two fields the generation routes persist** (`routes/memes.ts:1534-1537`: `promptIdentity`, `resolvedRenderStyle`), which the worker prefers over the legacy subject (`imagePromptJobs.ts:464-466`) | `promptIdentity.name` / `.pronouns` → the row's synthetic identity, every other field of the snapshot and its presence kept, so the frozen-versus-legacy distinction survives; `reviewAudit.adminUserId` → `map-user`; `referenceImageUrl` → `media`; `reviewRenderSubject` kept (a sampled subject); `resolvedRenderStyle` kept (a snapshot of the catalogue's style, `look_styles` text); `styleId`, `mirrorToLegacyStorage` kept; any field outside this list stops the run | a fixture-local check over the listed fields; `isValidPromptIdentitySnapshot` |
  | `identityPolicy` | `IdentityPolicy` (`imagePromptGeneration.ts:201-215`: render-mode and preservation flags, no names) | kept whole | the schema |
  | `sourceImageAnalysis` | `SourceImageAnalysis` | descriptions → `prose`; classifications and scores kept | the schema |
  | `subjectFactCompatibility` | its schema | prose → `prose`; verdict enums kept | the schema |
  | `renderedFactText` | — | re-rendered by `renderPersonalized` (`prepareAttemptInputs.ts:84`) over the row's (kept or placeholder) template and its identity: the mapped synthetic user for a user attempt, `reviewRenderSubject` for a review render | `hasUnresolvedFactTokens` false |
  | `visualRenderApprovalWaiver` | `visualRenderApprovalWaiverSchema` (`renderScenarios.ts:204-217`) | `waivedByAdminUserId` → `map-user`; `reason` → `prose`; scenario keys, statuses, `latestAttemptId`, policy version kept | the schema |
  | `imageSource` | `ImageSourceSchema` (`memeBuilder.ts:77`) | `upload.uploadKey` → `media`; `stock.pexelsPhotoId` kept, `stock.photoUrl` → a `data:` placeholder (D5), `stock.photographerName` → `prose` | the schema |
  | `textOptions` | `TextOptionsSchema` (`memeBuilder.ts:59`) | `topText`, `bottomText` → `prose`; styling kept | the schema |
  | `factPexelsImages` | `FactPexelsImages` (`factImagePipeline.ts:169`) | photo URLs → `data:` placeholders (D5); photographer fields → `prose`; **`keywords.*` → `prose`** (they are model-generated from the fact text, `factImagePipeline.ts:80-88`, and run before approval, `firstTimeStagingPrep.ts:107` — Astra round 2); ids and `fact_type` kept | the schema |
  | `aiMemeImages` | `AiMemeImages` (`aiMemePipeline.ts:193`) | every path → `media` | the schema |

  `unable to verify: the exact validator names for sourceImageAnalysis
  and subjectFactCompatibility; a grep of lib/api-zod/src settles it and
  the builder cites them`. Where a row names a TypeScript interface rather
  than a runtime validator, the transformer carries a fixture-local
  projection check over the fields it lists. **A stored legacy shape the
  transformer cannot retain safely stops the run and comes back to this
  plan** — never silent normalisation, never silent omission (Astra round
  2).
- **Hashes are rewritten to preserve what the readers conclude, not their
  bytes** (Astra LF2 / C2), on **every** row, active facts' included (their
  enrichment changes too, through provenance and prose). The predicate
  inventory: render staleness, `factRenderScenarios.ts:193` —
  `review_render_input_hash` against `buildScenarioInputHash(…)` over
  staging fact id, scenario key, render mode, rendered text, the
  render-affecting enrichment, reference identity and asset version, render
  controls, look style, style suffix version, identity policy and engine
  (`:151-186`); candidate promotion, `enrichmentVersioning.ts:335` —
  `fact_text_hash` against `hashFactText(fact.text)`; visual-concept
  freshness, `visualConceptJobs.ts:276` — the blob's `inputHash` (and its
  `reviewId` / `candidateVersionId`) against the review's live state. For
  each such row the exporter evaluates the predicate **on the source**,
  then writes the hash that makes the predicate answer the same **on the
  scrubbed row**: recomputed by the real function over the scrubbed inputs
  when the source was current, left as a non-matching value when the source
  was stale — and asserts the outcome per row before emission. The manifest
  carries the per-predicate current/stale counts; the readers test (D9)
  re-runs them. Hashes not derived from scrubbed values are kept:
  `last_processed_signature` (`processingSignature.ts:77-89`; its engine
  revision is read from `admin_config`, which the fixture carries, so the
  46-of-53 "stale signature" state survives untouched),
  `transform_params_hash`, and the recordings' fingerprints, which this
  increment never touches.
- **App-managed links are checked, not assumed** (Astra LF2):
  `pending_reviews.candidate_version_id` → `fact_enrichment_versions.id`,
  `fact_enrichment_versions.source_review_id` → `pending_reviews.id`,
  `pending_reviews.staging_fact_id` / `approved_fact_id` / `matching_fact_id`
  / `parent_fact_id` → `facts.id`, `image_prompt_attempts.review_id`,
  `memes.fact_id`, `facts.parent_id`, `user_ai_images.storage_path` ↔ the
  placeholder list. The exporter refuses a pointer whose target is not in
  the export (a dangling link is a design error, never a nulled column),
  and the load test walks the same list.
- `fact_hashtags` and `pending_reviews.hashtags` for placeholder rows are
  replaced by the placeholder corpus's hashtags, so the `hashtags` table and
  `fact_count` stay consistent.

### D5. Media become placeholders placed where each consumer looks, with the ACL its writer sets

(Astra round 1, C3: a rewritten path alone resolves nothing; the consumer
decides where the bytes must be.) The exporter rewrites every media
reference; the manifest lists each placeholder with the row it serves; the
loader writes the bytes **through `ObjectStorageService` under
`STORAGE_BACKEND=local-double`** with the ACL the row's writer would have
set, read from the writer code. Bytes are generated, never copied: a solid
PNG or JPEG at the recorded size where `upload_image_metadata` holds one,
64×64 otherwise. The placement table, by consumer:

| Reference | Consumer that reads it | Placement and representation | ACL (from the writer) |
|---|---|---|---|
| `memes.image_url`, legacy memes (`image_source` null) | `GET /memes/:slug/image` derives the key from the slug: `memeKey(slug, "jpg"\|"png")` (`routes/memes.ts:609-633`) | bytes at `/objects/memes/<hash2>/<slug>.jpg`; `image_url` rewritten to the public URL form the row used; slugs kept | public, owner = creator (`memes.ts:833,972`) |
| `memes.image_source.upload.uploadKey` | the same route's `upload` branch downloads the key (`:697-702`) | bytes at a synthetic `/objects/uploads/<hash2>/fixture-<k>.jpg` | private, owner = creator (`objectAccess.ts:54`; `userImageUpload.ts:379-381`) |
| `memes.image_source.stock.photoUrl`, `facts.pexels_images[*].src.*` | the `stock` branch resolves through Pexels, which throws without a key (`pexelsClient.ts:144-145`), then falls back to the stored URL and hands it to the canvas loader (`:694`, `memeGenerator.ts:269`); the frontend renders `pexels_images` as `<img>` sources | a `data:image/jpeg;base64,…` URL under the schema's 2000-character bound (an 8×8 JPEG is 1,035 characters; `@napi-rs/canvas`'s `loadImage` decoded one in this container: `loaded 8 8`) — no server, no port, no vendor | n/a |
| `upload_image_metadata.object_path` (profile rows) and `users.profile_image_url` | avatars, read publicly | bytes at a synthetic upload key; the user's `profile_image_url` rewritten to it | **public**, owner = user (`routes/users.ts:600-605`, `:329`) |
| `upload_image_metadata.object_path` (other rows), `source_object_path` | `/storage/objects/*` through `canAccessObject` | synthetic upload keys | private, owner = user |
| **One AI-generated object, wherever it is referenced** (Astra rounds 2–3, C3): the legacy generator writes one `storedPath` into `facts.ai_meme_images` **and** `user_ai_images` as `generic` (`aiMemePipeline.ts:1180-1190`); the newer pipeline's mirror writes one path into the fact gallery, a `user_ai_images` row as **`reference`**, an `upload_image_metadata` row (`transform = 'phase2_v2'`) and the producing attempt (`imagePromptJobs.ts:648-700`); gallery deletion checks ownership by that stored path (`routes/memes.ts:1649`) | each role's own consumer, below | **the mapping is per source object, not per column**: a source path maps to exactly one synthetic path, reused in every column and jsonb slot that held it, so equality across rows survives. **Gallery membership, tracking type and upload metadata are overlapping roles of one object, not exclusive kinds**: the exporter records every role a path plays and refuses only a combination no current writer produces, never one it does | from the producing storage path, below |
| — a path under the generated-image prefix (`ai-backgrounds/…`, the key `aiBackgroundKey` builds, `storageKeys.ts:17-29`), whatever roles it plays | the fact gallery route reads the stored object directly (`GET /memes/ai/:factId/image`, `routes/memes.ts:1058`); the reference route serves it to its owner only through the `reference` tracking row (`objectAccess.ts:76-91`); the admin render route serves an attempt's object under `requireAdmin` (`reviews.ts:1718-1745`) | synthetic `ai-backgrounds/<hash2>/fixture-<k>.png`, in every slot and row that held it | **as the producing writer set it**: the legacy pipeline sets system/public for backgrounds (`aiMemePipeline.ts:459-461`) and for reference images alike (`:783-795`); the newer pipeline uploads with no ACL (`imagePromptJobs.ts:375-390`), so the loader sets none there — the reference route's ownership gate is the database row, not the ACL, and the fixture reproduces both outcomes rather than inventing a private ACL |
| — ephemeral review render: an attempt with `review_id` set, or `mirrorToLegacyStorage: false`, whose path appears in no gallery, tracking or upload row | `GET /admin/reviews/:id/renders/:renderJobId/image` under `requireAdmin`, bypassing the ACL route (`reviews.ts:1718-1745`); the eval route likewise | synthetic `/objects/review-renders/<hash2>/fixture-<k>.png` | as the writer set it (none under the newer pipeline) |
| `renderControls.referenceImageUrl` | the compiler passes it to the vendor | a synthetic `/objects/…` placeholder (never fetched under the doubles) | private, owner = system |
| `look_styles.preview_image_path`, `motion_presets.preview_gif_path`, `hero_examples.*` | admin and public catalogue pages | synthetic public keys (`admin.ts:3256` sets system/public) | public, owner = system |
| `memes.video_object_path` | — | **not exported**: video memes are excluded (D2) | — |

Every placeholder's key keeps the grammar its consumer parses (an
`/objects/` path stays one, a bare key stays bare, a public search-path URL
stays one). The exporter records each source object once with every role it plays
(gallery slot, `user_ai_images` type, upload-metadata row, producing
attempt, column), takes placement and ACL from its producing storage path
and writer, emits one synthetic path for it, and refuses only a role
combination no current writer produces; the manifest's placeholder list is
keyed by that path and names every row that holds it. The existing
consumers' access outcomes — gallery open, reference route owner-only via
the tracking row, admin render route admin-only — are what the media test
asserts.
The load test (D9) reads each placeholder **through its consumer route**
with the identity the row implies, not through a direct object download.

### D6. The exporter — runs on the Repl, reads only, reports what it did

- `artifacts/api-server/scripts/export-legacy-fixture.ts --out <dir>`.
  Refuses: a production environment (`REPLIT_DEPLOYMENT=1` or
  `NODE_ENV=production`), a non-empty `--out`, a target under the repository.
  It is run through the connector on the Repl against the development
  database (the only place that database is reachable), as an ops command
  with a read-only instruction, and never in CI. It writes
  `<table>.ndjson` per included table plus `manifest.json`: source commit,
  the `__drizzle_migrations` head hash, extraction time, row counts per
  table, the placeholder list (D5), the scrub ruleset version, and the
  redaction-failure count (D4).
- **The exporter's own output names tables, columns and counts, never a
  value** (Astra LF1): no row is printed, logged or written outside
  `--out`, on success or on refusal.
- **Credential shapes are refused anywhere in the output.** Before writing,
  every string value is checked against the shapes of a Stripe key, an
  OpenAI or fal key, a bearer token, a JWT, an email address other than the
  synthetic form, an IPv4/IPv6 literal, and a `sk_`/`rk_`/`whsec_` prefix; a
  hit stops the run naming the table and column. This is the last line, not
  the first: the allowlist is what keeps those values out, and the check
  proves it on the real data.
- **Transfer off the Repl** as plain-text files with a sha256 per file,
  verified against the Repl's own listing (#631 harvest note: binary
  archives through the connector can corrupt silently; small JSON transfers
  cleanly).
- **Committed at** `artifacts/api-server/fixtures/legacy/` (the NDJSON, the
  manifest, and `README.md` saying what it is, when and from what it was
  taken, and how to refresh it).

### D7. The loader — refuses everything but a marked, empty test database

- `artifacts/api-server/scripts/load-legacy-fixture.ts`. Refuses, before any
  import that reaches the database (the `seed-e2e-test-accounts.ts`
  pattern): an unmarked database (`testDatabaseRefusal`), a production
  environment, `STORAGE_BACKEND` not `local-double`, and a target where
  `facts`, `memes` or `users` already hold any row (the account seed and the
  bootstrap admin come after the load; the order bullet below).
- **Config tables are upserted, data tables inserted.** `engines`,
  `look_styles`, `motion_presets`, `hero_examples`, `admin_config`,
  `feature_flags`, `tier_feature_permissions`, `entitlement_grid_revision`
  and `fal_pricing_cache` are written with `ON CONFLICT … DO UPDATE` so the
  fixture's (dev's real) configuration replaces the migration seed; every
  other table is inserted in FK order with its real primary keys
  (`OVERRIDING SYSTEM VALUE` for identity columns), and every sequence is
  set past its maximum afterwards.
- **Inserts go through the Drizzle table objects**, so a column the schema no
  longer has fails the typecheck, and a new `NOT NULL` column without a
  default fails the load. Either is CI red with a named cause, and the
  remedy is a re-extraction from dev (which has run the migration): the
  fixture is pinned to the migration ledger head in its manifest, and the
  loader prints both heads when they differ.
- **The account seed runs after the fixture** (Astra round 1, C3): the
  seeder's `applyAdminGrant` inserts identity-keyed entitlement and history
  rows (`seed-e2e-test-accounts.ts:86`), which would collide with source
  ids inserted afterwards. The order is `schema push → migrations → fixture
  load → sequence reset → account seed → boot`; the loader's "non-empty
  target" refusal is therefore against any `users`, `facts` or `memes` row
  at all (the bootstrap admin is seeded by the account seeder, after). The
  sequence reset covers every serial and identity sequence **and the two
  standalone sequences** `membership_source_state_seq` and
  `membership_lease_fence_seq` (`membershipEntitlements.ts:46-53`), set past
  the fixture's highest `source_state_as_of`. A failed load is not resumed:
  the target is disposable and is recreated.
- `fal_pricing_cache` rows are written as exported, timestamps included: the
  warm-up refreshes unconditionally at boot (`index.ts:116-120`, Astra round
  1) and the double answers or logs it; `getCachedPrice` then reads the row
  that is there and never throws while one exists (`falPricing.ts:142-158`).
- **Media placeholders are written as D5 says**, after the rows.

### D8. The handoff to increment 6: what loading the fixture changes, recorded, not patched here

(Astra LF4, accepted: the acceptance run over the fixture, and any
re-recording it needs, are increment 6's; this increment changes nothing in
`lib/aiDouble/` or `record-ai-baseline.ts` and spends nothing.) The PR body
and #631's State of Play record, for increment 6:

- **The fixture's identity**: the manifest's digest, the source commit and
  the migration head it was taken at; a recording made over it names that
  digest beside the fixture identity the recordings already carry (inc 4,
  D4).
- **Loading order** (D7): schema push → migrations →
  `load-legacy-fixture.ts` (which refuses a non-empty target, so the order
  is enforced, not documented) → sequence reset → `seed-e2e-test-accounts.ts`
  → server boot.
- **Boot and journey effects that change baseline requests**: journey 3's
  duplicate check sends the nearest catalogue neighbours to the utility
  model (`routes/ai.ts:266-304`), and hashtag suggestions read existing
  hashtags, so those requests differ from the empty-catalogue recordings
  and the replay will fail naming them until increment 6 tops the
  recordings up (`--resume`, inside David's remaining ceiling); the
  embedding backfill's own predicate counts **0** on the source (kept facts
  carry their real embeddings; placeholder facts are inactive,
  `embeddings.ts:104-106`), and the manifest records that count so the
  claim travels with the fixture; the pricing warm-up refreshes every
  engine endpoint unconditionally at boot (`index.ts:116-120`) — under the
  double those are the `fal.pricing` calls the replay already excludes
  (`record-ai-baseline.ts:213`) — and `getCachedPrice` reads the fixture's
  rows afterwards; a stock-recipe meme regenerated in a journey would call
  Pexels (`pexelsClient.ts:144`), which has no double — increment 6's
  outbound detector will see it, and that is increment 6's to decide.
- **What this increment proves instead**: that the fixture loads, that the
  real readers see the states the source had (D9), and that the app boots
  over it with the doubles selected and no credential — a boot, not a
  journey.

### D9. Tests and evidence

- `legacyFixtureAllowlist.test.ts`: every `pgTable` exported from
  `@workspace/db` is classified; every included jsonb column names a
  `shape:` transformer and every transformer names its validator; no included column is named `password_hash`,
  `*token*`, `sess`, `ip_*`, `*_ip`, `key_raw`, `request_metadata`,
  `evidence_*`, `arachnid_*`; every excluded-class table named in
  `decisions.md` 2026-08-28 is excluded; every column matching D3's user-id
  name patterns is an FK to `users` or on the named list.
- `legacyFixtureScrub.test.ts` (the sentinel test, on the test database),
  in **two separate cases** (Astra round 1, C1: an early refusal must not
  stand in for evidence that later content was scrubbed). *The scrub
  case:* seed a source with sentinels in every excluded class and every
  transformed location **on active-fact records** — a session row, a
  pending job, a quarantined meme with an evidence path, an NCMEC report, a
  real-shaped email in the visual-strategy override's `updatedBy` label
  and an admin id in a manual override's `createdBy`, a waiver's
  `waivedByAdminUserId`, a render control's `reviewAudit.adminUserId` and
  frozen `promptIdentity.name`, a user's name inside a rendered attempt
  text, a Pexels keyword string, a compiled prompt's breakdown text, a
  meme caption, an admin note, an older approved review whose text differs from
  the live text, a pending refresh candidate, a Pexels photographer, an
  IPv4 in every IP column, a `sub_` reference with no sync row and one with
  `livemode = true` beside one with `false` — run the exporter into a temp
  dir, and assert **no sentinel byte sequence appears anywhere under the
  output directory** (`grep -r` over the bytes, not a field check), that
  the two ineligible payment rows are absent and counted, and that every
  emitted shape parses with its validator and its reader (D4's table). *The
  refusal case:* a Stripe key planted in an `admin_config` value stops the
  run before any file is written.
- `legacyFixtureLoad.test.ts`: load the committed fixture into a fresh marked
  database with the storage double; assert the manifest's row counts, FK
  integrity (`pg_constraint` validation of every FK), the app-managed link
  list of D4 resolving, sequences past their maxima (a fact, a meme and a
  render attempt inserted after the load take fresh ids — Astra LF3,
  "subsequent inserts work"), the loader's four refusals, and that each
  placeholder resolves through `/storage/objects/*` and
  `/storage/public-objects/*` with the real access outcome (owner 200,
  other user refused, public 200). This is the CI check that keeps the
  committed fixture loadable as the schema moves.
- **The readers test** (Astra LF2 / C2): over the loaded fixture, the real
  predicates — `isStale` from `factRenderScenarios.ts:193` for every review
  render, the `fact_text_hash` check of `enrichmentVersioning.ts:335` for
  every candidate, `buildVisualConceptsResponse` for every review with a
  concept blob, `computeProcessingSignatureStaleness` for every fact,
  `resolveEnrichment` for every fact with overrides (its `invalidPaths` and
  `baselineChangedPaths`), `visualRenderApprovalWaiverSchema` for every
  waiver, the concept gate of `moderationStaging.ts:237` and
  `nonOverrideRenderedPaths` for every stored override — return the
  outcomes and counts the manifest recorded on the source, with the
  sentinel source (below) carrying a blank core scene, a half-filled bubble
  and a deleted `ai_meme_images` slot so the emptiness rule is proved, not
  assumed; and the admin review-queue, review-detail and fact-detail routes
  return 200 for a sample of each workflow stage, so a transformed row is
  one the product can read.
- **The consumer-route media test** (Astra C3): every placeholder class in
  D5's table is read through its consumer — the meme image route for a
  legacy, an upload-recipe and a stock-recipe meme (the last decoding its
  `data:` fallback through the real generator), the avatar URL for a
  profile upload, the AI-reference route as its owner and as another user,
  the admin render route as an admin and as an ordinary user, a public
  `ai-backgrounds` object — and the bytes decode as an image; plus **one
  shared-reference example** of each pipeline (Astra rounds 2–3, C3): the
  legacy pair (gallery slot + `generic` tracking row) keeps one path, the
  gallery serves it and the reference route refuses it even to its owner;
  the newer quartet (gallery slot, `reference` tracking row,
  `upload_image_metadata` row, producing attempt) keeps one path, the
  gallery serves it, the reference route accepts its owner and refuses
  another user, and deletion finds the tracking row by it.
- **A boot over the fixture**: the server started by the test launcher with
  `AI_BACKEND=recorded-double` and `STORAGE_BACKEND=local-double` over the
  loaded fixture reaches listening with no outbound request and no
  credential; its log goes in the PR. Journeys over it are increment 6's.

### D10. What the fixture is not

Not a production snapshot, not a privacy-reviewed copy of anything but dev,
and not refreshed automatically: a re-extraction is a deliberate run of D6
with its own report, and a schema migration that breaks the load is the
signal to do one.

## Not in this increment

The acceptance workflow that runs journeys 2–7 over the fixture (increment
6); the outbound-request detector (6); the burn-down (7); any change to how
the product reads the tables above (a product-schema change stops and comes
back, per the parent); a Stripe-schema export of any kind (#566).

## Questions for David

None that change scope. Two reversible choices proceed on my
recommendation and are listed for his veto: comments are placeholdered
always (D2) — option 1 answered facts, and user-authored prose is not
catalogue text; and video memes are left out of the fixture (D2) — one row
of a cut feature, which a PNG under an MP4 name would only pretend to serve.
The payment predicate of D2 keeps his boundary as stated: a provider-backed
row enters only with test-mode provenance established from the source's own
Stripe sync data, never on the strength of where the database lives.

## Definition of Done

The allowlist, exporter, loader and tests above are on `main`; the fixture
is committed with its manifest and README; the sentinel test and the load
test pass in CI; the readers test and the boot over the fixture pass and the boot log
is in the PR; TESTING.md documents the loader and the refresh procedure;
#631's State of Play records the extraction report (counts, redaction
failures = 0, predicate counts) and the increment 6 handoff of D8. No vendor
spend.
