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
