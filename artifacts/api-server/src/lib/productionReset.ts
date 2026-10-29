/**
 * @purpose Prepares production's reset from the workspace, through an operator-held connection: refuses while any other session is connected, takes the final capture and proves it restores, inventories it, writes a permanent write-once case record of every child-safety row with the rows they reference and an evidence manifest, and stops the reset when those rows differ from dev's.
 * @subsystem data-lifecycle
 *
 * Launch Phase 3, increment 8, plan amendment 1, Part A and Part C step 2
 * (docs/plans/PLAN_PHASE3_AMENDMENT_1.md, approved by David 2026-10-29). David
 * chose (D2) to leave production's child-safety copies behind: dev's rows are
 * the authoritative handling copy, which is possible only because production's
 * are byte-identical to them. So the equality check here is what lets the
 * reset proceed, and any difference stops it before the database is removed.
 *
 * What it writes, and only this, under `cases/production-reset-<resetId>/` in
 * the backup bucket, which backup expiry never deletes (mediaBackup/expiry.ts):
 *   - `final-capture.dump`, the pg_dump of production taken here;
 *   - `record.json`, the case record, with a sha256 over its body.
 * Both are written once (ifGenerationMatch: 0) and read back. Evidence bytes
 * are never read or copied: the manifest records what the store reports about
 * each object (size, md5 where the store gives one, generation).
 *
 * Production itself is only read. The restore check runs in a scratch
 * database on dev's server, dropped at the end with the dump's working copy.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

import type { File } from "@google-cloud/storage";

import { databaseName, databaseUrl } from "./devRebuild.js";
import { ObjectStorageService } from "./objectStorage.js";
import { pgCommandConnection, withoutPassword } from "./pgCommandLine.js";
import { storageClient } from "./storageClient.js";

/** The child-safety tables, and the columns holding each row's evidence path. */
export const CHILD_SAFETY_TABLES: Record<string, string[]> = {
  ncmec_reports: ["evidence_uri"],
  quarantined_memes: ["evidence_object_path"],
  ncmec_safety_audit_log: [],
};

export const CASES_PREFIX = "cases/";

type Row = Record<string, unknown>;

export interface OtherSession {
  pid: number;
  user: string | null;
  application: string | null;
  client: string | null;
  state: string | null;
}

export interface EvidenceEntry {
  path: string;
  present: boolean;
  size: number | null;
  md5: string | null;
  generation: string | null;
}

export interface CaseRecord {
  kind: "production-reset-case-record";
  resetId: string;
  capture: { database: string; takenAt: string; dumpKey: string; dumpSha256: string; bytes: number };
  /** Every child-safety row, complete, with its row hash (md5 of to_jsonb, as dev's comparison uses). */
  childSafety: Record<string, Array<{ hash: string; row: Row }>>;
  /** Every row the child-safety rows reference, transitively, by foreign key. */
  referenced: Record<string, Row[]>;
  evidence: EvidenceEntry[];
  inventory: unknown;
  /** Where the cases are handled after the reset (D2). */
  handling: string;
}

export interface TableDifference {
  table: string;
  onlyInProduction: string[];
  onlyInDev: string[];
}

export interface ResetPrepareReport {
  resetId: string;
  verdict: "pass" | "fail";
  reasons: string[];
  otherSessions: OtherSession[];
  capture: CaseRecord["capture"] | null;
  recordKey: string | null;
  recordSha256: string | null;
  inventory: unknown;
  evidence: EvidenceEntry[];
  childSafetyCounts: Record<string, number>;
  referencedCounts: Record<string, number>;
  differencesFromDev: TableDifference[];
}

export interface ResetPrepareOptions {
  /** RESET_PRODUCTION_DATABASE_URL: production, read only. */
  productionUrl: string;
  /** Dev's database (the handling copy), on the server that also hosts the scratch restore. */
  devUrl: string;
  backup: string;
  /** Names the case directory; one reset, one id. */
  resetId: string;
  workDir: string;
  /** Inventories the restored capture; the script runs excluded-classes-inventory.ts against it. */
  inventory: (scratchUrl: string) => Promise<{ verdict?: { blocksReplacement?: boolean; reasons?: string[] } }>;
  now?: () => Date;
}

