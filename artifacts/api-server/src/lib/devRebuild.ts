/**
 * @purpose Rebuilds the Repl's dev database from code while keeping its content: refuses while jobs are still queued, builds a new database by the bootstrap path beside the live one, loads the live one's rows into it, clears sessions, verifies every row came across, and swaps the two by renaming — the old database is kept, so the swap is undone by renaming back.
 * @subsystem data-lifecycle
 *
 * Launch Phase 3, increment 7 (#770; plan docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md
 * §5 and §7, "Dev"). David chose that dev keeps its content (2026-10-28,
 * Question 1), from a fresh capture taken immediately before the rebuild.
 *
 * The §5 sequence, as this runs it:
 *
 *   1. Capture and inventory. The live database is fingerprinted (every row
 *      of every public table, hashed) and dumped. The caller runs the
 *      excluded-classes inventory beside it and records both on #770.
 *   2. Carry forward. Every row is carried — child-safety and payment rows
 *      included, with their relationships — so the carry-forward artifact is
 *      the rebuilt database itself, checked row for row before any swap.
 *   3. Stripe. Nothing is discarded, so no payment obligation loses its local
 *      record; a payment-class row that does not arrive unchanged fails the
 *      rebuild.
 *   4. Clean before serving. Sessions and auth state are not loaded. Jobs are
 *      drained, not disposed of: the rebuild refuses while any is pending or
 *      processing, and lists them. Marking one failed by hand would bypass its
 *      handler, which owns a status elsewhere that only the worker finalizes
 *      (facts.visual_concept_status, for one), and strand that work.
 *   5. Restore and verify before exposure. All of the above is checked on the
 *      new database while the live one still serves; only `swapIn` exposes it.
 *
 * Nothing here drops a database it did not create: `prepareRebuild` drops its
 * own failed build, and `swapIn` and `undoSwap` only rename.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

import { ncmecAuditBoundaryStatus } from "@workspace/db";
import { TABLE_CLASSIFICATION } from "@workspace/db/table-classification";

import { adminValues, advanceSequences, exhaustedSequences, orphans, publicTables } from "./databaseChecks.js";
import { pgCommandConnection, withoutPassword } from "./pgCommandLine.js";

const NON_TERMINAL = "status IN ('pending', 'processing')";

/** The same server and connection settings, another database; the test runner's schema options dropped. */
export function databaseUrl(serverUrl: string, database: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  url.searchParams.delete("options");
  return url.href;
}

export function databaseName(url: string): string {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  if (!name) throw new Error("the database URL names no database");
  return name;
}

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => {}); // a rename or drop of ours ends it
  await c.connect();
  return c;
}

/**
 * Schemas the code does not build but something else on dev wrote — today
 * stripe-replit-sync's `stripe` mirror, created at server start (stripeInit.ts).
 * They are carried whole, objects and rows, from the dump.
 */
async function carriedSchemas(c: pg.ClientBase): Promise<string[]> {
  const { rows } = await c.query<{ s: string }>(
    `SELECT nspname AS s FROM pg_namespace
     WHERE nspname NOT LIKE 'pg\\_%' AND nspname NOT IN ('information_schema', 'public', 'drizzle') ORDER BY 1`,
  );
  return rows.map((r) => r.s);
}

/**
 * Public functions the carried schemas' triggers call, as regprocedure text. A
 * carried schema can depend on public objects its writer created there:
 * stripe-replit-sync creates set_updated_at() and set_updated_at_metadata() in
 * whichever schema comes first on its search path, which on dev is public.
 */
async function carriedFunctions(c: pg.ClientBase, schemas: string[]): Promise<string[]> {
  if (schemas.length === 0) return [];
  const { rows } = await c.query<{ f: string }>(
    `SELECT DISTINCT p.oid::regprocedure::text AS f
     FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE r.relnamespace = ANY(SELECT oid FROM pg_namespace WHERE nspname = ANY($1))
       AND p.pronamespace = 'public'::regnamespace
     ORDER BY 1`,
    [schemas],
  );
  return rows.map((r) => r.f);
}

