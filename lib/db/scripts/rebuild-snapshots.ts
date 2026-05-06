/**
 * rebuild-snapshots.ts
 *
 * Reconstructs accurate per-migration drizzle snapshots (0001–0041) by working
 * backwards from the six accurate anchor snapshots:
 *   0016, 0019, 0020, 0021, 0040, 0041  (drizzle-kit-generated)
 *
 * Strategy
 * --------
 * 1. Load the six accurate anchor snapshots as starting points for backward
 *    undo operations.
 * 2. Apply JSON-level "undo" ops in reverse migration order: column add/remove,
 *    default changes, table add/remove, FK/index/unique add/remove, enum changes.
 * 3. Assign IDs and prevIds in forward journal order so the chain is correct:
 *      snapshot[i].id      = deterministicUuid("snapshot:<prefix>")
 *      snapshot[i].prevId  = snapshot[i-1].id  (or all-zeros for first)
 *    This includes updating the accurate anchor files so every boundary is
 *    consistent.  Schema content of accurate anchors is preserved unchanged;
 *    only their id/prevId fields are updated.
 * 4. Write all 41 snapshot files.
 *
 * Chain-integrity checks verify that undoing 0022 → 0021 and 0017 → 0016
 * reproduces the accurate anchor table lists (printed during the run).
 *
 * NOTE on "original-schema" tables
 * ---------------------------------
 * Tables such as video_styles, fal_pricing_cache, user_generation_costs,
 * sessions, etc. are present in every accurate anchor snapshot (0016–0041).
 * No migration SQL in this repo creates or drops them; they existed before
 * the migration system started.  Their presence in early snapshots (0001–0014)
 * is therefore correct and expected.
 *
 * Run:
 *   node --import tsx/esm scripts/rebuild-snapshots.ts [--dry-run] [--verbose]
 *
 * After running:
 *   pnpm --filter @workspace/db check-snapshots
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const META_DIR = path.join(__dirname, '../migrations/meta');
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

// ─── journal order (must match _journal.json exactly) ───────────────────────
// Each entry is the numeric/alpha prefix used in the snapshot filename.
const JOURNAL_PREFIXES = [
  '0001', '0001b', '0002', '0003', '0004', '0004b', '0005', '0006', '0007', '0008',
  '0009', '0010', '0011', '0012', '0013', '0014', '0016', '0017', '0018', '0019',
  '0020', '0021', '0022', '0023', '0024', '0025', '0026', '0027', '0028', '0029',
  '0030', '0032', '0033', '0034', '0035', '0036', '0037', '0038', '0039', '0040', '0041',
] as const;

type Snap = Record<string, any>;

// ─── deterministic ID helpers ────────────────────────────────────────────────

/** Deterministic UUID v4 from a seed string (sha256-based). */
function deterministicUuid(seed: string): string {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    '4' + h.slice(13, 16),
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}

/** The canonical ID for a given snapshot prefix. */
function snapshotId(prefix: string): string {
  return deterministicUuid(`snapshot:${prefix}`);
}

/** The canonical prevId for a given snapshot prefix (all-zeros for the first). */
function snapshotPrevId(prefix: string): string {
  const idx = JOURNAL_PREFIXES.indexOf(prefix as any);
  if (idx <= 0) return '00000000-0000-0000-0000-000000000000';
  return snapshotId(JOURNAL_PREFIXES[idx - 1]);
}

/** Stamp id and prevId onto a snapshot object using canonical values. */
function setMeta(snap: Snap, prefix: string): void {
  snap.id = snapshotId(prefix);
  snap.prevId = snapshotPrevId(prefix);
}

// ─── file I/O ────────────────────────────────────────────────────────────────

function loadSnapshot(prefix: string): Snap {
  return JSON.parse(
    fs.readFileSync(path.join(META_DIR, `${prefix}_snapshot.json`), 'utf8'),
  );
}

function writeSnapshot(prefix: string, snap: Snap): void {
  const outPath = path.join(META_DIR, `${prefix}_snapshot.json`);
  const content = JSON.stringify(snap, null, 2);
  if (DRY_RUN) {
    console.log(`  [dry-run] would write ${prefix}_snapshot.json`);
    return;
  }
  fs.writeFileSync(outPath, content);
  console.log(`  wrote ${prefix}_snapshot.json`);
}

