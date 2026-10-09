// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanDoc, uatFiles, UAT_DIR } from "../check-uat-format.mjs";

const NAME = "docs/tests/UAT/PR472_ADMIN_HELP_SYSTEM_UAT.md";

const doc = ({ title, setup, steps, regression, tail = "" } = {}) =>
  [
    title ?? "# PR #472 — The Manual — UAT",
    "",
    "Some framing prose for David.",
    "",
    "## Setup",
    "",
    setup ?? "- [claude] Confirm the Repl is synced.",
    "",
    "## Steps",
    "",
    steps ?? ["### 1. Open it", "", "**Do:** Click Help.", "", "**Expect:** The Manual.", "", "**Lane:** human"].join("\n"),
    "",
    "## Regression",
    "",
    regression ??
      ["### R1. Sidebar unchanged", "", "**Do:** Look at it.", "", "**Expect:** Same items.", "", "**Lane:** human"].join("\n"),
    "",
    tail,
  ].join("\n");

test("a doc in the format passes clean", () => {
  assert.deepEqual(scanDoc(NAME, doc()), []);
});

test("Not bugs is optional", () => {
  assert.deepEqual(scanDoc(NAME, doc({ tail: "## Not bugs\n\n- Something.\n" })), []);
  assert.deepEqual(scanDoc(NAME, doc({ tail: "" })), []);
});

test("the title must match the exact shape", () => {
  for (const bad of [
    "# PR 472 — The Manual — UAT",
    "# PR #472 - The Manual - UAT",
    "# The Manual — UAT",
    "# PR #472 — The Manual",
  ]) {
    assert.ok(
      scanDoc(NAME, doc({ title: bad })).some((p) => p.includes("first heading")),
      `should reject title: ${bad}`,
    );
  }
});

test("the title's PR number must agree with the filename", () => {
  const found = scanDoc(NAME, doc({ title: "# PR #999 — The Manual — UAT" }));
  assert.ok(found.some((p) => p.includes("title says PR #999") && p.includes("PR472")));
});

test("each required section must be present", () => {
  const full = doc();
  for (const section of ["## Setup", "## Steps", "## Regression"]) {
    const without = full.replace(`${section}\n`, "");
    assert.ok(
      scanDoc(NAME, without).some((p) => p.includes(`missing required section "${section}"`)),
      `should require ${section}`,
    );
  }
});

test("required sections must appear in order", () => {
  const outOfOrder = [
    "# PR #472 — The Manual — UAT",
    "## Steps",
    "### 1. Open it",
    "**Do:** Click.",
    "**Expect:** It opens.",
    "## Setup",
    "- [claude] Sync.",
    "## Regression",
    "### R1. Still fine",
    "**Do:** Look.",
    "**Expect:** Fine.",
  ].join("\n");
  assert.ok(scanDoc(NAME, outOfOrder).some((p) => p.includes("must come after")));
});

test("step IDs must be consecutive from 1", () => {
  const steps = [
    "### 1. First",
    "**Do:** a",
    "**Expect:** b",
    "",
    "### 3. Third",
    "**Do:** a",
    "**Expect:** b",
  ].join("\n");
  assert.ok(scanDoc(NAME, doc({ steps })).some((p) => p.includes("consecutively") && p.includes("2.")));
});

test("regression IDs must be R-prefixed and consecutive", () => {
  const regression = [
    "### R1. First",
    "**Do:** a",
    "**Expect:** b",
    "",
    "### R3. Third",
    "**Do:** a",
    "**Expect:** b",
  ].join("\n");
  assert.ok(scanDoc(NAME, doc({ regression })).some((p) => p.includes("R2.")));

  const unprefixed = ["### 1. First", "**Do:** a", "**Expect:** b"].join("\n");
  assert.ok(scanDoc(NAME, doc({ regression: unprefixed })).some((p) => p.includes("R1.")));
});

test("a compound step is rejected — two Do/Expect pairs under one heading", () => {
  // The driver presents one step per turn, so a compound step produces a
  // compound answer and a muddy record. This is the single most common
  // defect when converting a legacy doc.
  const steps = [
    "### 1. Two things at once",
    "**Do:** First action.",
    "**Expect:** First result.",
    "**Do:** Second action.",
    "**Expect:** Second result.",
  ].join("\n");
  const found = scanDoc(NAME, doc({ steps }));
  assert.ok(found.some((p) => p.includes("2 **Do:** lines")));
  assert.ok(found.some((p) => p.includes("2 **Expect:** lines")));
});

test("a step with no Do or no Expect is rejected", () => {
  const noDo = ["### 1. Look", "**Expect:** Something."].join("\n");
  assert.ok(scanDoc(NAME, doc({ steps: noDo })).some((p) => p.includes("0 **Do:** lines")));
  const noExpect = ["### 1. Look", "**Do:** Something."].join("\n");
  assert.ok(scanDoc(NAME, doc({ steps: noExpect })).some((p) => p.includes("0 **Expect:** lines")));
});

test("a step's Do/Expect count stops at the next section, not the next heading anywhere", () => {
  // Regression guard for the boundary itself: the last step in a section
  // must not absorb prose from the section that follows it.
  const clean = doc({ tail: "## Not bugs\n\n- **Do:** this is prose, not a step.\n" });
  assert.deepEqual(scanDoc(NAME, clean), []);
});