/** Every function in public, as regprocedure text. */
async function publicFunctions(c: pg.ClientBase): Promise<Set<string>> {
  const { rows } = await c.query<{ f: string }>(
    "SELECT p.oid::regprocedure::text AS f FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace",
  );
  return new Set(rows.map((r) => r.f));
}

/**
 * Each table's rows, hashed and sorted; independent of column order. Public tables
 * are keyed by name, a carried schema's as `schema.table`.
 */
async function fingerprint(c: pg.ClientBase): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const hashes = async (from: string, where = "", params: unknown[] = []) =>
    (await c.query<{ h: string }>(`SELECT md5(to_jsonb(r)::text) AS h FROM ${from} r${where} ORDER BY 1`, params)).rows.map((r) => r.h);
  for (const t of await publicTables(c)) out.set(t, await hashes(`public."${t}"`));
  for (const schema of await carriedSchemas(c)) {
    const { rows } = await c.query<{ t: string }>(
      "SELECT relname AS t FROM pg_class WHERE relnamespace = $1::regnamespace AND relkind = 'r' ORDER BY 1",
      [schema],
    );
    for (const { t } of rows) out.set(`${schema}.${t}`, await hashes(`"${schema}"."${t}"`));
  }
  return out;
}

function digestOf(prints: Map<string, string[]>): string {
  const h = crypto.createHash("sha256");
  for (const [t, rows] of [...prints].sort(([a], [b]) => a.localeCompare(b))) h.update(`${t}\n${rows.join("\n")}\n`);
  return h.digest("hex");
}

/** The digest `prepareRebuild` reports for the live database; `swapIn` refuses if it has moved since. */
export async function liveDigest(sourceUrl: string): Promise<string> {
  const c = await connect(sourceUrl);
  try {
    return digestOf(await fingerprint(c));
  } finally {
    await c.end();
  }
}

/**
 * Every user-defined trigger's firing mode (pg_trigger.tgenabled: O origin, A always,
 * R replica, D disabled), keyed table.trigger. Loading rows must not change any: the
 * child-safety audit log's append-only guards are ALWAYS so that a replica session
 * cannot skip them.
 */
async function triggerModes(c: pg.ClientBase): Promise<Map<string, string>> {
  const { rows } = await c.query<{ k: string; m: string }>(
    "SELECT tgrelid::regclass::text || '.' || tgname AS k, tgenabled AS m FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1",
  );
  return new Map(rows.map((r) => [r.k, r.m]));
}

function boot(apiRoot: string, url: string): void {
  execFileSync("npx", ["tsx", "scripts/boot-database.ts"], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: url, PGOPTIONS: "" },
    stdio: "pipe",
  });
}

function sessionClass(table: string): boolean {
  const e = TABLE_CLASSIFICATION[table];
  return e?.class === "excluded" && e.excluded === "sessions";
}

export interface RebuildOptions {
  /** The live dev database. */
  sourceUrl: string;
  /** artifacts/api-server, where scripts/boot-database.ts runs. */
  apiRoot: string;
  /** A private directory for the dump. */
  workDir: string;
  /** The rebuilt database's name; a fresh one when omitted. */
  targetName?: string;
}

export interface RebuildReport {
  verdict: "pass" | "fail";
  failures: string[];
  source: { database: string; digest: string; tables: number; rows: number; ledger: number };
  target: { database: string; kept: boolean; tables: number; rows: number; ledger: number };
  /** What the rebuild did to the excluded classes. */
  dispositions: {
    sessionsCleared: Record<string, number>;
    childSafetyCarried: Record<string, number>;
    paymentsCarried: Record<string, number>;
  };
  /** Schemas the code does not build, carried whole: tables per schema. */
  schemasCarried: Record<string, number>;
  /** Public functions those schemas' triggers need that the code does not build, carried from dev. */
  functionsCarried: string[];
  newInCode: string[];
  seededAfterLoad: Record<string, number>;
  sequencesAdvanced: string[];
  settingsChecked: number;
  auditBoundary: unknown;
  times: { fingerprintMs: number; dumpMs: number; buildMs: number; loadMs: number; verifyMs: number; totalMs: number };
}

