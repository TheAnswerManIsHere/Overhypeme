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
 * Order (plan D7): schema push → migrations → THIS → the E2E account seed →
 * boot. The account seed comes after because `applyAdminGrant` inserts
 * identity-keyed rows that would collide with the fixture's ids.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import { createCanvas } from "@napi-rs/canvas";

import { memeKey } from "../../lib/storageKeys";
import { includedTables, sqlColumnRules, sqlName } from "./allowlist";
import type { ExportManifest, Row } from "./export";
import type { MediaPlaceholder } from "./media";

/** Tables whose rows are product configuration: upserted over the migration seed rather than inserted. */
const CONFIG_TABLES = new Set([
  "feature_flags",
  "tier_feature_permissions",
  "entitlement_grid_revision",
  "engines",
  "look_styles",
  "motion_presets",
  "hero_examples",
  "fal_pricing_cache",
  "admin_config",
]);

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const CHUNK = 200;

export interface LoadReport {
  rowCounts: Record<string, number>;
  placeholdersWritten: number;
  predicateProblems: string[];
  migrationHeads: { fixture: number; target: number };
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

function primaryKeyColumns(table: (typeof includedTables extends () => Array<infer E> ? E : never)["table"]): string[] {
  const cfg = getTableConfig(table);
  const composite = cfg.primaryKeys[0]?.columns.map((c) => c.name);
  return composite ?? cfg.columns.filter((c) => c.primary).map((c) => c.name);
}

export async function loadFixtureRows(fixtureDir: string, targetUrl: string): Promise<{ rowCounts: Record<string, number>; migrationHeads: { fixture: number; target: number } }> {
  const manifest = readManifest(fixtureDir);
  const bad = verifyFixtureFiles(fixtureDir, manifest);
  if (bad.length) throw new Error(`[legacy-fixture] the fixture's files do not match its manifest:\n  ${bad.join("\n  ")}`);

  const client = new pg.Client({ connectionString: targetUrl });
  await client.connect();
  const rowCounts: Record<string, number> = {};
  let targetHead = 0;
  try {
    // The target must be empty of people, facts and memes: the loader inserts the fixture's own ids.
    for (const t of ["users", "facts", "memes"]) {
      const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.${quoteIdent(t)}`);
      if (Number(rows[0]!.n) > 0) throw new Error(`[legacy-fixture] refusing to load: public.${t} already holds rows (load into a fresh database, before the account seed)`);
    }
    targetHead = Number(
      (await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations`).catch(() => ({ rows: [{ n: "0" }] }))).rows[0]!.n,
    );
    if (targetHead !== manifest.migrationHead.count) {
      console.warn(`[legacy-fixture] migration ledgers differ: the fixture was taken at ${manifest.migrationHead.count} migrations, the target has ${targetHead}. A failed insert below means: re-extract.`);
    }

    await client.query("BEGIN");
    for (const entry of includedTables()) {
      const table = sqlName(entry.table);
      const rows = readRows(fixtureDir, table);
      rowCounts[table] = rows.length;
      if (rows.length === 0) continue;
      const columns = sqlColumnRules(entry).filter((c) => c.rule !== "drop").map((c) => c.column);
      const colList = columns.map(quoteIdent).join(", ");
      const pk = primaryKeyColumns(entry.table);
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
    for (const entry of includedTables()) {
      const table = sqlName(entry.table);
      for (const c of getTableConfig(entry.table).columns) {
        const { rows } = await client.query<{ seq: string | null }>(`SELECT pg_get_serial_sequence($1, $2) AS seq`, [`public.${quoteIdent(table)}`, c.name]);
        const seq = rows[0]?.seq;
        if (!seq) continue;
        await client.query(
          `SELECT setval($1, GREATEST(COALESCE((SELECT max(${quoteIdent(c.name)}) FROM public.${quoteIdent(table)}), 0), 1), (SELECT count(*) > 0 FROM public.${quoteIdent(table)}))`,
          [seq],
        );
      }
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
  return { rowCounts, migrationHeads: { fixture: manifest.migrationHead.count, target: targetHead } };
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
  const write = async (objectPath: string, p: { ext: string; width: number; height: number }, acl: MediaPlaceholder["acl"]) => {
    const { buffer, contentType } = placeholderBytes(p);
    const subPath = objectPath.replace(/^\/objects\//, "");
    await storage.uploadObjectBuffer({ subPath, buffer, contentType });
    if (acl) await storage.trySetObjectEntityAclPolicy(objectPath, acl);
  };
  let n = 0;
  for (const p of manifest.placeholders) {
    if (!p.path.startsWith("/objects/")) throw new Error(`[legacy-fixture] a placeholder outside /objects/ cannot be written: ${p.kind}`);
    await write(p.path, p, p.acl);
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
  const { rowCounts, migrationHeads } = await loadFixtureRows(fixtureDir, targetUrl);
  const manifest = readManifest(fixtureDir);
  const placeholdersWritten = await writePlaceholders(manifest);
  const { comparePredicates, evaluatePredicates, restorePredicates } = await import("./predicates");
  const restoreProblems = await restorePredicates(manifest.predicates);
  const actual = await evaluatePredicates();
  const predicateProblems = [...restoreProblems, ...comparePredicates(manifest.predicates, actual)];
  return { rowCounts, placeholdersWritten, predicateProblems, migrationHeads };
}
