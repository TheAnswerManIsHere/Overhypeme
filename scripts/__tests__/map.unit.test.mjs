// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
//
// The map tool's pure functions, on bare Node: no compiler, no sync, no
// fixture repository. This file ships with the payload, so it must run
// wherever it lands; the compiler-backed behaviour is proven by the
// handbook's own integration suite, which never ships.
import test from "node:test";
import assert from "node:assert/strict";
import {
  globToRegExp, matchesAny, parseHeader, sizeAfterHeader, relationsInSql, looksLikeSql, joinPaths,
  routeMatches, stableStringify, serializeIndex, validateSchema, formatAnswer, carriesSyncBanner, computeSets, nearest,
  run as runMap,
} from "../map.mjs";
import {
  median, scoreAnswer, verdict, summarize, relationPattern, THRESHOLDS, GRADING_MATERIAL, runProblems, SEEDS_PER_TASK_PER_ARM,
  taskProblems, TIERS, TASKS_PER_TIER, keepsVerification, run as runEval,
} from "../map-eval.mjs";

test("globs: ** spans directories including none, * stays in a segment, braces alternate", () => {
  assert.ok(globToRegExp("src/**/*.ts").test("src/a.ts"));
  assert.ok(globToRegExp("src/**/*.ts").test("src/x/y/a.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/x/a.ts"));
  assert.ok(globToRegExp("**/*.{ts,tsx}").test("a/b.tsx"));
  assert.ok(!globToRegExp("**/*.{ts,tsx}").test("a/b.js"));
  assert.ok(matchesAny("lib/node_modules/x.js", ["**/node_modules/**"]));
  assert.ok(!matchesAny("lib/a.test.ts.map", ["**/*.test.ts"]));
});

test("headers: purpose and subsystem from the leading comment, after a shebang, not from code", () => {
  const block = "#!/usr/bin/env node\n/**\n * The thing.\n * @purpose Composes the widget feed.\n * @subsystem feed\n */\nimport x from 'y';\n";
  const h = parseHeader(block);
  assert.equal(h.purpose, "Composes the widget feed.");
  assert.equal(h.subsystem, "feed");
  assert.equal(block.slice(h.headerEnd).trimStart().startsWith("import"), true);
  const lines = parseHeader("// @purpose Line comments work too.\n// @subsystem tooling\nconst a = 1;\n");
  assert.deepEqual([lines.purpose, lines.subsystem], ["Line comments work too.", "tooling"]);
  const late = parseHeader("const a = 1;\n/** @purpose too late */\n");
  assert.deepEqual([late.purpose, late.subsystem], [null, null]);
  assert.equal(parseHeader("/** @purpose One line. */\nx();").purpose, "One line.");
  const one = parseHeader("/** @purpose Both tags, one line. @subsystem http */\nx();");
  assert.deepEqual([one.purpose, one.subsystem], ["Both tags, one line.", "http"]);
});

test("size counts non-blank lines after the header, so adding a header never grows a file", () => {
  const body = "a();\n\nb();\n";
  const withHeader = "/**\n * @purpose P.\n * @subsystem s\n */\n" + body;
  assert.equal(sizeAfterHeader(body, parseHeader(body).headerEnd), 2);
  assert.equal(sizeAfterHeader(withHeader, parseHeader(withHeader).headerEnd), 2);
});