/**
 * Builds the new database from code beside the live one, loads the live rows into
 * it and verifies them. The live database is only read. On a failure the new
 * database is dropped unless `keepOnFail`.
 */
export async function prepareRebuild(opts: RebuildOptions & { keepOnFail?: boolean }): Promise<RebuildReport> {
  const t0 = Date.now();
  const sourceName = databaseName(opts.sourceUrl);
  const targetName = opts.targetName ?? `${sourceName}_rebuild_${crypto.randomBytes(3).toString("hex")}`;
  const targetUrl = databaseUrl(opts.sourceUrl, targetName);
  const failures: string[] = [];
  const times = { fingerprintMs: 0, dumpMs: 0, buildMs: 0, loadMs: 0, verifyMs: 0, totalMs: 0 };

  // 1. Capture: fingerprint, then dump.
  const source = await connect(opts.sourceUrl);
  let before: Map<string, string[]>;
  let sourceSettings: Map<string, string>;
  let sourceLedger: number;
  let schemas: string[] = [];
  let neededFunctions: string[] = [];
  let digest: string;
  try {
    before = await fingerprint(source);
    schemas = await carriedSchemas(source);
    neededFunctions = await carriedFunctions(source, schemas);
    digest = digestOf(before);
    if (before.has("async_jobs")) {
      const { rows: queued } = await source.query<{ id: number; queue: string; status: string; next_attempt_at: Date }>(
        `SELECT id, queue, status, next_attempt_at FROM public.async_jobs WHERE ${NON_TERMINAL} ORDER BY id`,
      );
      for (const j of queued) {
        failures.push(`job ${j.id} (${j.queue}) is ${j.status}, next attempt ${j.next_attempt_at.toISOString()}: let the queue drain, with the workflows running, then prepare again`);
      }
    }
    sourceSettings = await adminValues(source);
    sourceLedger = Number((await source.query("SELECT count(*) AS n FROM drizzle.__drizzle_migrations")).rows[0].n);
  } finally {
    await source.end();
  }
  times.fingerprintMs = Date.now() - t0;
  if (failures.length > 0) {
    times.totalMs = Date.now() - t0;
    return refusal(failures, { database: sourceName, digest, tables: before.size, ledger: sourceLedger, before }, targetName, sourceSettings.size, times);
  }
  const dumpFile = path.join(opts.workDir, `${sourceName}.dump`);
  const t1 = Date.now();
  const sourceConn = pgCommandConnection(opts.sourceUrl);
  execFileSync("pg_dump", ["-Fc", "--no-owner", "--no-acl", "-f", dumpFile, sourceConn.url], { env: sourceConn.env, stdio: "pipe" });
  times.dumpMs = Date.now() - t1;

  // The build: a new database, by the bootstrap path.
  const control = await connect(opts.sourceUrl);
  let created = false;
  const report = (verdict: RebuildReport["verdict"], extra: Partial<RebuildReport>): RebuildReport => ({
    verdict,
    failures,
    source: {
      database: sourceName,
      digest,
      tables: before.size,
      rows: [...before.values()].reduce((a, r) => a + r.length, 0),
      ledger: sourceLedger,
    },
    target: { database: targetName, kept: false, tables: 0, rows: 0, ledger: 0 },
    dispositions: { sessionsCleared: {}, childSafetyCarried: {}, paymentsCarried: {} },
    schemasCarried: {},
    functionsCarried: [],
    newInCode: [],
    seededAfterLoad: {},
    sequencesAdvanced: [],
    settingsChecked: sourceSettings.size,
    auditBoundary: null,
    times,
    ...extra,
  });
  let result: RebuildReport;
  try {
    await control.query(`CREATE DATABASE "${targetName}" TEMPLATE template0`);
    created = true;
    const t2 = Date.now();
    boot(opts.apiRoot, targetUrl);
    times.buildMs = Date.now() - t2;

    // 2–4. Load every row but sessions and auth state.
    const t3 = Date.now();
    const target = await connect(targetUrl);
    let built: string[];
    let builtModes: Map<string, string>;
    let functionsCarried: string[] = [];
    try {
      built = await publicTables(target);
      builtModes = await triggerModes(target);
      const builtSet = new Set(built);
      const notBuilt = [...before.keys()].filter((t) => !t.includes(".") && !builtSet.has(t));
      for (const schema of (await carriedSchemas(target)).filter((x) => schemas.includes(x))) {
        failures.push(`schema ${schema} is built by code and also written on dev; it is not carried`);
      }
      for (const t of notBuilt) failures.push(`not built by code: dev's table ${t} (${before.get(t)!.length} rows) has no place in the rebuilt database`);
      const load = [...before.keys()].filter((t) => builtSet.has(t) && !sessionClass(t));
      const seeded: string[] = [];
      for (const t of load) {
        if (Number((await target.query(`SELECT count(*) AS n FROM public."${t}"`)).rows[0].n) > 0) seeded.push(t);
      }
      if (seeded.length > 0) await target.query(`TRUNCATE ${seeded.map((t) => `public."${t}"`).join(", ")} CASCADE`);
      // pg_restore -n restores a schema's contents, not the schema itself.
      const existing = await carriedSchemas(target);
      const builtFunctions = await publicFunctions(target);
      functionsCarried = neededFunctions.filter((f) => !builtFunctions.has(f));
      for (const schema of schemas.filter((x) => !existing.includes(x))) await target.query(`CREATE SCHEMA "${schema}"`);
      const { rows: seqs } = await target.query<{ s: string }>(
        "SELECT relname AS s FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'S'",
      );
      await target.end();
      loadRows(dumpFile, targetUrl, new Set(load), new Set(seqs.map((r) => r.s)), opts.workDir);
      if (functionsCarried.length > 0) restoreFunctions(dumpFile, targetUrl, functionsCarried, opts.workDir);
      for (const schema of schemas) restoreSchema(dumpFile, targetUrl, schema);
    } catch (err) {
      await target.end().catch(() => {});
      throw err;
    }
    // The boot again, as the server will on its first start: seeds a code change added since dev last booted.
    boot(opts.apiRoot, targetUrl);
    times.loadMs = Date.now() - t3;

    // 5. Verify, while the live database still serves.
    const t4 = Date.now();
    const check = await connect(targetUrl);
    let extra: Partial<RebuildReport>;
    try {
      const sequencesAdvanced = await advanceSequences(check);
      const modes = await triggerModes(check);
      for (const [k, m] of builtModes) {
        if (modes.get(k) !== m) failures.push(`trigger: ${k} was mode ${m} on the fresh build, now ${modes.get(k) ?? "absent"}`);
      }
      const got = await fingerprint(check);
      const dispositions: RebuildReport["dispositions"] = {
        sessionsCleared: {},
        childSafetyCarried: {},
        paymentsCarried: {},
      };
      const seededAfterLoad: Record<string, number> = {};
      for (const [t, rows] of before) {
        const now = got.get(t);
        if (!now) continue; // reported above as not built by code
        const entry = TABLE_CLASSIFICATION[t];
        if (sessionClass(t)) {
          dispositions.sessionsCleared[t] = rows.length;
          if (now.length > 0) failures.push(`not cleared: ${t} holds ${now.length} row(s)`);
          continue;
        }
        if (entry?.class === "config" || entry?.class === "runtime") {
          // A boot may add rows here, and may re-assert a code-owned column; every dev row's key must survive.
          const missing = rows.length - now.filter((h) => rows.includes(h)).length;
          if (now.length < rows.length) failures.push(`lost: ${t} had ${rows.length} rows, now ${now.length}`);
          else if (now.length > rows.length) seededAfterLoad[t] = now.length - rows.length;
          if (missing > 0 && entry.class === "config") seededAfterLoad[`${t} (changed by the boot)`] = missing;
          continue;
        }
        if (now.length !== rows.length || now.some((h, i) => h !== rows[i])) {
          failures.push(`not carried exactly: ${t} had ${rows.length} rows, the rebuild holds ${now.length}${now.length === rows.length ? " with different content" : ""}`);
        }
        if (entry?.class === "excluded" && entry.excluded === "childSafety") dispositions.childSafetyCarried[t] = now.length;
        if (entry?.class === "excluded" && entry.excluded === "payments") dispositions.paymentsCarried[t] = now.length;
      }
      const settings = await adminValues(check);
      for (const [key, value] of sourceSettings) {
        if (settings.get(key) !== value) failures.push(`setting: ${key} was ${value}, now ${settings.get(key) ?? "absent"}`);
      }
      failures.push(...(await orphans(check)).map((o) => `relationship: ${o}`));
      failures.push(...(await exhaustedSequences(check)).map((s) => `sequence: ${s}`));
      const targetLedger = Number((await check.query("SELECT count(*) AS n FROM drizzle.__drizzle_migrations")).rows[0].n);
      // Reported, not compared: the rebuild's ledger is the bootstrap path's, and dev's carries its own history
      // (dev 124 rows, a fresh build 114, on 2026-10-29; #770).
      const auditPool = new pg.Pool({ connectionString: targetUrl, max: 1 });
      let auditBoundary: unknown;
      try {
        auditBoundary = await ncmecAuditBoundaryStatus(auditPool);
      } catch (err) {
        auditBoundary = { error: (err as Error).message };
      } finally {
        await auditPool.end();
      }
      extra = {
        target: {
          database: targetName,
          kept: false,
          tables: got.size,
          rows: [...got.values()].reduce((a, r) => a + r.length, 0),
          ledger: targetLedger,
        },
        dispositions,
        schemasCarried: Object.fromEntries(schemas.map((x) => [x, [...got.keys()].filter((k) => k.startsWith(`${x}.`)).length])),
        functionsCarried,
        newInCode: [...got.keys()].filter((t) => !before.has(t)),
        seededAfterLoad,
        sequencesAdvanced,
        auditBoundary,
      };
    } finally {
      await check.end();
    }

    // The live database must not have moved while all this ran: stop its writers first.
    if ((await liveDigest(opts.sourceUrl)) !== digest) {
      failures.push("dev changed while the rebuild ran: stop the app's workflows and run it again");
    }
    times.verifyMs = Date.now() - t4;
    times.totalMs = Date.now() - t0;
    result = report(failures.length === 0 ? "pass" : "fail", extra);
  } catch (err) {
    failures.push(`rebuild failed: ${withoutPassword(String((err as Error).message ?? err), opts.sourceUrl)}`);
    times.totalMs = Date.now() - t0;
    result = report("fail", {});
  }
  const keep = created && (result.verdict === "pass" || opts.keepOnFail === true);
  if (created && !keep) await control.query(`DROP DATABASE IF EXISTS "${targetName}" WITH (FORCE)`);
  await control.end();
  result.target.kept = keep;
  return result;
}