test("an empty Steps or Regression section is rejected", () => {
  assert.ok(scanDoc(NAME, doc({ steps: "Some prose but no headings." })).some((p) => p.includes("no ### headings")));
  assert.ok(
    scanDoc(NAME, doc({ regression: "Nothing to check." })).some((p) => p.includes("no ### headings")),
  );
});

test("setup lines must use the fixed tag vocabulary", () => {
  assert.ok(scanDoc(NAME, doc({ setup: "- Sign in as admin." })).some((p) => p.includes("must start with one of")));
  assert.ok(scanDoc(NAME, doc({ setup: "- [someone] Do a thing." })).some((p) => p.includes("must start with one of")));
  assert.ok(scanDoc(NAME, doc({ setup: "Just prose." })).some((p) => p.includes("bullets or the single line")));
});

test("all three setup tags are accepted, and so is None.", () => {
  for (const tag of ["[claude]", "[david]", "[restore]"]) {
    assert.deepEqual(scanDoc(NAME, doc({ setup: `- ${tag} A thing.` })), [], `should accept ${tag}`);
  }
  assert.deepEqual(scanDoc(NAME, doc({ setup: "None." })), []);
});

test("a wrapped setup bullet's continuation line is not read as a new tag", () => {
  // These docs wrap at 80 columns, so most real bullets have continuations.
  const wrapped = ["- [claude] Something long enough that it wraps onto", "  a second line here."].join("\n");
  assert.deepEqual(scanDoc(NAME, doc({ setup: wrapped })), []);
});

test("uatFiles enumerates the UAT directory and skips README", () => {
  const files = uatFiles();
  assert.ok(Array.isArray(files));
  assert.ok(files.every((f) => f.startsWith(`${UAT_DIR}/`) && f.endsWith(".md")));
  assert.ok(!files.some((f) => f.endsWith("README.md")));
});

test('"None." is a legitimate Regression body, but not a legitimate Steps body', () => {
  // A PR that genuinely couldn't break anything says so rather than padding
  // the sweep. Requiring a non-empty sweep made three conversions invent
  // checks nobody had written — the guard should not recreate that pressure.
  assert.deepEqual(scanDoc(NAME, doc({ regression: "None." })), []);
  assert.ok(
    scanDoc(NAME, doc({ steps: "None." })).some((p) => p.includes("no ### headings")),
    "a UAT with nothing to test is not a UAT",
  );
});

test("an empty Regression section names the None. escape in its message", () => {
  const found = scanDoc(NAME, doc({ regression: "Some prose, no headings." }));
  assert.ok(found.some((p) => p.includes('"None."')));
});

test('"None." may carry a reason after it, in either escapable section', () => {
  // A bare "None." reads as an oversight and invites a later editor to fill
  // it with padding, which is what the escape exists to prevent.
  const withReason = "None. Steps 1 and 2 are the sweep for this PR.";
  assert.deepEqual(scanDoc(NAME, doc({ regression: withReason })), []);
  assert.deepEqual(scanDoc(NAME, doc({ setup: withReason })), []);
});

test("a filename outside PR<N>_<FEATURE>_UAT.md is a finding, not a silent pass", () => {
  // A doc can be structurally perfect and still never be offered for a run:
  // /uat discovers candidates by globbing this exact filename shape. (Codex,
  // #561 round 1.)
  assert.ok(scanDoc("docs/tests/UAT/foo.md", doc()).some((p) => p.includes("filename must match")));
  assert.ok(scanDoc("docs/tests/UAT/PR999_FEATURE.md", doc()).some((p) => p.includes("filename must match")));
  assert.deepEqual(scanDoc("docs/tests/UAT/PR999_TWO_WORD_FEATURE_UAT.md", doc({ title: "# PR #999 — Two Word Feature — UAT" })), []);
});

test('a heading after "None." is validated normally, not silently exempted', () => {
  // "None." only means "there are no headings here" -- once one exists, it
  // is a real step /uat will enumerate, so it needs a real Do/Expect like
  // any other. (Codex, #561 round 2.)
  const withHeading = ["None. Nothing intended.", "", "### broken heading with no body"].join("\n");
  const found = scanDoc(NAME, doc({ regression: withHeading }));
  assert.ok(found.length > 0, "a heading after None. must still be checked");
  assert.ok(found.some((p) => p.includes("Do:") || p.includes("Expect:")));
});

// --- lanes ------------------------------------------------------------------

const step = (...fields) =>
  ["### 1. Open it", "", "**Do:** Click Help.", "", "**Expect:** The Manual.", "", ...fields].join("\n");
const real = (rel) => rel === "e2e/help.spec.ts" || rel === "src/__tests__/help.test.ts";
const scan = (steps) => scanDoc(NAME, doc({ steps }), { exists: real });

test("every lane is accepted, and a machine lane with an existing check passes", () => {
  assert.deepEqual(scan(step("**Lane:** human")), []);
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
  const found = scanDoc(NAME, doc({ regression: "### R1. Still there\n\n**Do:** Look.\n\n**Expect:** Yes." }), { exists: real });
  assert.ok(found.some((p) => p.includes('"R1. Still there"') && p.includes("**Lane:**")));
});

test("a machine lane without a check, or with an unbackticked one, is a finding", () => {
  for (const lane of ["ci", "scripted", "live"]) {
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
  assert.deepEqual(scan(step("**Lane:** human", "**Deferred:** #628 — rebuilt in Phase 7")), []);
});

test("a whitespace-only or empty citation is refused in every machine lane", () => {
  for (const lane of ["ci", "scripted", "live"]) {
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