test("SQL relations: keywords, schemas, quotes, placeholders, and the shapes that are not relations", () => {
  assert.deepEqual(relationsInSql("SELECT * FROM facts f JOIN public.users u ON u.id = f.user_id").names, ["facts", "users"]);
  assert.deepEqual(relationsInSql('UPDATE "stripe"."products" SET x = 1').names, ["stripe.products"]);
  assert.deepEqual(relationsInSql("INSERT INTO memes (a, b) VALUES (1, 2)").names, ["memes"]);
  assert.deepEqual(relationsInSql("DROP TABLE IF EXISTS old_things").names, ["old_things"]);
  assert.deepEqual(relationsInSql("SELECT * FROM unnest($1::int[])").names, []);
  assert.deepEqual(relationsInSql("SELECT EXTRACT(EPOCH FROM created_at) FROM jobs").names, ["jobs"]);
  assert.deepEqual(relationsInSql("WHERE a IS DISTINCT FROM \u00000\u0000").exprs, []);
  assert.deepEqual(relationsInSql('REVOKE "a" FROM "b"').names, []);
  assert.deepEqual(relationsInSql("SELECT * FROM \u00000\u0000 WHERE x").exprs, [0]);
  assert.deepEqual(relationsInSql("DELETE FROM stripe.\u00000\u0000").exprs, [-1]);
  assert.deepEqual(relationsInSql("INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET x = 1").names, ["t"]);
  // DDL that names a relation only after INDEX … ON or REFERENCES (#212), and an
  // ON that introduces a join condition, which names a column, not a relation.
  assert.deepEqual(relationsInSql("CREATE INDEX idx_x ON ncmec_reports (reported_at)").names, ["ncmec_reports"]);
  assert.deepEqual(relationsInSql('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "i" ON ONLY public.facts (id)').names, ["facts"]);
  assert.deepEqual(relationsInSql("CREATE INDEX ON stripe.products (id)").names, ["stripe.products"]);
  assert.deepEqual(relationsInSql("ALTER TABLE audits ADD FOREIGN KEY (r) REFERENCES appeals(id)").names, ["appeals", "audits"]);
  assert.deepEqual(relationsInSql("SELECT * FROM a JOIN b ON a.x = b.y").names, ["a", "b"]);
  assert.deepEqual(relationsInSql("SELECT * FROM a JOIN b ON x = y").names, ["a", "b"]);
  assert.ok(looksLikeSql("CREATE INDEX idx_x ON ncmec_reports (reported_at)"));
  assert.ok(looksLikeSql("ALTER TABLE a ADD CONSTRAINT c FOREIGN KEY (b) REFERENCES u(id)"));
  assert.ok(looksLikeSql("select id from users"));
  assert.ok(!looksLikeSql("Select the option you want from the list above"));
});

test("routes: mount composition and matching", () => {
  assert.equal(joinPaths("/api", "/facts"), "/api/facts");
  assert.equal(joinPaths("", "/x"), "/x");
  assert.equal(joinPaths("/api", "/"), "/api");
  assert.equal(joinPaths("", ""), "/");
  assert.ok(routeMatches("/facts/:id", "/facts/12"));
  assert.ok(routeMatches("/facts/:id", "/facts/:id"));
  assert.ok(!routeMatches("/facts/:id", "/facts/12/comments"));
  assert.ok(routeMatches("/wear/:slug?", "/wear"));
  assert.ok(routeMatches("regex:/^\\/m\\/([a-z]+)$/", "/m/abc"));
  assert.ok(routeMatches("prefix:/share/", "/share/x"));
  // Express 5 named wildcards (#212): `*name` takes one or more segments, `{*name}` any.
  assert.ok(routeMatches("/storage/public-objects/*filePath", "/storage/public-objects/foo.png"));
  assert.ok(routeMatches("/storage/public-objects/*filePath", "/storage/public-objects/a/b.png"));
  assert.ok(!routeMatches("/storage/public-objects/*filePath", "/storage/public-objects"));
  assert.ok(routeMatches("/files/{*rest}", "/files"));
  assert.ok(routeMatches("/files/{*rest}", "/files/a/b"));
});

test("serialization is deterministic: key order never changes the bytes", () => {
  const a = { tool: "t", files: { "b.ts": { z: 1, a: 2 }, "a.ts": { y: [3, 1] } }, sets: { indexed: ["a.ts"] } };
  const b = { sets: { indexed: ["a.ts"] }, files: { "a.ts": { y: [3, 1] }, "b.ts": { a: 2, z: 1 } }, tool: "t" };
  assert.equal(serializeIndex(a), serializeIndex(b));
  assert.equal(stableStringify({ b: 1, a: { d: 1, c: 2 } }), '{"a":{"c":2,"d":1},"b":1}');
  assert.ok(serializeIndex(a).split("\n").some((l) => l.startsWith('"a.ts":')), "one file per line");
});

test("schema validation names the path and the problem", () => {
  const schema = { $defs: { c: { type: "object", required: ["a"], patternProperties: { "^_": {} }, additionalProperties: false, properties: { a: { type: "boolean" }, n: { type: "integer", minimum: 1 } } } } };
  assert.deepEqual(validateSchema({ $ref: "#/$defs/c" }, { a: true, _note: "x" }, schema), []);
  const errs = validateSchema({ $ref: "#/$defs/c" }, { n: 0, b: 1 }, schema);
  assert.ok(errs.includes('$: missing required key "a"'));
  assert.ok(errs.includes("$.n: must be at least 1"));
  assert.ok(errs.includes("$.b: unknown key"));
});

test("an answer always prints all three sections, and an empty resolved section says so", () => {
  const out = formatAnswer({ title: "q", resolved: [], unresolved: ["a.ts:1  dynamic-target  x"], coverage: ["c"] });
  assert.match(out, /resolved \(0\):\n  \(none found\)/);
  assert.match(out, /unresolved \(1\):/);
  assert.match(out, /coverage:\n  c/);
});

