/**
 * Migration 0165 (plan docs/plans/PLAN_FACT_HOUSE_STYLE.md, *The one-time
 * pass*): its SQL twin of the house style agrees with `applyHouseStyle`, and
 * the pass itself tidies every fact and pending submission, keeps the
 * plain-name version and draft ideas in step, restores the wording lock, and
 * writes nothing on a second run.
 *
 * Everything runs on one connection, because the migration's functions live
 * in that session's pg_temp, and the pass runs inside a transaction that is
 * rolled back: it rewrites every fact in the shard's shared database, and other
 * tests' facts must not change under them.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "@workspace/db";
import { applyHouseStyle } from "../lib/templateGrammar.js";
import { renderCanonical } from "../lib/renderCanonical.js";
import { HOUSE_STYLE_TABLE } from "./helpers/houseStyleCases.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../..");
const MIGRATION = readFileSync(path.join(ROOT, "lib/db/migrations/0165_fact_house_style_pass.sql"), "utf8");
const STATEMENTS = MIGRATION.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
const FUNCTIONS = STATEMENTS.slice(0, -1);
const PASS = STATEMENTS.at(-1)!;

/** A corpus beyond the table: every opener × body × ending combination. */
function corpus(): string[] {
  const openers = ["", "(", "\"", "'", "[", "¿", "“"];
  const bodies = [
    "chuck wins", "{SUBJ} wins", "{does|do} {SUBJ} win", "iPhone fears {NAME}", "{NAME} said 'no",
    "a (b) c", "  two   spaces ", "{NAME}'s dog", "ex-Marine {NAME}", "élan of {NAME}",
  ];
  const endings = ["", ".", ",", ";", "!", "?!", "…", ")", "\")", "'", "’", " 🏆", " 👍🏽", ":)", " (Twice.)", "™", "\"", "”", "]"];
  const out: string[] = [];
  for (const o of openers) for (const b of bodies) for (const e of endings) out.push(o + b + e);
  return out;
}

let client: PoolClient;

before(async () => {
  client = await pool.connect();
  for (const statement of FUNCTIONS) await client.query(statement);
});

after(async () => {
  client.release(true);
});

async function sqlStyle(texts: readonly string[]): Promise<string[]> {
  const { rows } = await client.query<{ out: string }>(
    "SELECT pg_temp.house_style(t) AS out FROM unnest($1::text[]) WITH ORDINALITY AS u(t, n) ORDER BY n",
    [texts],
  );
  return rows.map((r) => r.out);
}

describe("migration 0165's SQL rule matches applyHouseStyle", () => {
  it("on every row of the rule table, and on each result", async () => {
    const inputs = HOUSE_STYLE_TABLE.flatMap(([input, expected]) => [input, expected]);
    const got = await sqlStyle(inputs);
    inputs.forEach((input, i) => assert.equal(got[i], applyHouseStyle(input), JSON.stringify(input)));
  });

  it("on every combination of opener, body and ending", async () => {
    const inputs = corpus();
    const got = await sqlStyle(inputs);
    const diffs = inputs.flatMap((input, i) => (got[i] === applyHouseStyle(input) ? [] : [`${JSON.stringify(input)}: sql ${JSON.stringify(got[i])}, ts ${JSON.stringify(applyHouseStyle(input))}`]));
    assert.deepEqual(diffs, []);
  });

  it("on the emoji ending, over every code point", async () => {
    const cls = /\[(\\u00A9[^\]]*)\]\$/.exec(MIGRATION)?.[1];
    assert.ok(cls, "the emoji class is in the migration");
    const { rows } = await client.query<{ cps: number[] | null }>(
      `SELECT array_agg(cp ORDER BY cp) AS cps FROM generate_series(1, 1114111) cp
        WHERE (cp < 55296 OR cp > 57343) AND chr(cp) ~ ('^[' || $1 || ']$')`,
      [cls],
    );
    const re = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}\uFE0F\u20E3\u200D\u{E0020}-\u{E007F}])$/u;
    const js: number[] = [];
    for (let cp = 1; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (re.test(String.fromCodePoint(cp))) js.push(cp);
    }
    assert.deepEqual(rows[0]!.cps, js);
  });

  it("on capitalizing a first letter, over every Latin letter", async () => {
    // U+019B's capital (U+A7DC, Unicode 16) is newer than the database's case
    // tables; the post-merge check counts any fact the two disagree on.
    const inputs: string[] = [];
    for (let cp = 0x20; cp < 0x250; cp++) if (cp !== 0x19b && cp !== 0x7f) inputs.push(String.fromCodePoint(cp) + "x wins");
    const got = await sqlStyle(inputs);
    const diffs = inputs.flatMap((input, i) => (got[i] === applyHouseStyle(input) ? [] : [`U+${input.codePointAt(0)!.toString(16)}: sql ${got[i]}, ts ${applyHouseStyle(input)}`]));
    assert.deepEqual(diffs, []);
  });
});

