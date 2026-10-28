/**
 * The legacy-fixture loader (plan D7). Loads a committed fixture into an
 * EMPTY, marked test database, then:
 *
 * - resets every sequence past the fixture's rows, the two standalone
 *   membership sequences included (membershipEntitlements.ts:46-53);
 * - writes each media placeholder through the real storage service (the local
 *   double) with the ACL its producing writer sets (plan D5);
 * - restores the three freshness predicates with the real readers and
 *   re-checks them, failing the load on any row whose outcome differs from the
 *   source's (predicates.ts).
 *
 * The CLI (`scripts/load-legacy-fixture.ts`) refuses before this module is
 * imported: an unmarked database, a production environment, or a storage
 * backend other than the local double. A failed load is not resumed; the
 * target is disposable and is recreated.
 *
 * Order (plan D7): migrations (from the schema baseline) → THIS → the E2E account seed →
 * boot. The account seed comes after because `applyAdminGrant` inserts
 * identity-keyed rows that would collide with the fixture's ids.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { createCanvas } from "@napi-rs/canvas";

import { logger } from "../../lib/logger";
import { memeKey } from "../../lib/storageKeys";
import { includedTables, primaryKey, quoteIdent, sqlColumnRules, sqlName } from "./allowlist";
import type { ExportManifest, Row } from "./export";
import { journalHead } from "./journal";
import { objectPathOf, type MediaPlaceholder } from "./media";

/** Tables whose rows are product configuration: upserted over the migration seed rather than inserted. */
const CONFIG_TABLES = new Set([
  "feature_flags",
  "tier_feature_permissions",
  "entitlement_grid_revision",
  "engines",
  "look_styles",
  "fal_pricing_cache",
  "admin_config",
]);

const CHUNK = 200;

export interface LoadReport {
  rowCounts: Record<string, number>;
  placeholdersWritten: number;
  predicateProblems: string[];
  migrationHeads: { fixture: number; code: number };
}

export function readManifest(fixtureDir: string): ExportManifest {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, "manifest.json"), "utf8")) as ExportManifest;
}