/** The report of a rebuild refused before anything was built. */
function refusal(
  failures: string[],
  source: { database: string; digest: string; tables: number; ledger: number; before: Map<string, string[]> },
  targetName: string,
  settingsChecked: number,
  times: RebuildReport["times"],
): RebuildReport {
  return {
    verdict: "fail",
    failures,
    source: {
      database: source.database,
      digest: source.digest,
      tables: source.tables,
      rows: [...source.before.values()].reduce((a, r) => a + r.length, 0),
      ledger: source.ledger,
    },
    target: { database: targetName, kept: false, tables: 0, rows: 0, ledger: 0 },
    dispositions: { sessionsCleared: {}, childSafetyCarried: {}, paymentsCarried: {} },
    schemasCarried: {},
    functionsCarried: [],
    newInCode: [],
    seededAfterLoad: {},
    sequencesAdvanced: [],
    settingsChecked,
    auditBoundary: null,
    times,
  };
}

/** pg_restore of the named public functions from the dump; one the dump lacks fails the rebuild. */
function restoreFunctions(dumpFile: string, targetUrl: string, functions: string[], workDir: string): void {
  const squash = (sig: string) => sig.replace(/\s+/g, "");
  const wanted = new Set(functions.map(squash));
  const toc = execFileSync("pg_restore", ["-l", dumpFile], { encoding: "utf8" });
  const keep = toc.split("\n").filter((line) => {
    const m = /^\d+; \d+ \d+ FUNCTION public (.+\)) \S+$/.exec(line);
    return m !== null && wanted.has(squash(m[1]));
  });
  if (keep.length !== wanted.size) {
    throw new Error(`carrying functions failed: the dump holds ${keep.length} of ${functions.join(", ")}`);
  }
  const list = path.join(workDir, "functions.list");
  fs.writeFileSync(list, `${keep.join("\n")}\n`);
  const conn = pgCommandConnection(targetUrl);
  try {
    execFileSync("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", "-L", list, "-d", conn.url, dumpFile], {
      env: conn.env,
      stdio: "pipe",
    });
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer }).stderr ?? "").trim();
    throw new Error(`carrying functions failed: ${withoutPassword(stderr || (err as Error).message, targetUrl).slice(0, 800)}`);
  }
}