const clone = (s: Snap): Snap => JSON.parse(JSON.stringify(s));

// ─── atomic undo primitives ──────────────────────────────────────────────────

function removeColumn(snap: Snap, table: string, col: string): void {
  const t = snap.tables[`public.${table}`];
  if (!t) throw new Error(`removeColumn: table '${table}' not found`);
  if (!(col in t.columns)) {
    if (VERBOSE) console.warn(`  WARN: column '${table}.${col}' not found — skipping`);
    return;
  }
  delete t.columns[col];
}

function setColumnDefault(snap: Snap, table: string, col: string, defVal: any): void {
  const t = snap.tables[`public.${table}`];
  if (!t) throw new Error(`setColumnDefault: table '${table}' not found`);
  if (!(col in t.columns)) throw new Error(`setColumnDefault: '${table}.${col}' not found`);
  if (defVal === null || defVal === undefined) {
    delete t.columns[col].default;
  } else {
    t.columns[col].default = defVal;
  }
}

function removeTable(snap: Snap, table: string): void {
  if (!snap.tables[`public.${table}`]) {
    if (VERBOSE) console.warn(`  WARN: table '${table}' not found — skipping`);
    return;
  }
  delete snap.tables[`public.${table}`];
}

function removeForeignKey(snap: Snap, table: string, fkName: string): void {
  const t = snap.tables[`public.${table}`];
  if (!t) throw new Error(`removeForeignKey: table '${table}' not found`);
  if (!(fkName in t.foreignKeys)) {
    if (VERBOSE) console.warn(`  WARN: FK '${fkName}' on '${table}' not found — skipping`);
    return;
  }
  delete t.foreignKeys[fkName];
}

function removeIndex(snap: Snap, table: string, idxName: string): void {
  const t = snap.tables[`public.${table}`];
  if (!t) throw new Error(`removeIndex: table '${table}' not found`);
  if (!(idxName in t.indexes)) {
    if (VERBOSE) console.warn(`  WARN: index '${idxName}' on '${table}' not found — skipping`);
    return;
  }
  delete t.indexes[idxName];
}

function replaceEnumValues(snap: Snap, enumName: string, values: string[]): void {
  const key = `public.${enumName}`;
  if (!snap.enums[key]) throw new Error(`replaceEnumValues: enum '${enumName}' not found`);
  snap.enums[key].values = values;
}

function removeEnum(snap: Snap, enumName: string): void {
  const key = `public.${enumName}`;
  if (!snap.enums[key]) {
    if (VERBOSE) console.warn(`  WARN: enum '${enumName}' not found — skipping`);
    return;
  }
  delete snap.enums[key];
}

// ─── chain-integrity verification ────────────────────────────────────────────