const D2_HANDLING =
  "Left behind (David, 2026-10-29, D2): production's copies are not carried; dev's rows are the authoritative handling copy, handled by the operator, David.";

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => {});
  await c.connect();
  return c;
}

const sha256 = (b: Buffer | string): string => crypto.createHash("sha256").update(b).digest("hex");

/** Every other client connected to the database at `url` — a writer that would make a final capture not final. */
export async function otherSessions(url: string): Promise<OtherSession[]> {
  const c = await connect(url);
  try {
    const { rows } = await c.query<{ pid: number; u: string | null; a: string | null; cl: string | null; s: string | null }>(
      `SELECT pid, usename AS u, application_name AS a, client_addr::text AS cl, state AS s FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend' ORDER BY pid`,
    );
    return rows.map((r) => ({ pid: r.pid, user: r.u, application: r.a || null, client: r.cl, state: r.s }));
  } finally {
    await c.end();
  }
}

async function tableExists(c: pg.ClientBase, table: string): Promise<boolean> {
  const { rows } = await c.query<{ p: boolean }>("SELECT to_regclass($1) IS NOT NULL AS p", [`public.${table}`]);
  return rows[0]?.p === true;
}

/** Each child-safety table's rows with their hashes, sorted by hash. A table the database lacks has none. */
export async function childSafetyRows(c: pg.ClientBase): Promise<Record<string, Array<{ hash: string; row: Row }>>> {
  const out: Record<string, Array<{ hash: string; row: Row }>> = {};
  for (const table of Object.keys(CHILD_SAFETY_TABLES)) {
    out[table] = (await tableExists(c, table))
      ? (await c.query<{ hash: string; row: Row }>(`SELECT md5(to_jsonb(t)::text) AS hash, to_jsonb(t) AS row FROM public."${table}" t ORDER BY 1`)).rows
      : [];
  }
  return out;
}

interface ForeignKey {
  table: string;
  columns: string[];
  target: string;
  targetColumns: string[];
}

async function foreignKeys(c: pg.ClientBase): Promise<ForeignKey[]> {
  const { rows } = await c.query<{ t: string; cols: string[]; rt: string; rcols: string[] }>(
    `SELECT cl.relname AS t, rc.relname AS rt,
            array(SELECT a.attname FROM unnest(co.conkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = co.conrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS cols,
            array(SELECT a.attname FROM unnest(co.confkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = co.confrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS rcols
     FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_class rc ON rc.oid = co.confrelid
     WHERE co.contype = 'f' AND cl.relnamespace = 'public'::regnamespace AND rc.relnamespace = 'public'::regnamespace`,
  );
  return rows.map((r) => ({ table: r.t, columns: r.cols, target: r.rt, targetColumns: r.rcols }));
}

/**
 * Every row the given rows reference, followed transitively through foreign
 * keys. Matching is on jsonb values, so a key of any type compares as stored.
 */
export async function referencedRows(c: pg.ClientBase, start: Record<string, Row[]>): Promise<Record<string, Row[]>> {
  const fks = await foreignKeys(c);
  const seen = new Map<string, Set<string>>();
  const found: Record<string, Row[]> = {};
  const mark = (table: string, row: Row): boolean => {
    const key = JSON.stringify(row);
    let s = seen.get(table);
    if (!s) seen.set(table, (s = new Set()));
    if (s.has(key)) return false;
    s.add(key);
    return true;
  };
  for (const [table, rows] of Object.entries(start)) for (const row of rows) mark(table, row);

  let frontier = Object.entries(start).flatMap(([table, rows]) => rows.map((row) => ({ table, row })));
  while (frontier.length > 0) {
    const next: Array<{ table: string; row: Row }> = [];
    for (const fk of fks) {
      const keys = new Set<string>();
      for (const { table, row } of frontier) {
        if (table !== fk.table) continue;
        const values = fk.columns.map((col) => row[col] ?? null);
        if (values.some((v) => v === null)) continue;
        keys.add(JSON.stringify(values));
      }
      if (keys.size === 0) continue;
      const tuple = fk.targetColumns.map((col) => `t."${col}"`).join(", ");
      const { rows } = await c.query<{ row: Row }>(
        `SELECT to_jsonb(t) AS row FROM public."${fk.target}" t WHERE jsonb_build_array(${tuple}) = ANY($1::jsonb[])`,
        [[...keys]],
      );
      for (const { row } of rows) {
        if (!mark(fk.target, row)) continue;
        (found[fk.target] ??= []).push(row);
        next.push({ table: fk.target, row });
      }
    }
    frontier = next;
  }
  return found;
}

