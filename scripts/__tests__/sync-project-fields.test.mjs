import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalize,
  labelsToFieldValues,
  resolveOption,
  resolveField,
  LABEL_FIELDS,
} from "../sync-project-fields.mjs";

// The real board's Status options, verbatim — these are the exact strings the
// matcher has to survive, including the 🛑 marker David scans for and the
// parenthetical actor on the Replit stage.
const STATUS_FIELD = {
  name: "Status",
  options: [
    { id: "o1", name: "Discovery" },
    { id: "o2", name: "Planning" },
    { id: "o3", name: "🛑 Plan approval" },
    { id: "o4", name: "Coding" },
    { id: "o5", name: "Code review" },
    { id: "o6", name: "🛑 Merge" },
    { id: "o7", name: "Test run (Replit)" },
    { id: "o8", name: "🛑 UAT" },
    { id: "o9", name: "Close-out" },
    { id: "o10", name: "Done" },
  ],
};

test("normalize strips emoji, hyphens, case, and parentheticals", () => {
  assert.equal(normalize("🛑 Plan approval"), "plan approval");
  assert.equal(normalize("Test run (Replit)"), "test run");
  assert.equal(normalize("Close-out"), "close out");
  assert.equal(normalize("🛑 UAT"), "uat");
  assert.equal(normalize("code-review"), "code review");
});

test("every Status option is reachable from its label slug", () => {
  // The mapping is only useful if it is total: any stage the board can be in
  // must be nameable by a label. A new option added in the UI without a
  // corresponding label slug would silently never be set.
  const slugs = {
    discovery: "o1",
    planning: "o2",
    "plan-approval": "o3",
    coding: "o4",
    "code-review": "o5",
    merge: "o6",
    "test-run": "o7",
    uat: "o8",
    "close-out": "o9",
    done: "o10",
  };
  for (const [slug, expected] of Object.entries(slugs)) {
    assert.equal(resolveOption(STATUS_FIELD, slug), expected, `slug: ${slug}`);
  }
});

test("labels map to their fields by prefix", () => {
  assert.deepEqual(
    labelsToFieldValues(["stage:code-review", "waiting:david", "mode:feature"]),
    [
      { field: "Status", wanted: "code-review" },
      { field: "Waiting on", wanted: "david" },
      { field: "Mode", wanted: "feature" },
    ],
  );
});

test("labels arrive as REST objects too, not just strings", () => {
  assert.deepEqual(labelsToFieldValues([{ name: "stage:coding" }]), [
    { field: "Status", wanted: "coding" },
  ]);
});

test("unrelated labels are ignored", () => {
  assert.deepEqual(labelsToFieldValues(["dependencies", "javascript"]), []);
});

test("a partial label set writes only the fields it names", () => {
  assert.deepEqual(labelsToFieldValues(["stage:planning"]), [
    { field: "Status", wanted: "planning" },
  ]);
});

test("two labels sharing a prefix is an error, not a coin flip", () => {
  // An issue in two stages at once is a real mistake. Picking one would put a
  // confident wrong value on the board, which is worse than a loud failure.
  assert.throws(
    () => labelsToFieldValues(["stage:coding", "stage:code-review"]),
    /exactly one expected/,
  );
});

test("an unmatched label names the available options", () => {
  assert.throws(
    () => resolveOption(STATUS_FIELD, "shipping"),
    /no option on field "Status" matches "shipping".*Discovery/s,
  );
});

test("a missing field names the available fields", () => {
  assert.throws(
    () => resolveField([STATUS_FIELD], "Waiting on"),
    /no single-select field named "Waiting on".*Status/s,
  );
});

test("every configured prefix ends in a colon", () => {
  // The slug is taken as everything after the prefix, so a prefix without its
  // delimiter would silently capture the colon into the option name.
  for (const { prefix } of LABEL_FIELDS) {
    assert.ok(prefix.endsWith(":"), `prefix without colon: ${prefix}`);
  }
});