/** pg_restore of one schema the code does not build: its objects and rows. */
function restoreSchema(dumpFile: string, targetUrl: string, schema: string): void {
  const conn = pgCommandConnection(targetUrl);
  try {
    execFileSync("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", "-n", schema, "-d", conn.url, dumpFile], {
      env: conn.env,
      stdio: "pipe",
    });
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer }).stderr ?? "").trim();
    throw new Error(`carrying schema ${schema} failed: ${withoutPassword(stderr || (err as Error).message, targetUrl).slice(0, 800)}`);
  }
}

/**
 * pg_restore of the dump's rows only — the listed tables and the sequences the build
 * has — into the built schema. In a replica session, so foreign keys and ordinary
 * triggers do not fire while rows arrive in dump order, and no trigger's mode is
 * touched: --disable-triggers would end with ENABLE TRIGGER ALL, which turns an
 * ALWAYS trigger into an ordinary one. Both need a superuser, which dev's role is.
 */
function loadRows(dumpFile: string, targetUrl: string, tables: Set<string>, sequences: Set<string>, workDir: string): void {
  const toc = execFileSync("pg_restore", ["-l", dumpFile], { encoding: "utf8" });
  const keep = toc.split("\n").filter((line) => {
    const m = /^\d+; \d+ \d+ (TABLE DATA|SEQUENCE SET) public (\S+) /.exec(line);
    if (!m) return false;
    return m[1] === "TABLE DATA" ? tables.has(m[2]) : sequences.has(m[2]);
  });
  const list = path.join(workDir, "load.list");
  fs.writeFileSync(list, `${keep.join("\n")}\n`);
  const conn = pgCommandConnection(targetUrl);
  try {
    execFileSync(
      "pg_restore",
      ["--data-only", "--no-owner", "--no-acl", "--exit-on-error", "-L", list, "-d", conn.url, dumpFile],
      { env: { ...conn.env, PGOPTIONS: "-c session_replication_role=replica" }, stdio: "pipe" },
    );
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer }).stderr ?? "").trim();
    throw new Error(`loading dev's rows failed: ${withoutPassword(stderr || (err as Error).message, targetUrl).slice(0, 800)}`);
  }
}

