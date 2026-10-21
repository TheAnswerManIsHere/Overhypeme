// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { scanBody, uatSection, readBody, UAT_HEADING } from "../check-uat-format.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "check-uat-format.mjs");

/** A PR body in the shape pr-docs writes: oracle sections, then `## UAT`, then more sections. */
const body = ({ setup, steps, regression, tail = "", before = "", after = "" } = {}) =>
  [
    "## Summary",
    "",
    "What changed and why. **Do:** this is prose in another section, not a step.",
    "",
    before,
    UAT_HEADING,
    "",
    "Some framing prose for David.",
    "",
    "### Setup",
    "",
    setup ?? "- [claude] Confirm the Repl is synced.",
    "",
    "### Steps",
    "",
    steps ?? ["#### 1. Open it", "", "**Do:** Click Help.", "", "**Expect:** The Manual.", "", "**Lane:** human", "", "**Judgement:** whether it reads well."].join("\n"),
    "",
    "### Regression",
    "",
    regression ??
      ["#### R1. Sidebar unchanged", "", "**Do:** Look at it.", "", "**Expect:** Same items.", "", "**Lane:** human", "", "**Judgement:** whether it reads well."].join("\n"),
    "",
    tail,
    "",
    "## Decisions taken on my recommendation",
    "",
    "none",
    "",
    "**Do:** prose after the section, never a step.",
    after,
  ].join("\n");

test("a section in the format passes clean", () => {
  assert.deepEqual(scanBody(body()), []);
});

test("a body with no ## UAT section has nothing to check", () => {
  // Whether a UAT is owed is pr-docs' and pr-watch's judgement, not the
  // guard's: a docs PR, a Tier A fix and a prototype-phase PR all carry none.
  assert.equal(uatSection("## Summary\n\nprose\n"), null);
  assert.deepEqual(scanBody("## Summary\n\nprose\n"), []);
  assert.deepEqual(scanBody(""), []);
});

test("the heading is matched exactly — a near miss is not the section", () => {
  // `## UAT run` is the run record's heading on the workstream issue; a body
  // that quoted one must not be read as carrying the script.
  assert.equal(uatSection("## UAT run\n\n### Steps\n"), null);
  assert.equal(uatSection("## UAT notes\n"), null);
  assert.equal(uatSection("### UAT\n"), null);
  assert.ok(uatSection("## UAT\n\nx\n") !== null);
  assert.ok(uatSection("## UAT   \n") !== null, "trailing whitespace is tolerated");
});

test("the section ends at the next ## heading, so other sections' prose is never read", () => {
  const found = scanBody(body());
  assert.deepEqual(found, []);
  // and a step heading after the section's end is not a step
  const stray = body({ after: "\n#### 2. Not a step\n\n**Do:** x\n\n**Expect:** y\n" });
  assert.deepEqual(scanBody(stray), []);
});

test("line numbers in findings are the body's own, 1-based", () => {
  const b = body({ steps: "#### 1. Look\n\n**Expect:** Something." });
  const line = b.split("\n").findIndex((l) => l === "#### 1. Look") + 1;
  const found = scanBody(b);
  assert.ok(found.some((p) => p.startsWith(`${line}: `)), found.join("\n"));
});

test("Not bugs is optional", () => {
  assert.deepEqual(scanBody(body({ tail: "### Not bugs\n\n- Something.\n" })), []);
  assert.deepEqual(scanBody(body({ tail: "" })), []);
});

test("each required sub-section must be present", () => {
  const full = body();
  for (const section of ["### Setup", "### Steps", "### Regression"]) {
    const without = full.replace(`${section}\n`, "");
    assert.ok(
      scanBody(without).some((p) => p.includes(`missing required section "${section}"`)),
      `should require ${section}`,
    );
  }
});

test("required sub-sections must appear in order", () => {
  const outOfOrder = [
    "## UAT",
    "### Steps",
    "#### 1. Open it",
    "**Do:** Click.",
    "**Expect:** It opens.",
    "### Setup",
    "- [claude] Sync.",
    "### Regression",
    "#### R1. Still fine",
    "**Do:** Look.",
    "**Expect:** Fine.",
  ].join("\n");
  assert.ok(scanBody(outOfOrder).some((p) => p.includes("must come after")));
});

test("step IDs must be consecutive from 1", () => {
  const steps = ["#### 1. First", "**Do:** a", "**Expect:** b", "", "#### 3. Third", "**Do:** a", "**Expect:** b"].join("\n");
  assert.ok(scanBody(body({ steps })).some((p) => p.includes("consecutively") && p.includes("2.")));
});

