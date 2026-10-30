/**
 * @purpose Adopts production's first database on Replit with proof: builds a reference from the code, refuses unless production holds no rows, no migration record and only known schemas, proves its structure equal to the reference object by object, then installs the reference's migration-created rows, ledger and sequence positions in one transaction under the runner's lock.
 * @subsystem data-lifecycle
 *
 * Launch Phase 3, increment 8, plan amendment 2
 * (docs/plans/PLAN_PHASE3_AMENDMENT_2.md, approved by David 2026-10-30,
 * "Approved, D4 keep"). On Replit a new production database always arrives
 * carrying dev's structure and no migration record (Replit's publish copies the
 * schema and offers no skip), and the runner refuses exactly that state
 * (lib/db/src/migrate.ts). The runner is unchanged: this is a one-time operator
 * step, run on David's go, and the one place "built from code" is satisfied by
 * "proven identical to what the code builds".
 *
 * What is compared, and what is normalised (plan, step 3): the `public` and
 * `drizzle` schemas, as a relation inventory by kind and persistence,
 * `catalogFingerprint`'s columns/constraints/indexes/functions/triggers/enums,
 * every trigger's firing mode, every sequence's full definition and ownership,
 * and the extension set with its schemas. Normalised: column order, owners and
 * grants, and an extension's version (printed, not compared).
 *
 * Amendment 3 (docs/plans/PLAN_PHASE3_AMENDMENT_3.md, David 2026-10-30, "Go
 * with option 1"): production as Replit left it has no `drizzle` schema and
 * carries Replit's own publish record in `_system`. The ledger's schema is
 * optional; when it is absent the transaction creates it with the runner's own
 * statements and proves it equal to the reference's before the commit.
 * `_system` is tolerated and exempt from the zero-row check only. A missing
 * compared schema is a named difference, never an error.
 *
 * What is installed (step 4): the reference's rows, by ordinary inserts in
 * foreign-key order with every constraint and trigger enabled (no superuser
 * privilege, which Neon does not give), its complete ledger, and each
 * sequence's next value by `RESTART`, which a rollback undoes. Verified inside
 * the transaction before the commit.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import pg from "pg";

import { catalogFingerprint } from "@workspace/db/baseline";
import { MIGRATION_LOCK_KEY } from "@workspace/db/migrate";

import { databaseUrl } from "./devRebuild.js";

/** The schemas production may hold: the application's, the ledger's, and those D4, the Stripe mirror and Replit account for. */
export const REQUIRED_SCHEMAS = ["public"] as const;
export const LEDGER_SCHEMA = "drizzle";
export const TOLERATED_SCHEMAS = ["stripe", "heliumdb_test", "drizzle_test", "_system"] as const;
/** Replit's publish record: tolerated, never compared, and its rows are Replit's. */
const ROW_CHECK_EXEMPT = ["_system"];
const COMPARED_SCHEMAS = ["public", LEDGER_SCHEMA] as const;
const LEDGER = "drizzle.__drizzle_migrations";

/**
 * The runner's own statements for the ledger (lib/db/src/migrate.ts, the
 * baseline path and the pending path alike). Copied rather than imported so
 * the runner stays unedited; the in-transaction comparison with the
 * reference, which the runner built, is what proves the copy faithful.
 */
const LEDGER_DDL = [
  `CREATE SCHEMA IF NOT EXISTS "${LEDGER_SCHEMA}"`,
  `CREATE TABLE IF NOT EXISTS "${LEDGER_SCHEMA}".__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )`,
];

export interface AdoptReport {
  verdict: "adopted" | "refused";
  reasons: string[];
  reference: { database: string; ledgerEntries: number };
  eligibility: { ledgerRows: number | null; totalRows: number | null; schemas: string[]; ledgerCreated: boolean };
  structure: { productionLines: number; referenceLines: number; onlyInProduction: string[]; onlyInReference: string[] };
  extensions: { production: Record<string, string>; reference: Record<string, string> };
  diagnosis: Array<{ line: string; side: "production" | "reference"; inDev: boolean; origin: "dev drift" | "transfer" }>;
  installed: { tables: Record<string, number>; ledgerEntries: number; sequences: number } | null;
}