test("sets: codegen, synced and test files leave the headered set but stay indexed", () => {
  const files = ["src/a.ts", "src/a.test.ts", "src/gen/api.ts", "scripts/sync.mjs", "x.d.ts"];
  const cfg = { sets: { indexed: { include: ["**/*.{ts,mjs}"] }, headered: { exclude: ["**/*.test.*"] } }, codegenOwned: [{ paths: ["src/gen/**"], command: "gen" }] };
  const s = computeSets(files, cfg, (f) => f === "scripts/sync.mjs");
  assert.deepEqual(s.indexed, files);
  assert.deepEqual(s.headered, ["src/a.ts"]);
  assert.ok(carriesSyncBanner("#!/usr/bin/env node\n// SYNCED FROM AI-Handbook — x\n"));
  assert.ok(!carriesSyncBanner('const s = "SYNCED FROM AI-Handbook";\n'));
});

test("not-found answers suggest the nearest real paths", () => {
  assert.deepEqual(nearest("src/lib/emial.ts", ["src/lib/email.ts", "src/x.ts"]).length, 0);
  assert.deepEqual(nearest("lib/email.ts", ["src/lib/email.ts", "src/x.ts"]), ["src/lib/email.ts"]);
});

test("eval scoring: recall, precision, medians, and the pre-registered verdict", () => {
  assert.deepEqual(scoreAnswer(["a.ts", "./b.ts:12"], ["a.ts", "b.ts", "c.ts"]), { recall: 2 / 3, precision: 1 });
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  const arm = (hidden, tokens) => ({ hidden: { recall: hidden }, medianTokens: tokens });
  assert.equal(verdict(arm(0.9, 105), arm(0.6, 100)).decision, "keep");
  assert.equal(verdict(arm(0.65, 100), arm(0.6, 100)).decision, "disable");
  assert.equal(verdict(arm(0.95, 130), arm(0.6, 100)).decision, "disable");
  assert.equal(verdict(arm(0.75, 100), arm(0.6, 100)).decision, "david");
  assert.equal(THRESHOLDS.keep.minHiddenRecallGainPoints, 20);
  const tasks = [{ id: "h1", tier: "hidden" }, { id: "k1", tier: "keyword" }];
  const keys = { h1: { files: ["a.ts"] }, k1: { files: ["b.ts"] } };
  const s = summarize([{ task: "h1", arm: "A", files: ["a.ts"], tokens: 10 }, { task: "k1", arm: "A", files: [], tokens: 30 }], tasks, keys);
  assert.equal(s.A.hidden.recall, 1);
  assert.equal(s.A.keyword.recall, 0);
  assert.equal(s.A.medianTokens, 20);
  // Tool calls and seconds are reported beside tokens, never thresholded (#212).
  assert.equal(s.A.medianToolCalls, null, "no run recorded them");
  const t = summarize([
    { task: "h1", arm: "A", files: [], tokens: 1, toolCalls: 4, seconds: 30 },
    { task: "k1", arm: "A", files: [], tokens: 1, toolCalls: 8, seconds: 50 },
  ], tasks, keys);
  assert.deepEqual([t.A.medianToolCalls, t.A.medianSeconds], [6, 40]);
});

test("eval: a relation pattern matches quoted and schema forms, and grading material is named", () => {
  assert.ok(relationPattern("stripe.products").test('SELECT * FROM "stripe"."products"'));
  assert.ok(relationPattern("stripe.products").test("from stripe.products p"));
  assert.ok(!relationPattern("stripe.products").test("from stripe.products_v2"));
  assert.ok(relationPattern("facts").test("SELECT 1 FROM facts"));
  assert.ok(!relationPattern("facts").test("SELECT 1 FROM user_facts"));
  // The default schema is the same relation; another schema is a different one, quoted or not.
  assert.ok(relationPattern("facts").test("SELECT 1 FROM public.facts"));
  assert.ok(relationPattern("facts").test('SELECT 1 FROM "public"."facts"'));
  assert.ok(relationPattern("public.facts").test("SELECT 1 FROM facts"));
  assert.ok(!relationPattern("facts").test("SELECT 1 FROM tenant.facts"));
  assert.ok(!relationPattern("facts").test('SELECT 1 FROM "tenant"."facts"'));
  assert.ok(!relationPattern("facts").test("SELECT 1 FROM tenant . facts"));
  assert.ok(!relationPattern("stripe.products").test("SELECT 1 FROM products"));
  assert.deepEqual(GRADING_MATERIAL, [".agents/map/eval-tasks.json", ".agents/map/eval-keys.json", ".agents/map/eval-results"]);
});