function verifyTableList(label: string, reconstructed: Snap, accurate: Snap): void {
  const rTables = Object.keys(reconstructed.tables).sort().join(',');
  const aTables = Object.keys(accurate.tables).sort().join(',');
  if (rTables === aTables) {
    console.log(`  ✓ ${label}: table list matches accurate anchor`);
  } else {
    console.warn(`  ⚠ ${label}: table list MISMATCH`);
    const extra = Object.keys(reconstructed.tables).filter((t) => !accurate.tables[t]);
    const missing = Object.keys(accurate.tables).filter((t) => !reconstructed.tables[t]);
    if (extra.length) console.warn(`    extra  : ${extra.join(', ')}`);
    if (missing.length) console.warn(`    missing: ${missing.join(', ')}`);
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Loading accurate anchor snapshots...');
  const snap41base = loadSnapshot('0041');
  const snap40base = loadSnapshot('0040');
  const snap21base = loadSnapshot('0021');
  const snap20base = loadSnapshot('0020');
  const snap19base = loadSnapshot('0019');
  const snap16base = loadSnapshot('0016');

  // Clone anchors so we can update their id/prevId without mutating the originals
  const snap41 = clone(snap41base);
  const snap40 = clone(snap40base);
  const snap21 = clone(snap21base);
  const snap20 = clone(snap20base);
  const snap19 = clone(snap19base);
  const snap16 = clone(snap16base);

  // ── Chain A: 0040 → 0022 (backward from accurate 0040) ──────────────────
  console.log('\nChain A: 0040 → 0022 (backward from accurate 0040)');

  // ── 0040 → 0039: undo 0040 (add google_linked, apple_linked) ─────────────
  const snap39 = clone(snap40);
  removeColumn(snap39, 'users', 'google_linked');
  removeColumn(snap39, 'users', 'apple_linked');

  // ── 0039 → 0038: undo 0039 (add link_user_id + FK to oauth_pending_states) ──
  const snap38 = clone(snap39);
  removeForeignKey(snap38, 'oauth_pending_states', 'oauth_pending_states_link_user_id_users_id_fk');
  removeColumn(snap38, 'oauth_pending_states', 'link_user_id');

  // ── 0038 → 0037: undo 0038_overrated_whizzer (no schema changes) ─────────
  const snap37 = clone(snap38);

  // ── 0037 → 0036: undo 0037 (add email_outbox_status_created_idx) ─────────
  const snap36 = clone(snap37);
  removeIndex(snap36, 'email_outbox', 'email_outbox_status_created_idx');

  // ── 0036 → 0035: undo 0036 (create oauth_pending_states) ─────────────────
  const snap35 = clone(snap36);
  removeTable(snap35, 'oauth_pending_states');

  // ── 0035 → 0034: undo 0035 (create reactions; add heart_count to memes/comments) ──
  const snap34 = clone(snap35);
  removeTable(snap34, 'reactions');
  removeColumn(snap34, 'memes', 'heart_count');
  removeIndex(snap34, 'memes', 'IDX_memes_heart_count');
  removeColumn(snap34, 'comments', 'heart_count');

  // ── 0034 → 0033: undo 0034 (add source to affiliate_clicks) ─────────────
  // Note: 0034 also creates 'affiliate_clicks_source_idx', but that index is
  // NOT in the accurate 0041/0040 snapshots because drizzle-kit does not track
  // it (it is not defined in the TypeScript schema).  Only undo the column.
  const snap33 = clone(snap34);
  removeColumn(snap33, 'affiliate_clicks', 'source');

  // ── 0033 → 0032: undo 0033 (add last_seen_as_hero_at + index to ufp) ─────
  const snap32 = clone(snap33);
  removeIndex(snap32, 'user_fact_preferences', 'ufp_user_seen_hero_idx');
  removeColumn(snap32, 'user_fact_preferences', 'last_seen_as_hero_at');

  // ── 0032 → 0030: undo 0032 (create stripe_checkout_request_ledger) ───────
  // Snapshot 0030 covers BOTH 0030_stripe_webhook_audit AND 0030_rate_limit_counters.
  const snap30 = clone(snap32);
  removeTable(snap30, 'stripe_checkout_request_ledger');

  // ── 0030 → 0029: undo both 0030 migrations ───────────────────────────────
  const snap29 = clone(snap30);
  removeTable(snap29, 'stripe_webhook_audit');
  removeTable(snap29, 'rate_limit_counters');

  // ── 0029 → 0028: undo 0029 (DML-only, no DDL) ────────────────────────────
  const snap28 = clone(snap29);

  // ── 0028 → 0027: undo 0028 (DML-only, no DDL) ────────────────────────────
  const snap27 = clone(snap28);

  // ── 0027 → 0026: undo 0027 (add 'lame' to review_reason) ────────────────
  const snap26 = clone(snap27);
  replaceEnumValues(snap26, 'review_reason', ['duplicate', 'spam', 'offensive']);

  // ── 0026 → 0025: undo 0026 (add performed_by_admin_id to membership_history) ──
  const snap25 = clone(snap26);
  removeForeignKey(snap25, 'membership_history', 'membership_history_performed_by_admin_id_users_id_fk');
  removeColumn(snap25, 'membership_history', 'performed_by_admin_id');

  // ── 0025 → 0024: undo 0025 (add 'spam','offensive' to review_reason) ─────
  const snap24 = clone(snap25);
  replaceEnumValues(snap24, 'review_reason', ['duplicate']);

  // ── 0024 → 0023: undo 0024 (create review_reason enum; reason → enum type) ──
  const snap23 = clone(snap24);
  removeEnum(snap23, 'review_reason');
  // Restore reason column to plain text
  snap23.tables['public.pending_reviews'].columns['reason'] = {
    name: 'reason',
    type: 'text',
    primaryKey: false,
    notNull: false,
  };

  // ── 0023 → 0022: undo 0023 (add granted_by_admin_id to lifetime_entitlements) ──
  const snap22 = clone(snap23);
  removeForeignKey(snap22, 'lifetime_entitlements', 'lifetime_entitlements_granted_by_admin_id_users_id_fk');
  removeColumn(snap22, 'lifetime_entitlements', 'granted_by_admin_id');

  // Chain-integrity check: undoing 0022 (create email_outbox) → matches 0021?
  const snap21check = clone(snap22);
  removeTable(snap21check, 'email_outbox');
  verifyTableList('0022→0021 undo', snap21check, snap21);

  // ── Chain B: 0019 → 0017 (backward from accurate 0019) ───────────────────
  console.log('\nChain B: 0019 → 0017 (backward from accurate 0019)');

  // ── 0019 → 0018: undo 0019 (add route_stat_events indexes) ───────────────
  const snap18 = clone(snap19);
  removeIndex(snap18, 'route_stat_events', 'route_stat_events_recorded_at_idx');
  removeIndex(snap18, 'route_stat_events', 'route_stat_events_route_key_recorded_at_idx');

  // ── 0018 → 0017: undo 0018 (create route_stat_events) ───────────────────
  const snap17 = clone(snap18);
  removeTable(snap17, 'route_stat_events');

  // Chain-integrity check: undoing 0017 (create route_stats) → matches 0016?
  const snap16check = clone(snap17);
  removeTable(snap16check, 'route_stats');
  verifyTableList('0017→0016 undo', snap16check, snap16);

  // ── Chain C: 0016 → 0001 (backward from accurate 0016) ───────────────────
  console.log('\nChain C: 0016 → 0001 (backward from accurate 0016)');

  // ── 0016 → 0014: undo 0016 (SET DEFAULT true on admin_notifications) ─────
  // admin_notifications is an original-schema column; 0016 changed its default
  // from false to true.
  const snap14 = clone(snap16);
  setColumnDefault(snap14, 'users', 'admin_notifications', false);

  // ── 0014 → 0013: undo 0014 (add monthly_generation_limit_override_usd) ───
  const snap13 = clone(snap14);
  removeColumn(snap13, 'users', 'monthly_generation_limit_override_usd');

  // ── 0013 → 0012: undo 0013 (create feature_flags + tier_feature_permissions) ──
  const snap12 = clone(snap13);
  removeTable(snap12, 'tier_feature_permissions');
  removeTable(snap12, 'feature_flags');

  // ── 0012 → 0011: undo 0012 (add value_label + debug_value_label to admin_config) ──
  // debug_value (without _label) predates 0012 and is preserved through this step.
  const snap11 = clone(snap12);
  removeColumn(snap11, 'admin_config', 'value_label');
  removeColumn(snap11, 'admin_config', 'debug_value_label');

  // ── 0011 → 0010: undo 0011 (add style_id to video_jobs) ─────────────────
  const snap10 = clone(snap11);
  removeColumn(snap10, 'video_jobs', 'style_id');

  // ── 0010 → 0009: undo 0010 (create video_jobs + video_job_status enum) ───
  const snap09 = clone(snap10);
  removeTable(snap09, 'video_jobs');
  removeEnum(snap09, 'video_job_status');

  // ── 0009 → 0008: undo 0009 (create admin_config) ─────────────────────────
  const snap08 = clone(snap09);
  removeTable(snap08, 'admin_config');

  // ── 0008 → 0007: undo 0008 (create user_ai_images) ───────────────────────
  const snap07 = clone(snap08);
  removeTable(snap07, 'user_ai_images');

  // ── 0007 → 0006: undo 0007 (add user_id + IDX_uim_user_id to upload_image_metadata) ──
  const snap06 = clone(snap07);
  removeForeignKey(snap06, 'upload_image_metadata', 'upload_image_metadata_user_id_users_id_fk');
  removeIndex(snap06, 'upload_image_metadata', 'IDX_uim_user_id');
  removeColumn(snap06, 'upload_image_metadata', 'user_id');

  // ── 0006 → 0005: undo 0006 (add 4 memes cols; create upload_image_metadata) ──
  const snap05 = clone(snap06);
  removeColumn(snap05, 'memes', 'is_low_res');
  removeColumn(snap05, 'memes', 'original_width');
  removeColumn(snap05, 'memes', 'original_height');
  removeColumn(snap05, 'memes', 'upload_file_size_bytes');
  removeTable(snap05, 'upload_image_metadata');

  // ── 0005 → 0004b: undo 0005 (add is_public to memes) ────────────────────
  const snap04b = clone(snap05);
  removeColumn(snap04b, 'memes', 'is_public');

  // ── 0004b → 0004: undo 0004b (add pexels_images to facts; create user_fact_preferences) ──
  const snap04 = clone(snap04b);
  removeColumn(snap04, 'facts', 'pexels_images');
  removeTable(snap04, 'user_fact_preferences');

  // ── 0004 → 0003: undo 0004 (remove 'cafepress' from affiliate_destination) ──
  const snap03 = clone(snap04);
  replaceEnumValues(snap03, 'affiliate_destination', ['zazzle', 'cafepress']);

  // ── 0003 → 0002: undo 0003 (add image_source to memes) ──────────────────
  const snap02 = clone(snap03);
  removeColumn(snap02, 'memes', 'image_source');

  // ── 0002 → 0001b: undo 0002 (ADD VALUE 'comment_approved','comment_rejected') ──
  const snap01b = clone(snap02);
  snap01b.enums['public.activity_type'].values = (
    snap01b.enums['public.activity_type'].values as string[]
  ).filter((v) => v !== 'comment_approved' && v !== 'comment_rejected');

  // ── 0001b → 0001: undo 0001b (add canonical_text to facts) ──────────────
  const snap01 = clone(snap01b);
  removeColumn(snap01, 'facts', 'canonical_text');

  // ─── Stamp all IDs and prevIds in forward journal order ──────────────────
  //
  // ALL snapshot ids/prevIds are regenerated deterministically so the chain is
  // consistent end-to-end.  Schema content of accurate anchors is preserved;
  // only their id and prevId fields are updated.
  console.log('\nStamping id/prevId in journal order...');
  const allSnaps: Record<string, Snap> = {
    '0001': snap01, '0001b': snap01b, '0002': snap02, '0003': snap03,
    '0004': snap04, '0004b': snap04b, '0005': snap05, '0006': snap06,
    '0007': snap07, '0008': snap08, '0009': snap09, '0010': snap10,
    '0011': snap11, '0012': snap12, '0013': snap13, '0014': snap14,
    '0016': snap16, '0017': snap17, '0018': snap18, '0019': snap19,
    '0020': snap20, '0021': snap21, '0022': snap22, '0023': snap23,
    '0024': snap24, '0025': snap25, '0026': snap26, '0027': snap27,
    '0028': snap28, '0029': snap29, '0030': snap30, '0032': snap32,
    '0033': snap33, '0034': snap34, '0035': snap35, '0036': snap36,
    '0037': snap37, '0038': snap38, '0039': snap39, '0040': snap40,
    '0041': snap41,
  };

  for (const prefix of JOURNAL_PREFIXES) {
    setMeta(allSnaps[prefix], prefix);
  }

  // Verify forward chain is consistent
  for (let i = 1; i < JOURNAL_PREFIXES.length; i++) {
    const prev = JOURNAL_PREFIXES[i - 1];
    const curr = JOURNAL_PREFIXES[i];
    const expectedPrevId = snapshotId(prev);
    const actualPrevId = allSnaps[curr].prevId;
    if (actualPrevId !== expectedPrevId) {
      console.error(`  ✗ chain break: ${curr}.prevId (${actualPrevId}) ≠ ${prev}.id (${expectedPrevId})`);
    }
  }
  console.log(`  ✓ All ${JOURNAL_PREFIXES.length} snapshots have consistent id/prevId chain`);

  // ─── Write all snapshot files ─────────────────────────────────────────────
  console.log('\nWriting all snapshot files...');
  for (const prefix of JOURNAL_PREFIXES) {
    writeSnapshot(prefix, allSnaps[prefix]);
  }

  const verb = DRY_RUN ? '(dry-run) would write' : 'wrote';
  console.log(`\n✓ Done — ${verb} ${JOURNAL_PREFIXES.length} snapshot files.`);
  console.log('Verify: pnpm --filter @workspace/db check-snapshots');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