export interface AdoptOptions {
  /** RESET_PRODUCTION_DATABASE_URL: the new production database. */
  productionUrl: string;
  /** Dev's database; its server hosts the reference, and dev is read for the diagnosis only. */
  devUrl: string;
  /** Runs `lib/db/src/migrate.ts` against a database URL: the runner and nothing else. */
  migrate?: (url: string) => void;
  /** Test seam: runs inside the installation transaction after the sequences are moved. */
  afterSequences?: (client: pg.ClientBase) => Promise<void>;
}

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => {});
  await c.connect();
  return c;
}

const q = (s: string) => `"${s.replaceAll('"', '""')}"`;

function defaultMigrate(url: string): void {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");
  execFileSync("npx", ["tsx", "lib/db/src/migrate.ts"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: url, PGOPTIONS: "" },
    stdio: "pipe",
  });
}

/** Every user schema in the database. */
async function schemas(c: pg.ClientBase): Promise<string[]> {
  const { rows } = await c.query<{ s: string }>(
    "SELECT nspname AS s FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1",
  );
  return rows.map((r) => r.s);
}

async function ledgerRows(c: pg.ClientBase): Promise<number | null> {
  const { rows } = await c.query<{ p: boolean }>("SELECT to_regclass($1) IS NOT NULL AS p", [LEDGER]);
  if (!rows[0].p) return null;
  return Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${LEDGER}`)).rows[0].n);
}

/** Rows in every table of every user schema but Replit's own record. */
async function totalRows(c: pg.ClientBase): Promise<number> {
  const { rows } = await c.query<{ s: string; t: string }>(
    `SELECT schemaname AS s, tablename AS t FROM pg_tables
     WHERE schemaname NOT LIKE 'pg\\_%' AND schemaname <> 'information_schema' AND schemaname <> ALL($1)`,
    [ROW_CHECK_EXEMPT],
  );
  let n = 0;
  for (const r of rows) n += Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${q(r.s)}.${q(r.t)}`)).rows[0].n);
  return n;
}

/** Installed extensions: name -> version, plus `name@schema` lines for the comparison. */
async function extensions(c: pg.ClientBase): Promise<{ versions: Record<string, string>; lines: string[] }> {
  const { rows } = await c.query<{ n: string; v: string; s: string }>(
    "SELECT extname AS n, extversion AS v, extnamespace::regnamespace::text AS s FROM pg_extension ORDER BY 1",
  );
  return { versions: Object.fromEntries(rows.map((r) => [r.n, r.v])), lines: rows.map((r) => `extension ${r.n} in ${r.s}`) };
}

/**
 * One schema's structure as comparable lines: `catalogFingerprint`, plus what it
 * cannot see — the relation inventory with persistence, trigger firing modes,
 * and sequences' full definitions and ownership.
 */
async function schemaStructure(c: pg.ClientBase, schema: string): Promise<string[]> {
  const { rows: present } = await c.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema]);
  if (present.length === 0) return [`${schema}: schema absent`];
  const lines = (await catalogFingerprint(c, schema)).map((l) => `${schema}: ${l}`);
  const rel = await c.query<{ n: string; k: string; p: string }>(
    "SELECT relname AS n, relkind AS k, relpersistence AS p FROM pg_class WHERE relnamespace = $1::regnamespace",
    [schema],
  );
  for (const r of rel.rows) lines.push(`${schema}: relation ${r.n} kind ${r.k} persistence ${r.p}`);
  const trg = await c.query<{ t: string; n: string; m: string }>(
    `SELECT c.relname AS t, t.tgname AS n, t.tgenabled AS m FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = $1::regnamespace AND NOT t.tgisinternal`,
    [schema],
  );
  for (const r of trg.rows) lines.push(`${schema}: trigger-mode ${r.t}.${r.n} ${r.m}`);
  const seq = await c.query<Record<string, string>>(
    `SELECT sequencename AS n, data_type::text AS dt, start_value::text AS st, min_value::text AS mn, max_value::text AS mx,
            increment_by::text AS inc, cycle::text AS cy, cache_size::text AS ca
     FROM pg_sequences WHERE schemaname = $1`,
    [schema],
  );
  for (const r of seq.rows) {
    lines.push(`${schema}: sequence-def ${r.n} ${r.dt} start ${r.st} min ${r.mn} max ${r.mx} inc ${r.inc} cycle ${r.cy} cache ${r.ca}`);
  }
  const own = await c.query<{ s: string; t: string | null; col: string | null; d: string }>(
    `SELECT s.relname AS s, t.relname AS t, a.attname AS col, d.deptype AS d
     FROM pg_class s
     LEFT JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a','i')
     LEFT JOIN pg_class t ON t.oid = d.refobjid
     LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
     WHERE s.relkind = 'S' AND s.relnamespace = $1::regnamespace`,
    [schema],
  );
  for (const r of own.rows) lines.push(`${schema}: sequence-owner ${r.s} ${r.t ? `${r.t}.${r.col} (${r.d})` : "none"}`);
  return lines;
}

