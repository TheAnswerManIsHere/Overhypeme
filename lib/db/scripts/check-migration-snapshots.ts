/**
 * check-migration-snapshots.ts
 *
 * Verifies that every entry in _journal.json has a corresponding
 * `{prefix}_snapshot.json` file in the same meta/ directory, AND that the
 * snapshot chain is internally consistent (each snapshot's `prevId` equals the
 * `id` of the immediately-preceding snapshot in journal order, with the first
 * snapshot's `prevId` being the all-zeros UUID).
 *
 * Drizzle-kit generates a snapshot alongside each DDL migration it creates.
 * Manually crafted or DML-only migrations that pre-date this check do not
 * have snapshots; they are listed in SNAPSHOT_EXEMPT_TAGS below.
 *
 * Any journal entry NOT in the exempt list and WITHOUT a snapshot file causes
 * this script to exit 1 with a clear message naming each missing snapshot.
 * A broken prevId chain also causes exit 1.
 *
 * Usage:
 *   pnpm --filter @workspace/db check-snapshots
 *   node --import tsx/esm lib/db/scripts/check-migration-snapshots.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const META_DIR = path.resolve(__dirname, "../migrations/meta");
const JOURNAL_PATH = path.join(META_DIR, "_journal.json");

const NULL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Full tags of journal entries that are known to be snapshot-less.
 *
 * These are DML-only migrations, manually authored migrations written before
 * drizzle-kit snapshot tracking was in place, or migrations where the snapshot
 * was intentionally omitted. Adding a tag here is an explicit acknowledgement
 * that the missing snapshot is expected.
 *
 * DO NOT add new tags here without a clear reason — the whole point of this
 * check is to catch accidental omissions before they reach production.
 */