export function readRows(fixtureDir: string, table: string): Row[] {
  const file = path.join(fixtureDir, `${table}.ndjson`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
}

/** Refuses a fixture whose files do not match the digests its manifest records. */
export function verifyFixtureFiles(fixtureDir: string, manifest: ExportManifest): string[] {
  const problems: string[] = [];
  for (const [name, digest] of Object.entries(manifest.files)) {
    const file = path.join(fixtureDir, name);
    if (!fs.existsSync(file)) {
      problems.push(`${name}: missing`);
      continue;
    }
    const actual = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (actual !== digest) problems.push(`${name}: sha256 ${actual} does not match the manifest's ${digest}`);
  }
  return problems;
}

export async function loadFixtureRows(
  fixtureDir: string,
  targetUrl: string,
): Promise<{ manifest: ExportManifest; rowCounts: Record<string, number>; migrationHeads: LoadReport["migrationHeads"] }> {
  const manifest = readManifest(fixtureDir);
  const bad = verifyFixtureFiles(fixtureDir, manifest);
  if (bad.length) throw new Error(`[legacy-fixture] the fixture's files do not match its manifest:\n  ${bad.join("\n  ")}`);

  const client = new pg.Client({ connectionString: targetUrl });
  await client.connect();
  const rowCounts: Record<string, number> = {};
  const journal = journalHead();
  try {
    // The target must be empty of people, facts and memes: the loader inserts the fixture's own ids.
    for (const t of ["users", "facts", "memes"]) {
      const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.${quoteIdent(t)}`);
      if (Number(rows[0]!.n) > 0) throw new Error(`[legacy-fixture] refusing to load: public.${t} already holds rows (load into a fresh database, before the account seed)`);
    }
    // The target must carry every migration this code knows (load order: push, migrate, then this).
    const targetHashes = new Set(
      (await client.query<{ hash: string }>(`SELECT hash FROM drizzle.__drizzle_migrations`).catch(() => ({ rows: [] as Array<{ hash: string }> }))).rows.map((r) => r.hash),
    );
    const missing = journal.hashes.filter((h) => !targetHashes.has(h)).length;
    if (missing > 0) throw new Error(`[legacy-fixture] refusing to load: the target lacks ${missing} of this code's ${journal.entries} migrations (run migrate first)`);
    if (journal.entries !== manifest.migrationHead.journalEntries) {
      logger.warn(
        { fixtureMigrations: manifest.migrationHead.journalEntries, fixtureLatestTag: manifest.migrationHead.latestTag, codeMigrations: journal.entries },
        "[legacy-fixture] the fixture predates this code's migrations; a failed insert below means: re-extract",
      );
    }

    await client.query("BEGIN");
    for (const entry of includedTables()) {
      const table = sqlName(entry.table);
      const rows = readRows(fixtureDir, table);
      rowCounts[table] = rows.length;
      if (rows.length === 0) continue;
      const columns = sqlColumnRules(entry).filter((c) => c.rule !== "drop").map((c) => c.column);
      const colList = columns.map(quoteIdent).join(", ");
      const pk = primaryKey(table);
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        let sql = `INSERT INTO public.${quoteIdent(table)} (${colList}) OVERRIDING SYSTEM VALUE
                   SELECT ${colList} FROM json_populate_recordset(NULL::public.${quoteIdent(table)}, $1::json)`;
        if (CONFIG_TABLES.has(table)) {
          const updates = columns.filter((c) => !pk.includes(c)).map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`);
          sql += ` ON CONFLICT (${pk.map(quoteIdent).join(", ")}) DO ${updates.length ? `UPDATE SET ${updates.join(", ")}` : "NOTHING"}`;
        }
        await client.query(sql, [JSON.stringify(chunk)]);
      }
    }

    // Sequences past the fixture's rows (Astra round 1: "subsequent inserts work").
    // The sequences a column owns, serial ('a') or identity ('i') — what pg_get_serial_sequence answers, in one query.
    const { rows: owned } = await client.query<{ tbl: string; col: string; seq: string }>(
      `SELECT c.relname AS tbl, a.attname AS col, s.oid::regclass::text AS seq
         FROM pg_class s
         JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
         JOIN pg_class c ON c.oid = d.refobjid
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.refobjsubid
        WHERE s.relkind = 'S' AND c.relname = ANY($1::text[])`,
      [includedTables().map((e) => sqlName(e.table))],
    );
    for (const { tbl, col, seq } of owned) {
      await client.query(
        `SELECT setval($1, GREATEST(COALESCE((SELECT max(${quoteIdent(col)}) FROM public.${quoteIdent(tbl)}), 0), 1), (SELECT count(*) > 0 FROM public.${quoteIdent(tbl)}))`,
        [seq],
      );
    }
    await client.query(
      `SELECT setval('membership_source_state_seq', GREATEST(COALESCE((SELECT max(source_state_as_of) FROM public.membership_entitlements), 0), 1), (SELECT count(*) > 0 FROM public.membership_entitlements))`,
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
  return { manifest, rowCounts, migrationHeads: { fixture: manifest.migrationHead.journalEntries, code: journal.entries } };
}

function placeholderBytes(p: { ext: string; width: number; height: number }): { buffer: Buffer; contentType: string } {
  const w = Math.max(1, Math.min(2048, Math.round(p.width)));
  const h = Math.max(1, Math.min(2048, Math.round(p.height)));
  const canvas = createCanvas(w, h);
  const g = canvas.getContext("2d");
  g.fillStyle = "#6b6b6b";
  g.fillRect(0, 0, w, h);
  const ext = p.ext.toLowerCase();
  if (ext === "png") return { buffer: canvas.toBuffer("image/png"), contentType: "image/png" };
  if (ext === "webp") return { buffer: canvas.toBuffer("image/webp"), contentType: "image/webp" };
  if (ext === "gif") return { buffer: canvas.toBuffer("image/png"), contentType: "image/png" }; // a still frame is enough to resolve
  return { buffer: canvas.toBuffer("image/jpeg"), contentType: "image/jpeg" };
}

/** Write every placeholder through the real storage service, with its writer's ACL. Requires STORAGE_BACKEND=local-double. */
export async function writePlaceholders(manifest: ExportManifest): Promise<number> {
  const { ObjectStorageService } = await import("../../lib/objectStorage");
  const storage = new ObjectStorageService();
  // One encoding per (format, size): the fixture's hundreds of placeholders share about ten.
  const encoded = new Map<string, { buffer: Buffer; contentType: string }>();
  const write = async (objectPath: string, p: { ext: string; width: number; height: number }, acl: MediaPlaceholder["acl"]) => {
    const key = `${p.ext}:${p.width}x${p.height}`;
    let bytes = encoded.get(key);
    if (!bytes) encoded.set(key, (bytes = placeholderBytes(p)));
    const { buffer, contentType } = bytes;
    const subPath = objectPath.replace(/^\/objects\//, "");
    await storage.uploadObjectBuffer({ subPath, buffer, contentType });
    if (acl) await storage.trySetObjectEntityAclPolicy(objectPath, acl);
  };
  let n = 0;
  for (const p of manifest.placeholders) {
    // A reference may carry the route prefix the product stores (`/api/storage/objects/...`, routes/users.ts:326).
    const objectPath = objectPathOf(p.path);
    if (!objectPath) throw new Error(`[legacy-fixture] a placeholder outside /objects/ cannot be written: ${p.kind}`);
    await write(objectPath, p, p.acl);
    n++;
  }
  // Legacy memes (no recipe): the image route reads memeKey(slug) (routes/memes.ts:609-633); saved memes are public, owned by their creator.
  for (const m of manifest.legacyMemeImages) {
    await write(`/objects/${memeKey(m.slug, "jpg")}`, { ext: "jpg", width: 64, height: 64 }, m.owner ? { owner: m.owner, visibility: "public" } : null);
    n++;
  }
  return n;
}

/** The whole load. DATABASE_URL must name the target: the predicate pass runs the app's own readers against it. */
export async function loadLegacyFixture(fixtureDir: string, targetUrl: string): Promise<LoadReport> {
  const { manifest, rowCounts, migrationHeads } = await loadFixtureRows(fixtureDir, targetUrl);
  const placeholdersWritten = await writePlaceholders(manifest);
  const { comparePredicates, evaluatePredicates, restorePredicates } = await import("./predicates");
  const restoreProblems = await restorePredicates(manifest.predicates);
  const actual = await evaluatePredicates();
  const predicateProblems = [...restoreProblems, ...comparePredicates(manifest.predicates, actual)];
  return { rowCounts, placeholdersWritten, predicateProblems, migrationHeads };
}