export interface SwapResult {
  live: string;
  previous: string;
  ms: number;
}

/** A test's way to make the second rename fail, after the first has been made. */
export interface SwapHooks {
  beforeSecondRename?: () => Promise<void>;
}

interface Rename {
  /** The database the statement is issued from; never one it renames. */
  via: string;
  from: string;
  to: string;
}

async function rename(serverUrl: string, r: Rename): Promise<void> {
  const c = await connect(databaseUrl(serverUrl, r.via));
  try {
    await endConnections(c, r.from);
    await c.query(`ALTER DATABASE "${r.from}" RENAME TO "${r.to}"`);
  } finally {
    await c.end();
  }
}

/**
 * Two renames made one after the other. If the second cannot be made, the first is
 * undone from a connection to the second's source — which still exists, and is
 * neither of the first's names — and the error says whether that worked and, if
 * not, which statement puts the live name back.
 */
async function renamePair(serverUrl: string, first: Rename, second: Rename, hooks: SwapHooks = {}): Promise<void> {
  await rename(serverUrl, first);
  try {
    await hooks.beforeSecondRename?.();
    await rename(serverUrl, second);
  } catch (err) {
    const why = withoutPassword(String((err as Error).message ?? err), serverUrl);
    let state: string;
    try {
      await rename(serverUrl, { via: second.from, from: first.to, to: first.from });
      state = `${first.from} was put back as it was`;
    } catch (backErr) {
      state =
        `putting it back failed too (${withoutPassword(String((backErr as Error).message ?? backErr), serverUrl)}): ` +
        `${first.from} is now named ${first.to}; from a connection to any other database, run ` +
        `ALTER DATABASE "${first.to}" RENAME TO "${first.from}"`;
    }
    throw new Error(`${second.from} could not be renamed to ${second.to} (${why}); ${state}`);
  }
}