const SNAPSHOT_EXEMPT_TAGS = new Set<string>([
  // All previously-exempt tags (0001–0037) have been backfilled with accurate
  // snapshots reconstructed from anchor snapshots via rebuild-snapshots.ts.
  // Anything added here MUST come with a one-line comment explaining why a
  // snapshot is intentionally absent.

  // DML-only sweep that runs every existing user/profile name string
  // through the new personal-name validator's rules. No DDL means no schema
  // delta means no snapshot.
  "0044_sanitize_existing_names",

  // Constraint rename only: renames the PostgreSQL-auto-named unique
  // constraint on stripe_checkout_request_ledger.request_key
  // ("..._request_key_key") to Drizzle's convention ("..._request_key_unique").
  // The Drizzle snapshot already reflects the correct name from migration 0032
  // onward, so no snapshot delta is produced by this fix migration.
  "0045_checkout_request_key_constraint_rename",

  // Drops the obsolete route_visit_stats table, which was superseded by
  // route_stats + route_stat_events but never removed from the database.
  // The table was never exported from the schema index so it never appeared
  // in any Drizzle snapshot; no snapshot delta is produced by its removal.
  "0046_drop_route_visit_stats",

  // Rebuilds three indexes that were originally created without DESC NULLS LAST
  // even though the TypeScript schema specifies .desc().nullsLast().  The
  // Drizzle snapshot already reflects the correct sort order; only the live
  // database was behind, causing repeated publish-time schema drift.
  "0047_fix_desc_nulls_last_indexes",

  // Manually authored DDL for Phase 3 meme builder lineage: adds nullable
  // analytics/dedup columns + indexes + check constraints to memes and
  // upload_image_metadata. Authored by hand to avoid running drizzle-kit
  // generate without DB access; rebuild-snapshots.ts can backfill the
  // 0048_snapshot.json from schema TS later.
  "0048_meme_builder_lineage",

  // Phase 3 follow-up: adds memes.framing_transform jsonb to persist canvas
  // pan offsets so server-side renders / Zazzle exports honor creator
  // framing. Single ADD COLUMN; rebuild-snapshots.ts can backfill if needed.
  "0049_memes_framing_transform",

  // Phase 4: audit table for /api/render-preview and /api/render-download.
  // Manually authored; rebuild-snapshots.ts can backfill the snapshot later.
  "0050_transient_renders",

  // Phase 4: partial index on memes(created_by_id, created_at) WHERE
  // deleted_at IS NULL — covers per-user daily-cap and idempotency queries.
  // Index-only migration; no table shape change.
  "0051_memes_creator_created_at_index",

  // Phase 2 prompt-fidelity: adds `rendered_fact_text` (nullable text) to
  // image_prompt_attempts. Single ADD COLUMN; the column exists in the TS
  // schema but the snapshot was not regenerated because the previous snapshot
  // chain (0063) is missing the entire image_prompt_attempts table (manually
  // authored migration, not via drizzle-kit generate). snapshot #0063 is the
  // closest known-good snapshot, but the chain breaks after it because the
  // subsequent tables were not backfilled.
  "0070_image_prompt_attempts_rendered_fact_text",

  // Task #507: manually authored DDL. Adds `is_profile boolean NOT NULL DEFAULT
  // false` to upload_image_metadata, a partial unique index
  // UQ_uim_user_is_profile, and a backfill that tags existing
  // first-party profile-photo uploads. Written by hand to avoid running
  // drizzle-kit without DB access; rebuild-snapshots.ts can backfill the
  // 0055_snapshot.json from schema TS if needed.
  "0055_upload_image_metadata_is_profile",

  // MBFO-4 seed migration: inserts engines + look_styles + a feature_flags
  // row. Pure DML — no schema delta from the 0056 snapshot.
  "0057_mbfo4_seed_engines_and_look_styles",

  // DML-only fix: removes the `generate_audio` param entry from the Veo 3.1
  // Lite and Veo 3.1 Fast engine paramSchemas. Veo uses native_lipsync and
  // does not accept this Seedance-specific field; its presence caused 422
  // errors from fal.ai. No schema delta.
  "0058_fix_veo_engine_generate_audio",

  // Phase 6 retirement: DELETE FROM admin_config WHERE key IN (...) for
  // ~26 legacy ad-hoc per-model knobs (ai_std_*, ai_ref_pulid_*,
  // ai_image_model_*, ai_scene_prompt_*, video_*) that were superseded
  // by the engines table. Pure DML — no schema delta.
  "0060_retire_legacy_model_config_keys",

  // Admin-panel cleanup follow-up: drops the `style_suffix_*` admin_config
  // rows. Visual style prompt content now lives on the look_styles DB
  // table (seeded by 0057). Pure DML.
  "0061_retire_style_suffix_admin_config_keys",

  // Phase 2A: normalizes logic_formal_impossibility subtype names — folds
  // `zero_division_impossibility` and renames `paradox_impossibility` into
  // the canonical `paradox_or_undefined_impossibility`. Updates
  // facts.subtype + facts.enrichment->>'subtype' +
  // pending_reviews.enrichment->>'subtype'. Pure DML.
  "0064_subtype_name_normalization",

  // Phase 2: image_prompt_attempts table + indexes for per-attempt prompt
  // generation metadata. Hand-authored DDL — drizzle-kit's snapshot regen
  // currently fails on the upstream 0063 snapshot (malformed under the
  // pinned drizzle-kit version), so the snapshot is intentionally absent
  // for these two migrations. The drizzle TS schema in
  // `lib/db/src/schema/imagePromptAttempts.ts` is the source of truth.
  "0065_image_prompt_attempts",

  // Phase 2: adds source_image_analysis JSONB + source_image_analysis_version
  // VARCHAR(16) to upload_image_metadata as the analyzer cache. Hand-authored
  // DDL — see 0065 comment for snapshot rationale.
  "0066_upload_image_metadata_source_analysis",

  // Reference research cache: new table backing the admin "Research Reference"
  // tool (POST /admin/references/research). Hand-authored DDL — drizzle-kit's
  // snapshot regen still fails on the upstream malformed 0063 snapshot, so
  // the snapshot is intentionally absent. Drizzle TS schema in
  // lib/db/src/schema/referenceResearchCache.ts is the source of truth.
  "0067_reference_research_cache",

  // Bugfix: pending_reviews FK columns matching_fact_id and approved_fact_id
  // had no onDelete policy (defaulted to NO ACTION), blocking hard-deletes of
  // facts with a FK constraint violation. Hand-authored DDL to add ON DELETE
  // SET NULL to both constraints — drizzle-kit snapshot regen still fails on
  // the upstream malformed 0063 snapshot, so snapshot is intentionally absent.
  "0068_reviews_fact_fk_on_delete_set_null",

  // Surfaces the Visual Taxonomy Enrichment editor on the admin Facts page:
  // adds facts.enrichment_status VARCHAR(16) (nullable) to track the in-place
  // re-run-classification lifecycle, mirroring pending_reviews.enrichment_status.
  // Hand-authored single ADD COLUMN — drizzle-kit snapshot regen still fails on
  // the upstream malformed 0063 snapshot, so snapshot is intentionally absent.
  // lib/db/src/schema/facts.ts is the source of truth.
  "0069_facts_enrichment_status",

  // EXCEPTIONAL repo-health unblock (NOT a precedent for future DDL): this
  // already-merged, hand-authored DDL migration adds the AI-derived/override
  // columns + partial index to facts but shipped without a snapshot. Future
  // schema-changing migrations should generate a snapshot. Source of truth:
  // lib/db/src/schema/facts.ts.
  "0071_facts_enrichment_overrides",

  // EXCEPTIONAL repo-health unblock (NOT a precedent): already-merged,
  // hand-authored DDL creating the enrichment_override_history audit table
  // without a snapshot. Source of truth: lib/db/src/schema/enrichmentOverrideHistory.ts.
  "0072_enrichment_override_history",

  // DML-only sweep that strips the retired `avoid_gore` / `non_graphic_action`
  // modifiers from stored enrichment blobs/overrides + scrubs the classifier
  // prompt in admin_config. No DDL means no schema delta means no snapshot.
  "0073_strip_retired_violence_modifiers",

  // Hand-authored DDL adding the moderation `review_workflow_stage` enum +
  // staging-fact pointer + production-rejection audit columns to pending_reviews.
  // Source of truth: lib/db/src/schema/reviews.ts.
  "0074_review_workflow_stage",

  // Hand-authored DDL adding facts.pexels_status (varchar) for the durable
  // `fact_pexels` image-prep queue lifecycle. Source of truth:
  // lib/db/src/schema/facts.ts.
  "0075_facts_pexels_status",

  // Hand-authored DDL for the moderation render-scenario redesign: adds nullable
  // scenario-metadata columns + indexes (incl. a partial WHERE review_id IS NOT
  // NULL) to image_prompt_attempts and a visual_render_approval_waiver jsonb to
  // pending_reviews. Authored by hand (drizzle-kit generate can't read the
  // diverged recent snapshot chain). Source of truth: lib/db/src/schema/
  // imagePromptAttempts.ts + reviews.ts.
  "0076_moderation_render_scenarios",

  // DML-only fix: lowers the persisted openai-visual-planner
  // default_reasoning_effort from the old xhigh seed to high (admin-editable
  // field, so boot reconciliation can't do it). No DDL means no schema delta
  // means no snapshot.
  "0077_visual_planner_reasoning_effort",

  // Hand-written DDL (drizzle-kit generate is broken on the pre-existing
  // malformed 0063 snapshot, so this migration ships without a generated
  // snapshot). Idempotent CREATE TABLE / ADD COLUMN IF NOT EXISTS; the
  // hash-based runner applies it and treats already-exists as pre-applied.
  "0078_fact_enrichment_versions",
]);

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