test("regression IDs must be R-prefixed and consecutive", () => {
  const regression = ["#### R1. First", "**Do:** a", "**Expect:** b", "", "#### R3. Third", "**Do:** a", "**Expect:** b"].join("\n");
  assert.ok(scanBody(body({ regression })).some((p) => p.includes("R2.")));

  const unprefixed = ["#### 1. First", "**Do:** a", "**Expect:** b"].join("\n");
  assert.ok(scanBody(body({ regression: unprefixed })).some((p) => p.includes("R1.")));
});

test("a step heading at the old level (###) is a sub-section boundary, not a step", () => {
  // The level shift is the whole difference between a file and a body
  // section. A script pasted from a legacy doc without re-levelling must be
  // refused, or /uat would see no steps where the author sees seven.
  const steps = ["### 1. Open it", "**Do:** a", "**Expect:** b"].join("\n");
  const found = scanBody(body({ steps }));
  assert.ok(found.some((p) => p.includes("no #### headings")), found.join("\n"));
});

test("a compound step is rejected — two Do/Expect pairs under one heading", () => {
  const steps = ["#### 1. Two things at once", "**Do:** First action.", "**Expect:** First result.", "**Do:** Second action.", "**Expect:** Second result."].join("\n");
  const found = scanBody(body({ steps }));
  assert.ok(found.some((p) => p.includes("2 **Do:** lines")));
  assert.ok(found.some((p) => p.includes("2 **Expect:** lines")));
});

test("a step with no Do or no Expect is rejected", () => {
  const noDo = ["#### 1. Look", "**Expect:** Something."].join("\n");
  assert.ok(scanBody(body({ steps: noDo })).some((p) => p.includes("0 **Do:** lines")));
  const noExpect = ["#### 1. Look", "**Do:** Something."].join("\n");
  assert.ok(scanBody(body({ steps: noExpect })).some((p) => p.includes("0 **Expect:** lines")));
});

test("a step's Do/Expect count stops at the next sub-section, not the next heading anywhere", () => {
  const clean = body({ tail: "### Not bugs\n\n- **Do:** this is prose, not a step.\n" });
  assert.deepEqual(scanBody(clean), []);
});

test("an empty Steps or Regression sub-section is rejected", () => {
  assert.ok(scanBody(body({ steps: "Some prose but no headings." })).some((p) => p.includes("no #### headings")));
  assert.ok(scanBody(body({ regression: "Nothing to check." })).some((p) => p.includes("no #### headings")));
});

test("setup lines must use the fixed tag vocabulary", () => {
  assert.ok(scanBody(body({ setup: "- Sign in as admin." })).some((p) => p.includes("must start with one of")));
  assert.ok(scanBody(body({ setup: "- [someone] Do a thing." })).some((p) => p.includes("must start with one of")));
  assert.ok(scanBody(body({ setup: "Just prose." })).some((p) => p.includes("bullets or the single line")));
});

test("all three setup tags are accepted, and so is None.", () => {
  for (const tag of ["[claude]", "[david]", "[restore]"]) {
    assert.deepEqual(scanBody(body({ setup: `- ${tag} A thing.` })), [], `should accept ${tag}`);
  }
  assert.deepEqual(scanBody(body({ setup: "None." })), []);
});

test("a wrapped setup bullet's continuation line is not read as a new tag", () => {
  const wrapped = ["- [claude] Something long enough that it wraps onto", "  a second line here."].join("\n");
  assert.deepEqual(scanBody(body({ setup: wrapped })), []);
});

test('"None." is a legitimate Regression body, but not a legitimate Steps body', () => {
  assert.deepEqual(scanBody(body({ regression: "None." })), []);
  assert.ok(
    scanBody(body({ steps: "None." })).some((p) => p.includes("no #### headings")),
    "a UAT with nothing to test is not a UAT",
  );
});

test("an empty Regression sub-section names the None. escape in its message", () => {
  const found = scanBody(body({ regression: "Some prose, no headings." }));
  assert.ok(found.some((p) => p.includes('"None."')));
});

test('"None." may carry a reason after it, in either escapable sub-section', () => {
  const withReason = "None. Steps 1 and 2 are the sweep for this PR.";
  assert.deepEqual(scanBody(body({ regression: withReason })), []);
  assert.deepEqual(scanBody(body({ setup: withReason })), []);
});