/** What the store reports about each evidence object. The bytes are never read. */
async function evidenceManifest(paths: string[]): Promise<EvidenceEntry[]> {
  const service = new ObjectStorageService();
  const out: EvidenceEntry[] = [];
  for (const p of [...new Set(paths)].sort()) {
    let file: File;
    try {
      file = await service.getObjectEntityFile(p);
    } catch {
      out.push({ path: p, present: false, size: null, md5: null, generation: null });
      continue;
    }
    const [meta] = await file.getMetadata();
    const m = meta as { size?: number | string; md5Hash?: string; generation?: number | string };
    out.push({
      path: p,
      present: true,
      size: m.size === undefined ? null : Number(m.size),
      md5: m.md5Hash ?? null,
      generation: m.generation === undefined ? null : String(m.generation),
    });
  }
  return out;
}

/** Rows whose hash is on one side only, per child-safety table. */
export function differences(
  production: Record<string, Array<{ hash: string }>>,
  dev: Record<string, Array<{ hash: string }>>,
): TableDifference[] {
  const out: TableDifference[] = [];
  for (const table of Object.keys(CHILD_SAFETY_TABLES)) {
    const p = (production[table] ?? []).map((r) => r.hash);
    const d = (dev[table] ?? []).map((r) => r.hash);
    const onlyInProduction = p.filter((h) => !d.includes(h));
    const onlyInDev = d.filter((h) => !p.includes(h));
    if (onlyInProduction.length > 0 || onlyInDev.length > 0) out.push({ table, onlyInProduction, onlyInDev });
  }
  return out;
}