test("a bare or empty --root is refused as a usage error, never read as the current checkout", () => {
  for (const argv of [["purpose", "x", "--root"], ["purpose", "x", "--root", ""], ["build", "--root", "--json"]]) {
    const errs = [];
    assert.equal(runMap(argv, { log: () => {}, err: (m) => errs.push(m) }), 2, argv.join(" "));
    assert.match(errs.join("\n"), /--root needs a directory/);
  }
  for (const argv of [["score", "--runs"], ["prepare", "--ref", "HEAD", "--out", ""], ["keys", "--root", ""]]) {
    const errs = [];
    assert.equal(runEval(argv, { log: () => {}, err: (m) => errs.push(m) }), 2, argv.join(" "));
    assert.match(errs.join("\n"), /needs a value/);
  }
});

test("scoring needs the complete matrix: every task, both arms, the protocol's seeds, each with files and tokens", () => {
  assert.equal(SEEDS_PER_TASK_PER_ARM, 2);
  const tasks = [{ id: "t1" }, { id: "t2" }];
  const full = [];
  for (const task of ["t1", "t2"]) for (const arm of ["A", "B"]) for (const seed of [1, 2]) full.push({ task, arm, seed, files: [], tokens: 10 });
  assert.deepEqual(runProblems(full, tasks), []);
  assert.match(runProblems(full.slice(1), tasks).join("\n"), /t1 \/ A: 1 distinct seed\(s\)/);
  assert.match(runProblems([...full, full[0]], tasks).join("\n"), /run 9: duplicates run 1/);
  assert.match(runProblems([...full, { task: "t9", arm: "A", seed: 1, files: [], tokens: 1 }], tasks).join("\n"), /unknown task "t9"/);
  assert.match(runProblems(full.map((r, i) => (i ? r : { ...r, arm: "C" })), tasks).join("\n"), /unknown arm "C"/);
  assert.match(runProblems(full.map((r, i) => (i ? r : { ...r, tokens: undefined })), tasks).join("\n"), /run 1: tokens is not a measured number/);
  assert.match(runProblems(full.map((r, i) => (i ? r : { ...r, files: "a.ts" })), tasks).join("\n"), /run 1: files is not an array/);
  assert.deepEqual(runProblems({}, tasks), ["the runs file is not a JSON array"]);
});

test("the task set is the protocol's: distinct ids and ten per tier, refused naming the tier and the ids", () => {
  assert.deepEqual([TIERS, TASKS_PER_TIER], [["keyword", "structural", "hidden"], 10]);
  const full = TIERS.flatMap((tier) => Array.from({ length: TASKS_PER_TIER }, (_, i) => ({ id: `${tier[0]}${i + 1}`, tier })));
  assert.deepEqual(taskProblems(full), []);
  assert.match(taskProblems(full.filter((t) => t.id !== "h10")).join("\n"), /tier hidden: 9 task\(s\), the protocol needs 10 \(h1, h2, h3, h4, h5, h6, h7, h8, h9\)/);
  const dup = full.map((t) => (t.id === "k2" ? { ...t, id: "k1" } : t));
  assert.match(taskProblems(dup).join("\n"), /duplicate task id\(s\): "k1"/);
  assert.match(taskProblems([...full, { id: "x1", tier: "easy" }]).join("\n"), /no protocol tier: "x1" \(tier "easy"\)/);
  assert.deepEqual(taskProblems(undefined), ['the task set is not a JSON array under "tasks"']);
});

test("a regenerated key keeps its verification only when its files and its incidental list are both unchanged", () => {
  const prior = { files: ["a.ts"], incidental: ["b.ts"], verified: true };
  assert.equal(keepsVerification(prior, { files: ["a.ts"], incidental: ["b.ts"] }), true);
  assert.equal(keepsVerification(prior, { files: ["a.ts"], incidental: ["b.ts", "c.ts"] }), false, "a new incidental candidate was never reviewed");
  assert.equal(keepsVerification(prior, { files: ["a.ts", "c.ts"], incidental: ["b.ts"] }), false);
  assert.equal(keepsVerification({ ...prior, verified: false }, { files: ["a.ts"], incidental: ["b.ts"] }), false);
  assert.equal(keepsVerification({ files: ["a.ts"], verified: true }, { files: ["a.ts"] }), true, "a symbol key has no incidental list on either side");
  assert.equal(keepsVerification(undefined, { files: [] }), false);
});