export async function structure(
  c: pg.ClientBase,
  compared: readonly string[] = COMPARED_SCHEMAS,
): Promise<{ lines: string[]; versions: Record<string, string> }> {
  const lines: string[] = [];
  for (const s of compared) lines.push(...(await schemaStructure(c, s)));
  const ext = await extensions(c);
  lines.push(...ext.lines);
  return { lines: lines.sort(), versions: ext.versions };
}

function diff(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
  const sa = new Set(a);
  const sb = new Set(b);
  return { onlyA: a.filter((l) => !sb.has(l)), onlyB: b.filter((l) => !sa.has(l)) };
}

/** Public tables with rows in the reference, parents before children (foreign keys between them). */
async function populatedTablesInOrder(ref: pg.ClientBase): Promise<string[]> {
  const { rows } = await ref.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'");
  const populated: string[] = [];
  for (const { t } of rows) {
    if (Number((await ref.query<{ n: string }>(`SELECT count(*) AS n FROM public.${q(t)}`)).rows[0].n) > 0) populated.push(t);
  }
  const fk = await ref.query<{ c: string; p: string }>(
    `SELECT cl.relname AS c, pr.relname AS p FROM pg_constraint co
     JOIN pg_class cl ON cl.oid = co.conrelid JOIN pg_class pr ON pr.oid = co.confrelid
     WHERE co.contype = 'f' AND cl.relnamespace = 'public'::regnamespace AND pr.relnamespace = 'public'::regnamespace AND cl.oid <> pr.oid`,
  );
  const set = new Set(populated);
  const parents = new Map<string, Set<string>>(populated.map((t) => [t, new Set<string>()]));
  for (const r of fk.rows) if (set.has(r.c) && set.has(r.p)) parents.get(r.c)!.add(r.p);
  const order: string[] = [];
  const placed = new Set<string>();
  while (order.length < populated.length) {
    const ready = populated.filter((t) => !placed.has(t) && [...parents.get(t)!].every((p) => placed.has(p))).sort();
    if (ready.length === 0) throw new Error(`a foreign-key cycle among populated tables: ${populated.filter((t) => !placed.has(t)).join(", ")}`);
    for (const t of ready) {
      order.push(t);
      placed.add(t);
    }
  }
  return order;
}

async function insertableColumns(c: pg.ClientBase, table: string): Promise<string[]> {
  const { rows } = await c.query<{ n: string }>(
    `SELECT a.attname AS n FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '' ORDER BY a.attnum`,
    [table],
  );
  return rows.map((r) => r.n);
}

async function rowsJson(c: pg.ClientBase, table: string): Promise<unknown[]> {
  return (await c.query<{ j: unknown }>(`SELECT to_jsonb(t) AS j FROM ${table} t`)).rows.map((r) => r.j);
}

async function rowHashes(c: pg.ClientBase, table: string): Promise<string[]> {
  return (await c.query<{ h: string }>(`SELECT md5(to_jsonb(t)::text) AS h FROM ${table} t ORDER BY 1`)).rows.map((r) => r.h);
}

interface SequenceState {
  schema: string;
  name: string;
  next: string;
  identity: { table: string; column: string } | null;
}