async function writeOnce(file: File, body: Buffer, contentType: string): Promise<void> {
  await file.save(body, { contentType, resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
}

/** The record's body as written; its sha256 is over exactly this text. */
function recordBody(record: CaseRecord): string {
  return JSON.stringify(record);
}

export async function prepareReset(opts: ResetPrepareOptions): Promise<ResetPrepareReport> {
  const now = opts.now ?? (() => new Date());
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.resetId)) throw new Error(`reset id "${opts.resetId}" is not a plain name`);
  const prod = new URL(opts.productionUrl);
  const dev = new URL(opts.devUrl);
  if (prod.host === dev.host && databaseName(opts.productionUrl) === databaseName(opts.devUrl)) {
    throw new Error("RESET_PRODUCTION_DATABASE_URL names dev's own database");
  }

  const report: ResetPrepareReport = {
    resetId: opts.resetId,
    verdict: "fail",
    reasons: [],
    otherSessions: [],
    capture: null,
    recordKey: null,
    recordSha256: null,
    inventory: null,
    evidence: [],
    childSafetyCounts: {},
    referencedCounts: {},
    differencesFromDev: [],
  };

  // 1. No other writer.
  report.otherSessions = await otherSessions(opts.productionUrl);
  if (report.otherSessions.length > 0) {
    report.reasons.push(`${report.otherSessions.length} other session(s) connected to production: pause the deployment first`);
    return report;
  }

  const caseDir = `${CASES_PREFIX}production-reset-${opts.resetId}/`;
  const bucket = storageClient().bucket(opts.backup);
  const dumpFile = path.join(opts.workDir, "final-capture.dump");
  const scratch = `reset_capture_${crypto.randomBytes(3).toString("hex")}`;
  const control = await connect(opts.devUrl);
  let scratchCreated = false;
  try {
    // 2. The final capture, and proof that it restores.
    const takenAt = now().toISOString();
    const prodConn = pgCommandConnection(opts.productionUrl);
    try {
      execFileSync("pg_dump", ["-Fc", "--no-owner", "--no-acl", "-f", dumpFile, prodConn.url], { env: prodConn.env, stdio: "pipe" });
    } catch (err) {
      report.reasons.push(`the final capture failed: ${withoutPassword(String((err as Error).message), opts.productionUrl).slice(0, 500)}`);
      return report;
    }
    const bytes = fs.readFileSync(dumpFile);
    const dumpKey = `${caseDir}final-capture.dump`;
    report.capture = { database: databaseName(opts.productionUrl), takenAt, dumpKey, dumpSha256: sha256(bytes), bytes: bytes.length };

    await control.query(`CREATE DATABASE "${scratch}" TEMPLATE template0`);
    scratchCreated = true;
    const scratchUrl = databaseUrl(opts.devUrl, scratch);
    const scratchConn = pgCommandConnection(scratchUrl);
    try {
      execFileSync("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", "-d", scratchConn.url, dumpFile], { env: scratchConn.env, stdio: "pipe" });
    } catch (err) {
      report.reasons.push(`the final capture does not restore: ${String((err as Error).message).slice(0, 500)}`);
      return report;
    }

    // 3. The full inventory, on the capture.
    const inventory = await opts.inventory(scratchUrl);
    report.inventory = inventory;
    if (inventory.verdict?.blocksReplacement) {
      report.reasons.push(`the inventory blocks the replacement: ${(inventory.verdict.reasons ?? []).filter((r) => r.startsWith("BLOCKS")).join("; ")}`);
    }

    // 4. The case record: child-safety rows, what they reference, their evidence.
    const s = await connect(scratchUrl);
    let rows: Record<string, Array<{ hash: string; row: Row }>>;
    let referenced: Record<string, Row[]>;
    try {
      rows = await childSafetyRows(s);
      referenced = await referencedRows(s, Object.fromEntries(Object.entries(rows).map(([t, rs]) => [t, rs.map((r) => r.row)])));
    } finally {
      await s.end();
    }
    report.childSafetyCounts = Object.fromEntries(Object.entries(rows).map(([t, rs]) => [t, rs.length]));
    report.referencedCounts = Object.fromEntries(Object.entries(referenced).map(([t, rs]) => [t, rs.length]));
    const paths = Object.entries(CHILD_SAFETY_TABLES).flatMap(([table, cols]) =>
      rows[table].flatMap((r) => cols.map((col) => r.row[col]).filter((v): v is string => typeof v === "string" && v !== "")),
    );
    report.evidence = await evidenceManifest(paths);
    const missing = report.evidence.filter((e) => !e.present);
    if (missing.length > 0) report.reasons.push(`${missing.length} evidence object(s) missing: ${missing.map((e) => e.path).join(", ")}`);

    // 5. Against dev, the handling copy.
    const d = await connect(opts.devUrl);
    try {
      report.differencesFromDev = differences(rows, await childSafetyRows(d));
    } finally {
      await d.end();
    }
    if (report.differencesFromDev.length > 0) {
      report.reasons.push(
        `production's child-safety rows differ from dev's (${report.differencesFromDev.map((x) => x.table).join(", ")}): the handling disposition goes back to David before the reset`,
      );
    }

    // 6. Written once and read back, whatever the comparison found: the record is kept.
    const record: CaseRecord = {
      kind: "production-reset-case-record",
      resetId: opts.resetId,
      capture: report.capture,
      childSafety: rows,
      referenced,
      evidence: report.evidence,
      inventory,
      handling: D2_HANDLING,
    };
    const body = recordBody(record);
    const recordSha256 = sha256(body);
    const recordKey = `${caseDir}record.json`;
    await writeOnce(bucket.file(dumpKey), bytes, "application/octet-stream");
    await writeOnce(bucket.file(recordKey), Buffer.from(JSON.stringify({ sha256: recordSha256, record }), "utf8"), "application/json");
    const [backDump] = await bucket.file(dumpKey).download();
    const [backRecord] = await bucket.file(recordKey).download();
    const parsed = JSON.parse(backRecord.toString("utf8")) as { sha256: string; record: CaseRecord };
    if (sha256(backDump) !== report.capture.dumpSha256) report.reasons.push("the stored capture does not read back unchanged");
    if (parsed.sha256 !== recordSha256 || sha256(recordBody(parsed.record)) !== recordSha256) {
      report.reasons.push("the stored case record does not read back unchanged");
    }
    report.recordKey = recordKey;
    report.recordSha256 = recordSha256;

    if (report.reasons.length === 0) report.verdict = "pass";
    return report;
  } finally {
    if (scratchCreated) await control.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    await control.end();
    // The dump is a full copy of production: the working copy never outlives the run.
    fs.rmSync(dumpFile, { force: true });
  }
}