describe("migration 0165's pass", () => {
  const tag = `t_hs_${randomUUID().slice(0, 8)}`;
  const rows = [
    { text: `chuck norris ${tag} can divide by zero`, canonical: true, ideas: true },
    { text: `{does|do} {SUBJ} ever lose ${tag}`, canonical: true, ideas: false },
    { text: `{NAME} beats ${tag} {NAME}`, canonical: true, ideas: true },
    { text: `{SUBJ} counted ${tag} (Twice.)`, canonical: false, ideas: false },
    { text: `Already tidy ${tag}.`, canonical: true, ideas: true },
  ];

  it("tidies facts and pending submissions, keeps canonical and ideas in step, restores the lock, and is idempotent", async () => {
    const notices: string[] = [];
    const onNotice = (n: { message?: string }) => { if (n.message?.startsWith("[0165]")) notices.push(n.message); };
    client.on("notice", onNotice);
    await client.query("BEGIN");
    try {
      const ids: number[] = [];
      for (const r of rows) {
        const blob = r.ideas ? JSON.stringify({ candidates: [], inputHash: "h", reviewId: 1, source: "staging_fact" }) : null;
        const { rows: [inserted] } = await client.query<{ id: number }>(
          "INSERT INTO facts (text, canonical_text, visual_concept_candidates) VALUES ($1, $2, $3::jsonb) RETURNING id",
          [r.text, r.canonical ? renderCanonical(r.text) : null, blob],
        );
        ids.push(inserted!.id);
      }
      const { rows: [pending] } = await client.query<{ id: number }>(
        "INSERT INTO pending_reviews (submitted_text, submitted_text_original, status) VALUES ($1, $1, 'pending') RETURNING id",
        [`a pending ${tag} fact,`],
      );
      const { rows: [decided] } = await client.query<{ id: number }>(
        "INSERT INTO pending_reviews (submitted_text, status) VALUES ($1, 'rejected') RETURNING id",
        [`a decided ${tag} fact`],
      );

      await client.query(PASS);

      const { rows: after } = await client.query<{ id: number; text: string; canonical_text: string | null; visual_concept_candidates: Record<string, unknown> | null }>(
        "SELECT id, text, canonical_text, visual_concept_candidates FROM facts WHERE id = ANY($1::int[])", [ids],
      );
      for (const [i, r] of rows.entries()) {
        const row = after.find((a) => a.id === ids[i])!;
        assert.equal(row.text, applyHouseStyle(r.text), r.text);
        assert.equal(row.canonical_text, r.canonical ? renderCanonical(row.text) : null, `canonical of ${r.text}`);
        const changed = applyHouseStyle(r.text) !== r.text;
        if (r.ideas) assert.equal(row.visual_concept_candidates?.factTextUsed, changed ? r.text : undefined, `ideas of ${r.text}`);
      }

      const { rows: reviews } = await client.query<{ id: number; submitted_text: string; submitted_text_original: string | null }>(
        "SELECT id, submitted_text, submitted_text_original FROM pending_reviews WHERE id = ANY($1::int[])", [[pending!.id, decided!.id]],
      );
      const p = reviews.find((r) => r.id === pending!.id)!;
      assert.equal(p.submitted_text, `A pending ${tag} fact.`);
      assert.equal(p.submitted_text_original, `a pending ${tag} fact,`, "the wording as typed is history");
      assert.equal(reviews.find((r) => r.id === decided!.id)!.submitted_text, `a decided ${tag} fact`, "a decided review is untouched");

      const { rows: [untidy] } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM facts WHERE text IS DISTINCT FROM pg_temp.house_style(text)",
      );
      assert.equal(untidy!.n, 0, "no fact is left untidy");
      const { rows: all } = await client.query<{ text: string }>("SELECT text FROM facts");
      assert.deepEqual(all.filter((f) => applyHouseStyle(f.text) !== f.text).map((f) => f.text), [], "TypeScript agrees every fact is tidy");

      await client.query("SAVEPOINT lock_check");
      await assert.rejects(
        client.query("UPDATE facts SET text = 'changed' WHERE id = $1", [ids[0]]),
        /cannot change once it exists/,
        "the wording lock is back on",
      );
      await client.query("ROLLBACK TO SAVEPOINT lock_check");

      await client.query(PASS);
      assert.equal(notices.length, 2);
      assert.match(notices[1]!, /changed: 0,.*recorded: 0; pending submissions tidied: 0/, "a second run writes nothing");
    } finally {
      await client.query("ROLLBACK");
      client.off("notice", onNotice);
    }
  });

  it("leaves the wording lock in place when the pass fails after lifting it", async () => {
    const failing = PASS.replace("ALTER TABLE facts ENABLE TRIGGER facts_text_is_locked;", "RAISE EXCEPTION 'forced failure';");
    assert.notEqual(failing, PASS, "the failure is injected after the lock is lifted");
    await client.query("BEGIN");
    try {
      await assert.rejects(client.query(failing), /forced failure/);
    } finally {
      await client.query("ROLLBACK");
    }
    const { rows: [trigger] } = await client.query<{ tgenabled: string }>(
      "SELECT tgenabled FROM pg_trigger WHERE tgname = 'facts_text_is_locked'",
    );
    assert.equal(trigger!.tgenabled, "O", "the lock trigger is enabled");
  });
});