/**
 * Exposes a prepared rebuild: renames the live database aside (kept, never dropped)
 * and the rebuilt one into its name. Refuses unless the live database still holds
 * exactly what the rebuild verified. Connections to both are ended first; the app's
 * workflows should be stopped so nothing reconnects mid-swap.
 */
export async function swapIn(
  opts: { sourceUrl: string; targetName: string; expectDigest: string },
  hooks: SwapHooks = {},
): Promise<SwapResult> {
  const t0 = Date.now();
  const live = databaseName(opts.sourceUrl);
  const suffix = /_rebuild_([0-9a-f]+)$/.exec(opts.targetName)?.[1];
  if (!suffix || !opts.targetName.startsWith(`${live}_rebuild_`)) {
    throw new Error(`${opts.targetName} is not a rebuild of ${live}`);
  }
  if ((await liveDigest(opts.sourceUrl)) !== opts.expectDigest) {
    throw new Error(`${live} has changed since the rebuild was verified; prepare it again with the workflows stopped`);
  }
  const previous = `${live}_pre_rebuild_${suffix}`;
  await renamePair(
    opts.sourceUrl,
    { via: opts.targetName, from: live, to: previous },
    { via: previous, from: opts.targetName, to: live },
    hooks,
  );
  return { live, previous, ms: Date.now() - t0 };
}

/** Puts the database `swapIn` renamed aside back; the rebuilt one is kept under `<live>_rebuilt_<suffix>`. */
export async function undoSwap(opts: { sourceUrl: string; previous: string }, hooks: SwapHooks = {}): Promise<SwapResult> {
  const t0 = Date.now();
  const live = databaseName(opts.sourceUrl);
  const suffix = /_pre_rebuild_([0-9a-f]+)$/.exec(opts.previous)?.[1];
  if (!suffix || opts.previous !== `${live}_pre_rebuild_${suffix}`) throw new Error(`${opts.previous} is not ${live} set aside by a rebuild`);
  const rebuilt = `${live}_rebuilt_${suffix}`;
  await renamePair(
    opts.sourceUrl,
    { via: opts.previous, from: live, to: rebuilt },
    { via: rebuilt, from: opts.previous, to: live },
    hooks,
  );
  return { live, previous: rebuilt, ms: Date.now() - t0 };
}

async function endConnections(c: pg.ClientBase, database: string): Promise<void> {
  await c.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [database]);
}