test('a heading after "None." is validated normally, not silently exempted', () => {
  const withHeading = ["None. Nothing intended.", "", "#### broken heading with no body"].join("\n");
  const found = scanBody(body({ regression: withHeading }));
  assert.ok(found.length > 0, "a heading after None. must still be checked");
  assert.ok(found.some((p) => p.includes("Do:") || p.includes("Expect:")));
});

// --- lanes ------------------------------------------------------------------

const step = (...fields) =>
  ["#### 1. Open it", "", "**Do:** Click Help.", "", "**Expect:** The Manual.", "", ...fields].join("\n");
const real = (rel) => rel === "e2e/help.spec.ts" || rel === "src/__tests__/help.test.ts";
const scan = (steps) => scanBody(body({ steps }), { exists: real });

test("every lane is accepted, and a machine lane with an existing check passes", () => {
  assert.deepEqual(scan(step("**Lane:** human", "**Judgement:** whether it reads well.")), []);
  assert.deepEqual(scan(step("**Lane:** capture", "", "**Check:** `e2e/help.spec.ts:manual page`")), []);
  assert.deepEqual(scan(step("**Lane:** ci", "", "**Check:** `src/__tests__/help.test.ts`")), []);
  assert.deepEqual(scan(step("**Lane:** scripted", "", "**Check:** `e2e/help.spec.ts:opens the manual`")), []);
  assert.deepEqual(scan(step("**Lane:** live", "", "**Check:** `curl -sI https://example.test/help`")), []);
});

test("a step with no lane, two lanes, or an unknown lane is a finding", () => {
  assert.ok(scan(step()).some((p) => p.includes("0 **Lane:** lines")));
  assert.ok(scan(step("**Lane:** human", "**Lane:** ci")).some((p) => p.includes("2 **Lane:** lines")));
  assert.ok(scan(step("**Lane:** manual")).some((p) => p.includes('lane "manual"')));
});

test("a regression check needs a lane too", () => {
  const found = scanBody(body({ regression: "#### R1. Still there\n\n**Do:** Look.\n\n**Expect:** Yes." }), { exists: real });
  assert.ok(found.some((p) => p.includes('"R1. Still there"') && p.includes("**Lane:**")));
});

test("a machine lane without a check, or with an unbackticked one, is a finding", () => {
  for (const lane of ["ci", "scripted", "live", "capture"]) {
    assert.ok(scan(step(`**Lane:** ${lane}`)).some((p) => p.includes("no **Check:**")), lane);
  }
  assert.ok(scan(step("**Lane:** ci", "**Check:** the help test")).some((p) => p.includes("backticked")));
});

test("a check citing a file that does not exist is a finding; a command is not checked as a path", () => {
  assert.ok(scan(step("**Lane:** ci", "**Check:** `src/__tests__/gone.test.ts`")).some((p) => p.includes("does not exist")));
  assert.deepEqual(scan(step("**Lane:** scripted", "**Check:** `pnpm run e2e:acceptance`")), []);
});

test("a deferred machine step needs an owner but no check; a human step needs no check", () => {
  assert.deepEqual(scan(step("**Lane:** ci", "**Deferred:** #631 — the storage double lands first")), []);
  assert.ok(scan(step("**Lane:** ci", "**Deferred:** later")).some((p) => p.includes("without an owner")));
  assert.deepEqual(scan(step("**Lane:** human", "**Judgement:** his own device.", "**Deferred:** #628 — rebuilt in Phase 7")), []);
  assert.deepEqual(scan(step("**Lane:** capture", "**Deferred:** #628 — real renders arrive in Phase 7")), []);
});

test("a whitespace-only or empty citation is refused in every machine lane", () => {
  for (const lane of ["ci", "scripted", "live", "capture"]) {
    assert.ok(scan(step(`**Lane:** ${lane}`, "**Check:** `   `")).some((p) => p.includes("non-empty")), lane);
    assert.ok(scan(step(`**Lane:** ${lane}`, "**Check:** ``")).some((p) => p.includes("non-empty")), lane);
  }
});

test("a check supplied on a deferred step is still validated", () => {
  const deferred = "**Deferred:** #631 — partial evidence kept";
  assert.deepEqual(scan(step("**Lane:** ci", "**Check:** `src/__tests__/help.test.ts`", deferred)), []);
  assert.ok(scan(step("**Lane:** ci", "**Check:** `src/__tests__/gone.test.ts`", deferred)).some((p) => p.includes("does not exist")));
  assert.ok(scan(step("**Lane:** ci", "**Check:** the help test", deferred)).some((p) => p.includes("backticked")));
  assert.deepEqual(scan(step("**Lane:** ci", deferred)), []);
});

