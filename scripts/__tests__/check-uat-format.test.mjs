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
    steps ?? ["### 1. Open it", "", "**Do:** Click Help.", "", "**Expect:** The Manual."].join("\n"),
    "",
    "## Regression",
    "",
    regression ??
      ["### R1. Sidebar unchanged", "", "**Do:** Look at it.", "", "**Expect:** Same items."].join("\n"),
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
