/**
 * The legacy fixture, end to end (Launch Phase 2, increment 5; #631; plan D9).
 *
 * - The scrub case: a scratch source seeded with a planted value in every
 *   excluded class and every transformed location — on active-fact records —
 *   is exported, and no planted byte, source user id or source media path
 *   appears anywhere in the output.
 * - The refusal case, run separately so an early refusal can never stand in for
 *   the scrub evidence: a Stripe key planted in admin_config stops the export
 *   before any file is written.
 * - The load: that export loads into a fresh database; row counts, sequences
 *   and the loader's refusals hold, and the freshness predicates come back as
 *   recorded (the loader re-checks them with the real readers).
 * - The committed fixture: loads, takes the account seed after it, and the app
 *   boots over it with the doubles and no credential; the admin readers and
 *   every media consumer present in it answer through their real routes.
 *
 * Every tool runs as a child process against a scratch database it names, so
 * the app's database singleton in each process points where that tool works.
 * The scratch databases come from one template built the canonical way (schema
 * push, then migrations); nothing here dumps or copies an existing database.
 * Refused where databases cannot be created (the Repl's schema-isolated runner):
 * the CI database-isolated runner is where this evidence is produced.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import bcrypt from "bcryptjs";

import { markTestDatabaseSql } from "@workspace/db/test-database";

import { KEPT_FACT_TEXT, SENTINELS } from "./helpers/legacyFixtureSentinels";
import { objectPathOf } from "../testing/legacyFixture/media";
import { readManifest, readRows } from "../testing/legacyFixture/load";
import { LocalObjectStorage } from "../lib/localObjectStorage";
import { portForChildProcess } from "./helpers/childProcessPort";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(HERE, "..", "..");
const REPO_ROOT = path.resolve(API_ROOT, "..", "..");
const COMMITTED_FIXTURE = path.join(API_ROOT, "fixtures", "legacy");

const worker = new URL(process.env.DATABASE_URL ?? "postgres://invalid/none");
const control = new URL(worker.href);
control.pathname = "/postgres";
control.search = "";
const urlFor = (name: string) => {
  const u = new URL(control.href);
  u.pathname = `/${name}`;
  return u.href;
};

function psql(url: string, sql: string): { ok: boolean; stderr: string } {
  const r = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { encoding: "utf8" });
  return { ok: r.status === 0, stderr: r.stderr ?? "" };
}

const tag = `${process.pid}_${Date.now() % 1_000_000}`;
const skipReason = (() => {
  if (worker.searchParams.has("options")) return "schema-isolated test database (the Repl): scratch databases cannot be created here; CI runs this";
  const probe = `lf_probe_${tag}`;
  if (!psql(control.href, `CREATE DATABASE "${probe}"`).ok) return "this role cannot create databases; CI runs this";
  psql(control.href, `DROP DATABASE IF EXISTS "${probe}"`);
  return undefined;
})();

const created: string[] = [];
const template = `lf_tmpl_${tag}`;
function createDatabase(name: string, opts: { mark?: boolean } = {}): string {
  const r = psql(control.href, `CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  assert.ok(r.ok, `CREATE DATABASE ${name}: ${r.stderr}`);
  created.push(name);
  if (opts.mark !== false) assert.ok(psql(control.href, markTestDatabaseSql(`"${name}"`)).ok);
  return urlFor(name);
}

function tsx(script: string, args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx/esm", script, ...args], {
    cwd: API_ROOT,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: "utf8",
    timeout: 240_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-fixture-"));
const storageEnv = (dir: string) => ({
  STORAGE_BACKEND: "local-double",
  STORAGE_DOUBLE_DIR: dir,
  PRIVATE_OBJECT_DIR: "/fixture-bucket/private",
  PUBLIC_OBJECT_SEARCH_PATHS: "/fixture-bucket/public",
});

async function query<T extends pg.QueryResultRow>(url: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

/** The seed's report: its last stdout line that is a JSON object (the logger can interleave). */
function lastJsonLine(stdout: string): Record<string, unknown> {
  const line = stdout.split("\n").reverse().find((l) => l.startsWith("{\""));
  assert.ok(line, `the seed printed no report:\n${stdout}`);
  return JSON.parse(line);
}

function allBytes(dir: string): string {
  return fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
}

