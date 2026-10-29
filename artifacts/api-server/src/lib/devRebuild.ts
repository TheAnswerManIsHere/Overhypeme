/**
 * @purpose Rebuilds the Repl's dev database from code while keeping its content: builds a new database by the bootstrap path beside the live one, loads the live one's rows into it, clears sessions and disposes of queued jobs, verifies every row came across, and swaps the two by renaming — the old database is kept, so the swap is undone by renaming back.
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
 *   4. Clean before serving. Sessions and auth state are not loaded; jobs
 *      still pending or processing are marked failed with DISPOSED_JOB_ERROR.
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

export const DISPOSED_JOB_ERROR = "disposed by the dev rebuild (Launch Phase 3, #770)";
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

/** Each table's rows, hashed and sorted; independent of column order. `skipJobs` leaves those async_jobs rows out. */
async function fingerprint(c: pg.ClientBase, skipJobs: number[] = []): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const t of await publicTables(c)) {
    const skip = t === "async_jobs" && skipJobs.length > 0;
    const { rows } = await c.query<{ h: string }>(
      `SELECT md5(to_jsonb(r)::text) AS h FROM public."${t}" r${skip ? " WHERE NOT (r.id = ANY($1::int[]))" : ""} ORDER BY 1`,
      skip ? [skipJobs] : [],
    );
    out.set(t, rows.map((r) => r.h));
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
    jobsDisposed: number;
    childSafetyCarried: Record<string, number>;
    paymentsCarried: Record<string, number>;
  };
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
  let disposedIds: number[] = [];
  let digest: string;
  try {
    const full = await fingerprint(source);
    digest = digestOf(full);
    if (full.has("async_jobs")) {
      disposedIds = (await source.query<{ id: number }>(`SELECT id FROM public.async_jobs WHERE ${NON_TERMINAL} ORDER BY id`)).rows.map((r) => r.id);
    }
    // Compared without the jobs the rebuild disposes of; the digest covers everything.
    before = disposedIds.length > 0 ? await fingerprint(source, disposedIds) : full;
    sourceSettings = await adminValues(source);
    sourceLedger = Number((await source.query("SELECT count(*) AS n FROM drizzle.__drizzle_migrations")).rows[0].n);
  } finally {
    await source.end();
  }
  const nonTerminalJobs = disposedIds.length;
  times.fingerprintMs = Date.now() - t0;
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
      rows: [...before.values()].reduce((a, r) => a + r.length, 0) + nonTerminalJobs,
      ledger: sourceLedger,
    },
    target: { database: targetName, kept: false, tables: 0, rows: 0, ledger: 0 },
    dispositions: { sessionsCleared: {}, jobsDisposed: 0, childSafetyCarried: {}, paymentsCarried: {} },
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

    // 2–4. Load every row but sessions and auth state; dispose of queued jobs.
    const t3 = Date.now();
    const target = await connect(targetUrl);
    let built: string[];
    try {
      built = await publicTables(target);
      const builtSet = new Set(built);
      const notBuilt = [...before.keys()].filter((t) => !builtSet.has(t));
      for (const t of notBuilt) failures.push(`not built by code: dev's table ${t} (${before.get(t)!.length} rows) has no place in the rebuilt database`);
      const load = [...before.keys()].filter((t) => builtSet.has(t) && !sessionClass(t));
      const seeded: string[] = [];
      for (const t of load) {
        if (Number((await target.query(`SELECT count(*) AS n FROM public."${t}"`)).rows[0].n) > 0) seeded.push(t);
      }
      if (seeded.length > 0) await target.query(`TRUNCATE ${seeded.map((t) => `public."${t}"`).join(", ")} CASCADE`);
      const { rows: seqs } = await target.query<{ s: string }>(
        "SELECT relname AS s FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'S'",
      );
      await target.end();
      loadRows(dumpFile, targetUrl, new Set(load), new Set(seqs.map((r) => r.s)), opts.workDir);
    } catch (err) {
      await target.end().catch(() => {});
      throw err;
    }
    const after = await connect(targetUrl);
    try {
      if (disposedIds.length > 0) {
        await after.query(
          "UPDATE public.async_jobs SET status = 'failed', last_error = $1, updated_at = now() WHERE id = ANY($2::int[])",
          [DISPOSED_JOB_ERROR, disposedIds],
        );
      }
    } finally {
      await after.end();
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
      const got = await fingerprint(check, disposedIds);
      const dispositions: RebuildReport["dispositions"] = {
        sessionsCleared: {},
        jobsDisposed: 0,
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
      if (got.has("async_jobs")) {
        dispositions.jobsDisposed = Number(
          (
            await check.query(
              "SELECT count(*) AS n FROM public.async_jobs WHERE id = ANY($1::int[]) AND status = 'failed' AND last_error = $2",
              [disposedIds, DISPOSED_JOB_ERROR],
            )
          ).rows[0].n,
        );
        if (dispositions.jobsDisposed !== nonTerminalJobs) {
          failures.push(`jobs: ${nonTerminalJobs} were pending or processing, ${dispositions.jobsDisposed} disposed of`);
        }
        const live = Number((await check.query(`SELECT count(*) AS n FROM public.async_jobs WHERE ${NON_TERMINAL}`)).rows[0].n);
        if (live > 0) failures.push(`jobs: ${live} still pending or processing`);
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
          rows: [...got.values()].reduce((a, r) => a + r.length, 0) + dispositions.jobsDisposed,
          ledger: targetLedger,
        },
        dispositions,
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

/** pg_restore of the dump's rows only — the listed tables and the sequences the build has — into the built schema. */
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
      ["--data-only", "--disable-triggers", "--no-owner", "--no-acl", "--exit-on-error", "-L", list, "-d", conn.url, dumpFile],
      { env: conn.env, stdio: "pipe" },
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

/**
 * Exposes a prepared rebuild: renames the live database aside (kept, never dropped)
 * and the rebuilt one into its name. Refuses unless the live database still holds
 * exactly what the rebuild verified. Connections to both are ended first; the app's
 * workflows should be stopped so nothing reconnects mid-swap.
 */
export async function swapIn(opts: { sourceUrl: string; targetName: string; expectDigest: string }): Promise<SwapResult> {
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
  // Connected to the rebuilt database, rename the live one aside; then, connected to that, the rebuilt one in.
  const viaTarget = await connect(databaseUrl(opts.sourceUrl, opts.targetName));
  try {
    await endConnections(viaTarget, live);
    await viaTarget.query(`ALTER DATABASE "${live}" RENAME TO "${previous}"`);
  } finally {
    await viaTarget.end();
  }
  const viaPrevious = await connect(databaseUrl(opts.sourceUrl, previous));
  try {
    await endConnections(viaPrevious, opts.targetName);
    await viaPrevious.query(`ALTER DATABASE "${opts.targetName}" RENAME TO "${live}"`);
  } catch (err) {
    await viaPrevious.query(`ALTER DATABASE "${previous}" RENAME TO "${live}"`).catch(() => {});
    throw err;
  } finally {
    await viaPrevious.end();
  }
  return { live, previous, ms: Date.now() - t0 };
}

/** Puts the database `swapIn` renamed aside back; the rebuilt one is kept under `<live>_rebuilt_<suffix>`. */
export async function undoSwap(opts: { sourceUrl: string; previous: string }): Promise<SwapResult> {
  const t0 = Date.now();
  const live = databaseName(opts.sourceUrl);
  const suffix = /_pre_rebuild_([0-9a-f]+)$/.exec(opts.previous)?.[1];
  if (!suffix || opts.previous !== `${live}_pre_rebuild_${suffix}`) throw new Error(`${opts.previous} is not ${live} set aside by a rebuild`);
  const rebuilt = `${live}_rebuilt_${suffix}`;
  const viaPrevious = await connect(databaseUrl(opts.sourceUrl, opts.previous));
  try {
    await endConnections(viaPrevious, live);
    await viaPrevious.query(`ALTER DATABASE "${live}" RENAME TO "${rebuilt}"`);
  } finally {
    await viaPrevious.end();
  }
  const viaRebuilt = await connect(databaseUrl(opts.sourceUrl, rebuilt));
  try {
    await endConnections(viaRebuilt, opts.previous);
    await viaRebuilt.query(`ALTER DATABASE "${opts.previous}" RENAME TO "${live}"`);
  } finally {
    await viaRebuilt.end();
  }
  return { live, previous: rebuilt, ms: Date.now() - t0 };
}

async function endConnections(c: pg.ClientBase, database: string): Promise<void> {
  await c.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [database]);
}