/** Each sequence in the compared schemas with the value its next call would return. */
async function sequenceStates(c: pg.ClientBase): Promise<SequenceState[]> {
  const { rows } = await c.query<{ sc: string; n: string; inc: string; t: string | null; col: string | null; d: string | null }>(
    `SELECT n.nspname AS sc, s.relname AS n, ps.increment_by::text AS inc, t.relname AS t, a.attname AS col, d.deptype AS d
     FROM pg_class s JOIN pg_namespace n ON n.oid = s.relnamespace
     JOIN pg_sequences ps ON ps.schemaname = n.nspname AND ps.sequencename = s.relname
     LEFT JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype = 'i'
     LEFT JOIN pg_class t ON t.oid = d.refobjid
     LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
     WHERE s.relkind = 'S' AND n.nspname = ANY($1) ORDER BY 1, 2`,
    [[...COMPARED_SCHEMAS]],
  );
  const out: SequenceState[] = [];
  for (const r of rows) {
    const { rows: st } = await c.query<{ lv: string; ic: boolean }>(`SELECT last_value::text AS lv, is_called AS ic FROM ${q(r.sc)}.${q(r.n)}`);
    const next = st[0].ic ? (BigInt(st[0].lv) + BigInt(r.inc)).toString() : st[0].lv;
    out.push({ schema: r.sc, name: r.n, next, identity: r.d === "i" && r.t && r.col ? { table: r.t, column: r.col } : null });
  }
  return out;
}

/**
 * The adoption. Refuses, changing nothing, unless production is empty of rows
 * and ledger, holds only known schemas, and is structurally equal to the
 * reference; then installs the reference's rows, ledger and sequence positions
 * in one transaction, verified before the commit.
 */