describe("the legacy fixture", { skip: skipReason }, () => {
  let seeded: Record<string, unknown>;
  const out = path.join(scratch, "export");

  before(() => {
    assert.ok(psql(control.href, `CREATE DATABASE "${template}"`).ok);
    created.push(template);
    assert.ok(psql(control.href, markTestDatabaseSql(`"${template}"`)).ok);
    assert.ok(psql(urlFor(template), "CREATE EXTENSION IF NOT EXISTS vector").ok);
    for (const step of [["--filter", "@workspace/db", "push-force"], ["--filter", "@workspace/db", "run", "migrate"]]) {
      const r = spawnSync("pnpm", step, { cwd: REPO_ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: urlFor(template) }, encoding: "utf8" });
      assert.equal(r.status, 0, `pnpm ${step.join(" ")}: ${r.stderr}`);
    }
  });

  after(() => {
    for (const name of created.reverse()) psql(control.href, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("the scrub case: no planted value, source id or source media path leaves the source", () => {
    const source = createDatabase(`lf_src_${tag}`);
    const seed = tsx("src/__tests__/helpers/legacyFixtureSeed.ts", [], { DATABASE_URL: source, LOG_LEVEL: "warn" });
    assert.equal(seed.status, 0, seed.stderr);
    seeded = lastJsonLine(seed.stdout);
    assert.equal(seeded.renderContextOk, true);
    assert.equal(seeded.conceptCycleOk, true);

    const exp = tsx("scripts/export-legacy-fixture.ts", ["--out", out], { DATABASE_URL: source });
    assert.equal(exp.status, 0, `${exp.stdout}\n${exp.stderr}`);

    const bytes = allBytes(out);
    for (const [name, value] of Object.entries(SENTINELS)) {
      if (name === "stripeKey") continue;
      assert.ok(!bytes.includes(value), `the planted ${name} reached the output`);
    }
    for (const k of ["userId", "adminId", "otherId", "legacyBackground", "newerPath", "uploadPath", "profilePath", "matchedPath"]) {
      assert.ok(!bytes.includes(String(seeded[k])), `the source ${k} reached the output`);
    }
    assert.ok(!/zqx/i.test(bytes), "a planted marker reached the output");

    const manifest = readManifest(out);
    assert.deepEqual(manifest.excludedByPredicate, { membership_entitlements: 2, membership_history: 1 }, "live-mode and unsynced payment rows must be excluded");
    assert.deepEqual(manifest.predicateCounts, {
      renderAttempts: { current: 1, stale: 1 },
      candidateTextHash: { current: 1 },
      conceptBlobs: { current: 1, "stale:input_hash_mismatch": 1 },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions walk the rows' JSON freely
    const rows = (t: string) => readRows(out, t) as Array<Record<string, any>>;
    const facts = rows("facts");
    const active = facts.find((f) => f.id === seeded.activeFactId)!;
    const pending = facts.find((f) => f.id === seeded.pendingFactId)!;
    // Plan D4: only an active fact, and a review of its own fact, keep the live text (Codex round 1).
    const duplicateFact = facts.find((f) => f.id === seeded.duplicateFactId)!;
    assert.notEqual(duplicateFact.text, KEPT_FACT_TEXT, "an inactive duplicate of the live text gets a placeholder");
    const duplicateReview = rows("pending_reviews").find((r) => r.id === seeded.duplicateReviewId)!;
    assert.notEqual(duplicateReview.submitted_text, KEPT_FACT_TEXT, "a review not of its own live fact gets a placeholder");
    assert.equal(active.text, KEPT_FACT_TEXT, "the live text of an active fact is kept");
    assert.match(pending.text, /\(case [0-9a-f]{6}\)\.$/, "a pending fact's text is a placeholder");
    assert.equal(pending.enrichment.visualPromptStrategyOverride.coreSceneOverride, "", "a blank core scene stays blank");
    assert.deepEqual(pending.enrichment.visualPromptStrategyOverride.bubbles, [{ type: "speech", entity: "subject", text: "" }], "a half-filled bubble stays half-filled");
    assert.equal(active.ai_meme_images.male[1], "", "a deleted gallery slot stays deleted");
    const ai = rows("user_ai_images");
    const gallery = active.ai_meme_images.male as string[];
    assert.ok(ai.every((r) => gallery.includes(r.storage_path)), "a shared object keeps one path across the gallery and its tracking rows");
    const attempt = rows("image_prompt_attempts").find((a) => a.render_controls?.promptIdentity);
    assert.ok(gallery.includes(attempt!.generated_image_object_path), "the producing attempt holds the same path");
    const reviews = rows("pending_reviews");
    assert.ok(reviews.some((r) => r.submitted_text === KEPT_FACT_TEXT), "the refresh of the live fact keeps the live text");
    assert.ok(!reviews.some((r) => r.status === "approved" && r.submitted_text === KEPT_FACT_TEXT), "an older approved wording is not the live text");
  });

  it("the snapshot: a change after the row read does not reach the recorded predicates, and a recycled connection stops the export", () => {
    const source = createDatabase(`lf_snp_${tag}`);
    const seed = tsx("src/__tests__/helpers/legacyFixtureSeed.ts", [], { DATABASE_URL: source, LOG_LEVEL: "warn" });
    assert.equal(seed.status, 0, seed.stderr);
    const ids = lastJsonLine(seed.stdout);
    const probe = (...args: string[]) => {
      const r = tsx("src/__tests__/helpers/legacyFixtureSnapshotProbe.ts", args, { DATABASE_URL: source, LOG_LEVEL: "warn" });
      assert.equal(r.status, 0, r.stderr);
      return lastJsonLine(r.stdout);
    };
    const concurrent = probe("concurrent", String(ids.currentRenderId));
    assert.equal(concurrent.stopped, false, String(concurrent.reason));
    assert.equal(concurrent.outcome, "current", "the outcome recorded is the snapshot's, not the change made after it");
    const recycled = probe("recycle");
    assert.equal(recycled.stopped, true, "a pass that left the snapshot must stop, not record");
    assert.match(String(recycled.reason), /left the export's snapshot/);
  });

  it("the refusal case: a credential in the source stops the export before any file is written", () => {
    const source = createDatabase(`lf_ref_${tag}`);
    const planted = psql(source, `INSERT INTO admin_config (key, value, label, data_type) VALUES ('zqx_vendor_key', '${SENTINELS.stripeKey}', 'A key someone pasted', 'string')`);
    assert.ok(planted.ok, planted.stderr);
    const refusedOut = path.join(scratch, "refused");
    const exp = tsx("scripts/export-legacy-fixture.ts", ["--out", refusedOut], { DATABASE_URL: source });
    assert.notEqual(exp.status, 0);
    assert.match(exp.stderr, /admin_config\.value .*a Stripe secret or restricted key/);
    assert.ok(!exp.stderr.includes(SENTINELS.stripeKey) && !exp.stdout.includes(SENTINELS.stripeKey), "the refusal names the shape, never the value");
    assert.ok(!fs.existsSync(refusedOut) || fs.readdirSync(refusedOut).length === 0, "nothing was written");
  });

  it("the load: rows, sequences, refusals and the freshness predicates hold on a fresh database", async () => {
    const target = createDatabase(`lf_dst_${tag}`);
    const storage = path.join(scratch, "storage-sentinel");
    const load = tsx("scripts/load-legacy-fixture.ts", ["--fixture", out], { DATABASE_URL: target, ...storageEnv(storage) });
    assert.equal(load.status, 0, `${load.stdout}\n${load.stderr}`);
    assert.match(load.stdout, /every recorded outcome restored and re-checked/);

    const manifest = readManifest(out);
    for (const [table, n] of Object.entries(manifest.rowCounts as Record<string, number>)) {
      if (["feature_flags", "tier_feature_permissions", "engines", "look_styles", "admin_config", "entitlement_grid_revision"].includes(table)) continue; // upserted over the migration seed
      const [{ c }] = await query<{ c: string }>(target, `SELECT count(*)::text AS c FROM public."${table}"`);
      assert.equal(Number(c), n, `${table} row count`);
    }

    // Subsequent inserts take fresh ids (Astra round 1, C3).
    const [{ max: factMax }] = await query<{ max: number }>(target, "SELECT max(id) AS max FROM facts");
    const [{ id: newFact }] = await query<{ id: number }>(target, "INSERT INTO facts (text) VALUES ('{NAME} is new.') RETURNING id");
    assert.ok(newFact > factMax);
    const [{ id: newMeme }] = await query<{ id: number }>(target, "INSERT INTO memes (fact_id, template_id, image_url, permalink_slug) VALUES ($1, 'classic', '/api/memes/NewSlug0001/image', 'NewSlug0001') RETURNING id", [newFact]);
    const [{ max: memeMax }] = await query<{ max: number }>(target, "SELECT max(id) AS max FROM memes WHERE id <> $1", [newMeme]);
    assert.ok(newMeme > memeMax);
    const [{ id: newAttempt }] = await query<{ id: string }>(target, `INSERT INTO image_prompt_attempts (fact_id, generation_mode, subject_render_mode, target_engine, source_image_analysis, identity_policy, render_controls, fact_enrichment_snapshot, archetype_strategy_version) VALUES ($1, 't2i', 't2i_fallback', 'nano-banana-2', '{}', '{}', '{}', '{}', '1') RETURNING id`, [newFact]);
    const [{ max: attemptMax }] = await query<{ max: string }>(target, "SELECT max(id) AS max FROM image_prompt_attempts WHERE id <> $1", [newAttempt]);
    assert.ok(Number(newAttempt) > Number(attemptMax));
    const [{ next, max }] = await query<{ next: string; max: string }>(target, "SELECT nextval('membership_source_state_seq')::text AS next, max(source_state_as_of)::text AS max FROM membership_entitlements");
    assert.ok(Number(next) > Number(max), "the standalone membership sequence is past the fixture's rows");

    // Every placeholder exists in the storage double.
    const bucket = new LocalObjectStorage(storage).bucket("fixture-bucket");
    for (const p of manifest.placeholders) {
      const [exists] = await bucket.file(`private/${objectPathOf(p.path)!.replace(/^\/objects\//, "")}`).exists();
      assert.ok(exists, `placeholder ${p.path} was not written`);
    }

    // The loader's refusals.
    const again = tsx("scripts/load-legacy-fixture.ts", ["--fixture", out], { DATABASE_URL: target, ...storageEnv(storage) });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /already holds rows/);
    // A production environment is refused before any connection (Codex round 1): the database named does not exist.
    const prod = tsx("scripts/load-legacy-fixture.ts", ["--fixture", out], { DATABASE_URL: "postgres://nobody@127.0.0.1:1/none", NODE_ENV: "production", ...storageEnv(storage) });
    assert.notEqual(prod.status, 0);
    assert.match(prod.stderr, /production environment/);
    assert.doesNotMatch(prod.stderr, /test database|could not|ECONNREFUSED/i, "the refusal came from the environment, not from a connection attempt");
    const noDouble = tsx("scripts/load-legacy-fixture.ts", ["--fixture", out], { DATABASE_URL: createDatabase(`lf_nd_${tag}`) });
    assert.notEqual(noDouble.status, 0);
    assert.match(noDouble.stderr, /STORAGE_BACKEND must be local-double/);
    const unmarked = tsx("scripts/load-legacy-fixture.ts", ["--fixture", out], { DATABASE_URL: createDatabase(`lf_um_${tag}`, { mark: false }), ...storageEnv(storage) });
    assert.notEqual(unmarked.status, 0);
    assert.match(unmarked.stderr, /refusing to load/);
  });

  it("the committed fixture loads, takes the account seed after it, and the app reads it through its real routes", async (t) => {
    assert.ok(fs.existsSync(path.join(COMMITTED_FIXTURE, "manifest.json")), "the committed fixture is missing");
    const target = createDatabase(`lf_com_${tag}`);
    const storage = path.join(scratch, "storage-committed");
    const load = tsx("scripts/load-legacy-fixture.ts", ["--fixture", COMMITTED_FIXTURE], { DATABASE_URL: target, ...storageEnv(storage) });
    assert.equal(load.status, 0, `${load.stdout}\n${load.stderr}`);
    const seed = tsx("scripts/seed-e2e-test-accounts.ts", [], { DATABASE_URL: target, BCRYPT_SALT_ROUNDS: "4" });
    assert.equal(seed.status, 0, `the account seed after the fixture: ${seed.stderr}`);

    // A fixture owner of a reference image gets a password, so the owner-only route can be read as its owner.
    const [ref] = await query<{ user_id: string; storage_path: string; email: string }>(
      target,
      `SELECT a.user_id, a.storage_path, u.email FROM user_ai_images a JOIN users u ON u.id = a.user_id WHERE a.image_type = 'reference' LIMIT 1`,
    );
    const ownerPassword = "fixture-owner-password-1";
    if (ref) await query(target, "UPDATE users SET password_hash = $1 WHERE id = $2", [bcrypt.hashSync(ownerPassword, 4), ref.user_id]);

    const port = await portForChildProcess();
    const server: ChildProcess = spawn(process.execPath, ["--import", "tsx/esm", "src/index.ts"], {
      cwd: API_ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DATABASE_URL: target,
        NODE_ENV: "development",
        PORT: String(port),
        ENABLE_DEV_ADMIN_LOGIN: "true",
        CRON_SECRET: "legacy-fixture",
        AI_BACKEND: "recorded-double",
        ...storageEnv(storage),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    server.stdout!.on("data", (d) => (log += d));
    server.stderr!.on("data", (d) => (log += d));
    const base = `http://127.0.0.1:${port}`;
    try {
      const deadline = Date.now() + 120_000;
      let lastError = "";
      for (;;) {
        try {
          const res = await httpFetch(`${base}/api/healthz`);
          if (res.ok) break;
          lastError = `healthz answered ${res.status}`;
        } catch (err) {
          lastError = String((err as { cause?: unknown }).cause ?? err);
        }
        if (Date.now() > deadline) {
          const accepts = await new Promise<boolean>((done) => {
            const sock = netConnect({ port, host: "127.0.0.1" }, () => (sock.destroy(), done(true)));
            sock.on("error", () => done(false));
          });
          throw new Error(
            `the server did not listen over the fixture (logged listening: ${log.includes("Server listening")}; ` +
              `a raw connect ${accepts ? "succeeds" : "fails"}; last fetch: ${lastError}):\n${log.slice(-3000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      fs.writeFileSync(path.join(scratch, "boot.log"), log);
      // The boot log's verdicts travel with the run (plan, Definition of Done: "the boot log is in the PR").
      const bootLines = log.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
      const flagged = bootLines.filter((l) => /\b(WARN|ERROR|FATAL)\b/.test(l));
      t.diagnostic(`boot log: ${bootLines.length} lines, ${flagged.length} at WARN or above`);
      for (const l of flagged.slice(0, 40)) t.diagnostic(`boot: ${l.trim().slice(0, 240)}`);

      const admin = await session(base);
      assert.equal((await admin.req("POST", "/api/auth/dev-admin-login")).status, 200);
      const accounts = JSON.parse(fs.readFileSync(path.join(API_ROOT, "scripts", "e2e-test-accounts.json"), "utf8"));
      const free = await session(base);
      assert.equal((await free.req("POST", "/api/auth/local-login", { email: accounts.free.email, password: accounts.password })).status, 200);

      // The admin readers, for a sample of every workflow stage present.
      const stages = await query<{ workflow_stage: string; id: number }>(target, "SELECT DISTINCT ON (workflow_stage) workflow_stage, id FROM pending_reviews ORDER BY workflow_stage, id");
      for (const s of stages) {
        assert.equal((await admin.req("GET", `/api/admin/reviews/${s.id}`)).status, 200, `review detail, stage ${s.workflow_stage}`);
        assert.equal((await admin.req("GET", `/api/admin/reviews/${s.id}/render-scenarios`)).status, 200, `render grid, stage ${s.workflow_stage}`);
      }
      for (const f of await query<{ id: number }>(target, "SELECT DISTINCT ON (is_active) id FROM facts ORDER BY is_active, id")) {
        assert.equal((await admin.req("GET", `/api/admin/facts/${f.id}`)).status, 200, `fact detail ${f.id}`);
      }

      // Every media consumer present in the fixture, through its own route.
      const isImage = (b: Buffer) =>
        (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8) || b.subarray(8, 12).toString() === "WEBP";
      const image = async (s: Session, url: string, expect: number, what: string) => {
        const res = await s.req("GET", url);
        assert.equal(res.status, expect, `${what}: ${url}`);
        if (expect === 200) assert.ok(isImage(Buffer.from(await res.arrayBuffer())), `${what} did not decode as an image`);
      };
      const anon = await session(base);
      // A stock meme that stores only its Pexels id is resolved through Pexels on every read (routes/memes.ts:169-190),
      // which has no double: it is increment 6's (plan D8), so it is counted here, not read.
      const memes = await query<{ permalink_slug: string; kind: string }>(
        target,
        `SELECT DISTINCT ON (COALESCE(image_source->>'type', 'legacy')) permalink_slug, COALESCE(image_source->>'type', 'legacy') AS kind
           FROM memes WHERE is_public AND deleted_at IS NULL AND status = 'live'
            AND NOT (COALESCE(image_source->>'type', '') = 'stock' AND NOT COALESCE(image_source ? 'photoUrl', false))
          ORDER BY COALESCE(image_source->>'type', 'legacy'), id`,
      );
      for (const m of memes) if (m.kind !== "identity") await image(anon, `/api/memes/${m.permalink_slug}/image`, 200, `a ${m.kind} meme`);
      const [{ n: pexelsOnly }] = await query<{ n: number }>(
        target,
        `SELECT count(*)::int AS n FROM memes WHERE image_source->>'type' = 'stock' AND NOT image_source ? 'photoUrl'`,
      );
      t.diagnostic(`meme kinds read: ${memes.map((m) => m.kind).join(", ") || "none"}; stock memes needing Pexels to render, left to increment 6: ${pexelsOnly}`);

      const [avatar] = await query<{ url: string }>(target, "SELECT profile_image_url AS url FROM users WHERE profile_image_url LIKE '%/objects/uploads/%' LIMIT 1");
      if (avatar) await image(anon, avatar.url.replace(/^.*?\/objects\//, "/api/storage/objects/"), 200, "a public avatar");

      if (ref) {
        const owner = await session(base);
        assert.equal((await owner.req("POST", "/api/auth/local-login", { email: ref.email, password: ownerPassword })).status, 200);
        const url = `/api/memes/ai-user/image?storagePath=${encodeURIComponent(ref.storage_path)}`;
        await image(owner, url, 200, "a reference image as its owner");
        await image(free, url, 403, "a reference image as another user");
      }

      const [render] = await query<{ review_id: number; render_job_id: string }>(
        target,
        "SELECT review_id, render_job_id FROM image_prompt_attempts WHERE review_id IS NOT NULL AND render_job_id IS NOT NULL AND generated_image_object_path IS NOT NULL LIMIT 1",
      );
      if (render) {
        const url = `/api/admin/reviews/${render.review_id}/renders/${render.render_job_id}/image`;
        await image(admin, url, 200, "a review render as an admin");
        const asUser = await free.req("GET", url);
        assert.ok([401, 403].includes(asUser.status), `a review render as an ordinary user answered ${asUser.status}`);
      }

      const [galleryFact] = await query<{ id: number; slots: string[] }>(target, "SELECT id, ARRAY(SELECT jsonb_array_elements_text(ai_meme_images->'male')) AS slots FROM facts WHERE jsonb_array_length(COALESCE(ai_meme_images->'male', '[]')) > 0 LIMIT 1");
      if (galleryFact) {
        const i = galleryFact.slots.findIndex((s) => s !== "");
        if (i >= 0) await image(anon, `/api/memes/ai/${galleryFact.id}/image?gender=male&imageIndex=${i}`, 200, "a gallery image");
      }
    } finally {
      server.kill("SIGTERM");
    }
  });
});

interface Session {
  req(method: string, url: string, body?: unknown): Promise<Response>;
}

/** A cookie jar with the double-submit CSRF token, as the SPA uses it (app.ts:21-22). */
/**
 * HTTP to the booted server over node:http, never the global fetch: under the runner's one-process
 * mode another file's top-level hooks can leave a fetch stub installed until the whole process ends
 * (falPricing.test.ts installs one in a root `before` and restores it in a root `after`).
 */
function httpFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  return new Promise((resolveP, rejectP) => {
    const req = httpRequest(url, { method: init.method ?? "GET", headers: init.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", rejectP);
      res.on("end", () => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) headers.append(k, one);
        }
        const status = res.statusCode ?? 0;
        const noBody = status === 204 || status === 304 || (status >= 100 && status < 200);
        resolveP(new Response(noBody ? null : Buffer.concat(chunks), { status, headers }));
      });
    });
    req.on("error", rejectP);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

async function session(base: string): Promise<Session> {
  const cookies = new Map<string, string>();
  const absorb = (res: Response) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      if (eq > 0) cookies.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
    }
  };
  absorb(await httpFetch(`${base}/api/config`));
  return {
    async req(method, url, body) {
      const headers: Record<string, string> = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") };
      if (method !== "GET") headers["X-CSRF-Token"] = cookies.get("csrf_token") ?? "";
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await httpFetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      absorb(res);
      return res;
    },
  };
}