// --- the judgement line -----------------------------------------------------

test("a human step without a Judgement line is a finding, deferred or not", () => {
  assert.ok(scan(step("**Lane:** human")).some((p) => p.includes('lane "human" with no **Judgement:**')));
  assert.ok(scan(step("**Lane:** human", "**Deferred:** #628 — Phase 5")).some((p) => p.includes("no **Judgement:**")));
});

test("an empty or doubled Judgement line is a finding", () => {
  assert.ok(scan(step("**Lane:** human", "**Judgement:**")).some((p) => p.includes("empty **Judgement:**")));
  assert.ok(scan(step("**Lane:** human", "**Judgement:** taste.", "**Judgement:** device.")).some((p) => p.includes("2 **Judgement:** lines")));
});

test("a Judgement line on any machine lane is a finding", () => {
  for (const lane of ["ci", "scripted", "live", "capture"]) {
    const found = scan(step(`**Lane:** ${lane}`, "**Check:** `src/__tests__/help.test.ts`", "**Judgement:** taste."));
    assert.ok(found.some((p) => p.includes("carries a **Judgement:** line")), lane);
  }
});

test("a regression step in the human lane needs its Judgement line too", () => {
  const found = scanBody(body({ regression: "#### R1. Still there\n\n**Do:** Look.\n\n**Expect:** Yes.\n\n**Lane:** human" }), { exists: real });
  assert.ok(found.some((p) => p.includes('"R1. Still there"') && p.includes("**Judgement:**")));
});

// --- where the body comes from ---------------------------------------------

test("readBody prefers --body-file, then the pull_request event, and refuses with neither", () => {
  const dir = mkdtempSync(join(tmpdir(), "uat-body-"));
  try {
    const file = join(dir, "body.md");
    writeFileSync(file, "## UAT\n");
    assert.equal(readBody({ argv: ["--body-file", file], env: {} }).body, "## UAT\n");
    assert.match(readBody({ argv: ["--body-file"], env: {} }).error, /needs a path/);

    const pr = join(dir, "pr.json");
    writeFileSync(pr, JSON.stringify({ pull_request: { number: 7, body: "## UAT\nx" } }));
    const fromEvent = readBody({ argv: [], env: { GITHUB_EVENT_PATH: pr } });
    assert.equal(fromEvent.body, "## UAT\nx");
    assert.match(fromEvent.source, /#7/);

    const nullBody = join(dir, "null.json");
    writeFileSync(nullBody, JSON.stringify({ pull_request: { number: 8, body: null } }));
    assert.equal(readBody({ argv: [], env: { GITHUB_EVENT_PATH: nullBody } }).body, "", "an empty description is an empty body, not a crash");

    const push = join(dir, "push.json");
    writeFileSync(push, JSON.stringify({ ref: "refs/heads/main" }));
    assert.match(readBody({ argv: [], env: { GITHUB_EVENT_PATH: push, GITHUB_EVENT_NAME: "push" } }).skip, /push event carries no pull request/);

    assert.match(readBody({ argv: [], env: {} }).error, /no PR body to check/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("as a process: a drivable section exits 0, a broken one exits 1, no source refuses, a push event passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "uat-proc-"));
  try {
    const run = (args, env = {}) => {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    const good = join(dir, "good.md");
    writeFileSync(good, body({ steps: step("**Lane:** scripted", "**Check:** `node -e 1`") }));
    const ok = run(["--body-file", good]);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /drivable/);

    const bad = join(dir, "bad.md");
    writeFileSync(bad, body({ steps: "#### 1. Look\n\n**Do:** x" }));
    const fail = run(["--body-file", bad]);
    assert.equal(fail.code, 1, fail.out);
    assert.match(fail.out, /0 \*\*Expect:\*\* lines/);
    assert.match(fail.out, /"## UAT" section/);

    const none = join(dir, "none.md");
    writeFileSync(none, "## Summary\n\nno UAT owed\n");
    const noSection = run(["--body-file", none]);
    assert.equal(noSection.code, 0, noSection.out);
    assert.match(noSection.out, /no ## UAT section/);

    const refused = run([]);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /no PR body to check/);

    const push = join(dir, "push.json");
    writeFileSync(push, JSON.stringify({ ref: "refs/heads/main" }));
    const skipped = run([], { GITHUB_EVENT_PATH: push, GITHUB_EVENT_NAME: "push" });
    assert.equal(skipped.code, 0, skipped.out);
    assert.match(skipped.out, /nothing to check/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