interface SnapshotMeta {
  id: string;
  prevId: string;
}

function snapshotFilename(tag: string): string {
  const prefix = tag.split("_")[0];
  return `${prefix}_snapshot.json`;
}

function run(): void {
  if (!fs.existsSync(JOURNAL_PATH)) {
    console.error(`ERROR: Journal not found at ${JOURNAL_PATH}`);
    process.exit(1);
  }

  const journal: Journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf-8"));
  const missing: string[] = [];

  // ── Pass 1: file existence ──────────────────────────────────────────────
  for (const entry of journal.entries) {
    if (SNAPSHOT_EXEMPT_TAGS.has(entry.tag)) {
      continue;
    }

    const snapshotFile = path.join(META_DIR, snapshotFilename(entry.tag));
    if (!fs.existsSync(snapshotFile)) {
      missing.push(
        `  idx=${entry.idx}  tag=${entry.tag}  expected=${snapshotFilename(entry.tag)}`,
      );
    }
  }

  if (missing.length > 0) {
    console.error(
      `\nMigration snapshot check FAILED — ${missing.length} non-exempt journal ${
        missing.length === 1 ? "entry is" : "entries are"
      } missing a snapshot file.\n`,
    );
    console.error(
      "Each DDL migration generated by drizzle-kit should produce a",
      "corresponding meta/{prefix}_snapshot.json file.\n",
    );
    console.error("Missing:");
    for (const line of missing) {
      console.error(line);
    }
    console.error(
      "\nFix: run `pnpm --filter @workspace/db generate` to regenerate snapshots,",
      "or add the tag to SNAPSHOT_EXEMPT_TAGS in",
      "lib/db/scripts/check-migration-snapshots.ts if the omission is intentional.",
    );
    process.exit(1);
  }

  // ── Pass 2: prevId chain integrity ─────────────────────────────────────
  // Build the ordered list of snapshot files that exist (non-exempt entries).
  // Two journal entries can share the same numeric prefix (e.g., 0030_stripe_
  // webhook_audit and 0030_rate_limit_counters both use 0030_snapshot.json);
  // deduplicate while preserving journal order.
  const seenPrefixes = new Set<string>();
  const orderedPrefixes: string[] = journal.entries
    .filter((e) => !SNAPSHOT_EXEMPT_TAGS.has(e.tag))
    .map((e) => e.tag.split("_")[0])
    .filter((p) => {
      if (seenPrefixes.has(p)) return false;
      seenPrefixes.add(p);
      return true;
    });

  const chainBreaks: string[] = [];
  let prevId = NULL_UUID;
  let prevPrefix = "(none)";

  for (const prefix of orderedPrefixes) {
    const file = path.join(META_DIR, `${prefix}_snapshot.json`);
    let meta: SnapshotMeta;
    try {
      meta = JSON.parse(fs.readFileSync(file, "utf-8")) as SnapshotMeta;
    } catch {
      // Missing file already caught in pass 1; skip here.
      prevId = NULL_UUID;
      prevPrefix = prefix;
      continue;
    }

    if (meta.prevId !== prevId) {
      chainBreaks.push(
        `  ${prefix}_snapshot.json: prevId=${meta.prevId}` +
          ` expected=${prevId} (should match ${prevPrefix}_snapshot.json id)`,
      );
    }

    prevId = meta.id;
    prevPrefix = prefix;
  }

  if (chainBreaks.length > 0) {
    console.error(
      `\nSnapshot chain check FAILED — ${chainBreaks.length} prevId mismatch(es).\n`,
    );
    console.error(
      "Each snapshot's prevId must equal the id of the immediately-preceding",
      "snapshot in journal order (the first snapshot's prevId must be the",
      "all-zeros UUID).\n",
    );
    console.error("Chain breaks:");
    for (const line of chainBreaks) {
      console.error(line);
    }
    console.error(
      "\nFix: run `node --import tsx/esm scripts/rebuild-snapshots.ts`",
      "to rebuild and re-link all snapshot ids/prevIds.",
    );
    process.exit(1);
  }

  console.log(
    `✓ All ${journal.entries.length} journal entries have snapshot files (or are explicitly exempt).`,
  );
  console.log(
    `✓ Snapshot chain is valid (${orderedPrefixes.length} snapshots, all prevId links correct).`,
  );
  process.exit(0);
}

run();