export async function adoptProduction(opts: AdoptOptions): Promise<AdoptReport> {
  const migrate = opts.migrate ?? defaultMigrate;
  const refName = `adopt_reference_${crypto.randomBytes(3).toString("hex")}`;
  const refUrl = databaseUrl(opts.devUrl, refName);
  const report: AdoptReport = {
    verdict: "refused",
    reasons: [],
    reference: { database: refName, ledgerEntries: 0 },
    eligibility: { ledgerRows: null, totalRows: null, schemas: [], ledgerCreated: false },
    structure: { productionLines: 0, referenceLines: 0, onlyInProduction: [], onlyInReference: [] },
    extensions: { production: {}, reference: {} },
    diagnosis: [],
    installed: null,
  };

  const control = await connect(opts.devUrl);
  let refCreated = false;
  try {
    // 1. The reference: the runner and nothing else.
    await control.query(`CREATE DATABASE ${q(refName)} TEMPLATE template0`);
    refCreated = true;
    migrate(refUrl);
    const ref = await connect(refUrl);
    const prod = await connect(opts.productionUrl);
    let locked = false;
    try {
      report.reference.ledgerEntries = (await ledgerRows(ref)) ?? 0;

      // 2. Eligibility, under the runner's lock, held to the commit.
      await prod.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
      locked = true;
      report.eligibility.schemas = await schemas(prod);
      report.eligibility.ledgerRows = await ledgerRows(prod);
      report.eligibility.totalRows = await totalRows(prod);
      for (const s of REQUIRED_SCHEMAS) if (!report.eligibility.schemas.includes(s)) report.reasons.push(`production has no ${s} schema`);
      const known = new Set<string>([...REQUIRED_SCHEMAS, LEDGER_SCHEMA, ...TOLERATED_SCHEMAS]);
      const unknown = report.eligibility.schemas.filter((s) => !known.has(s));
      if (unknown.length > 0) report.reasons.push(`production holds unrecognised schema(s): ${unknown.join(", ")}`);
      if (report.eligibility.ledgerRows !== null && report.eligibility.ledgerRows > 0) {
        report.reasons.push(`production's migration ledger already records ${report.eligibility.ledgerRows} migration(s)`);
      }
      if (report.eligibility.totalRows > 0) report.reasons.push(`production holds ${report.eligibility.totalRows} row(s); adoption needs an empty database`);

      // 3. The structural proof. Without a ledger schema, `public` and the
      // extensions are compared here and the ledger inside the transaction,
      // once it is created (amendment 3).
      const ledgerAbsent = !report.eligibility.schemas.includes(LEDGER_SCHEMA);
      const compared = ledgerAbsent ? COMPARED_SCHEMAS.filter((s) => s !== LEDGER_SCHEMA) : COMPARED_SCHEMAS;
      const p = await structure(prod, compared);
      const r = await structure(ref, compared);
      report.extensions = { production: p.versions, reference: r.versions };
      const d = diff(p.lines, r.lines);
      report.structure = { productionLines: p.lines.length, referenceLines: r.lines.length, onlyInProduction: d.onlyA, onlyInReference: d.onlyB };
      if (d.onlyA.length + d.onlyB.length > 0) {
        report.reasons.push(`production's structure differs from the code's: ${d.onlyA.length} line(s) only in production, ${d.onlyB.length} only in the reference`);
        // 5. Three-way diagnosis: does dev share the difference?
        const dev = await connect(opts.devUrl);
        try {
          const devLines = new Set((await structure(dev, compared)).lines);
          for (const line of d.onlyA) report.diagnosis.push({ line, side: "production", inDev: devLines.has(line), origin: devLines.has(line) ? "dev drift" : "transfer" });
          for (const line of d.onlyB) report.diagnosis.push({ line, side: "reference", inDev: devLines.has(line), origin: devLines.has(line) ? "transfer" : "dev drift" });
        } finally {
          await dev.end();
        }
      }
      if (report.reasons.length > 0) return report;

      // 4. Installation, in one transaction on the lock-holding connection.
      const tables = await populatedTablesInOrder(ref);
      const refSeqs = await sequenceStates(ref);
      await prod.query("BEGIN");
      try {
        const installed: Record<string, number> = {};
        if (ledgerAbsent) {
          for (const ddl of LEDGER_DDL) await prod.query(ddl);
          const a = (await schemaStructure(prod, LEDGER_SCHEMA)).sort();
          const b = (await schemaStructure(ref, LEDGER_SCHEMA)).sort();
          const d = diff(a, b);
          if (d.onlyA.length + d.onlyB.length > 0) {
            throw new Error(`the created ledger differs from the reference's: ${[...d.onlyA.map((l) => `+ ${l}`), ...d.onlyB.map((l) => `- ${l}`)].join("; ")}`);
          }
        }
        for (const t of [...tables.map((x) => `public.${q(x)}`), LEDGER]) {
          const cols = (await insertableColumns(ref, t)).map(q).join(", ");
          const rows = await rowsJson(ref, t);
          await prod.query(
            `INSERT INTO ${t} (${cols}) OVERRIDING SYSTEM VALUE SELECT ${cols} FROM jsonb_populate_recordset(NULL::${t}, $1::jsonb)`,
            [JSON.stringify(rows)],
          );
          installed[t] = rows.length;
        }
        for (const s of refSeqs) {
          if (s.identity) {
            await prod.query(`ALTER TABLE ${q(s.schema)}.${q(s.identity.table)} ALTER COLUMN ${q(s.identity.column)} RESTART WITH ${s.next}`);
          } else {
            await prod.query(`ALTER SEQUENCE ${q(s.schema)}.${q(s.name)} RESTART WITH ${s.next}`);
          }
        }
        if (opts.afterSequences) await opts.afterSequences(prod);

        // Verified before the commit.
        const problems: string[] = [];
        for (const t of [...tables.map((x) => `public.${q(x)}`), LEDGER]) {
          const a = await rowHashes(prod, t);
          const b = await rowHashes(ref, t);
          if (a.join() !== b.join()) problems.push(`${t}: installed rows differ from the reference's`);
        }
        const prodSeqs = new Map((await sequenceStates(prod)).map((s) => [`${s.schema}.${s.name}`, s.next]));
        for (const s of refSeqs) {
          if (prodSeqs.get(`${s.schema}.${s.name}`) !== s.next) problems.push(`sequence ${s.schema}.${s.name}: next value ${prodSeqs.get(`${s.schema}.${s.name}`)}, reference ${s.next}`);
        }
        if (problems.length > 0) throw new Error(problems.join("; "));
        await prod.query("COMMIT");
        report.installed = { tables: installed, ledgerEntries: installed[LEDGER] ?? 0, sequences: refSeqs.length };
        report.eligibility.ledgerCreated = ledgerAbsent;
        report.verdict = "adopted";
        return report;
      } catch (err) {
        await prod.query("ROLLBACK").catch(() => {});
        report.reasons.push(`installation rolled back: ${(err as Error).message}`);
        return report;
      }
    } finally {
      if (locked) await prod.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
      await prod.end();
      await ref.end();
    }
  } finally {
    if (refCreated) await control.query(`DROP DATABASE IF EXISTS ${q(refName)} WITH (FORCE)`).catch(() => {});
    await control.end();
  }
}
