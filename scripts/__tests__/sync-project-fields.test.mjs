import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalize,
  labelsToFieldValues,
  resolveOption,
  resolveField,
  restAll,
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
    { field: "Waiting on", wanted: null },
    { field: "Mode", wanted: null },
  ]);
});

test("unrelated labels leave every field marked for clearing", () => {
  // Every configured field is always represented — `wanted: null` means
  // "no matching label", which the caller must treat as clear-this-field,
  // not skip-this-field. An issue with no workstream labels at all should
  // still clear a project row that predates this convention.
  assert.deepEqual(labelsToFieldValues(["dependencies", "javascript"]), [
    { field: "Status", wanted: null },
    { field: "Waiting on", wanted: null },
    { field: "Mode", wanted: null },
  ]);
});

test("a partial label set clears the fields it doesn't name", () => {
  // Regression: an `unlabeled` event that removes `waiting:codex` without
  // adding a replacement must clear `Waiting on` on the board, not leave the
  // previous value (e.g. "David") standing after the label is gone.
  assert.deepEqual(labelsToFieldValues(["stage:planning"]), [
    { field: "Status", wanted: "planning" },
    { field: "Waiting on", wanted: null },
    { field: "Mode", wanted: null },
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

test("resolveField matches a field name regardless of case", () => {
  // Regression: the project's real "Waiting On" field (capital O, created by
  // hand in the UI) didn't match the "Waiting on" this script is configured
  // with — an exact-string match meant every workstream failed to sync on
  // the first real run against the live board. resolveOption already
  // normalized for exactly this kind of drift; resolveField now does too.
  const waitingOn = { name: "Waiting On", options: [] };
  assert.equal(resolveField([STATUS_FIELD, waitingOn], "Waiting on"), waitingOn);
});

test("every configured prefix ends in a colon", () => {
  // The slug is taken as everything after the prefix, so a prefix without its
  // delimiter would silently capture the colon into the option name.
  for (const { prefix } of LABEL_FIELDS) {
    assert.ok(prefix.endsWith(":"), `prefix without colon: ${prefix}`);
  }
});

test("restAll follows Link: rel=next until exhausted", async (t) => {
  // Regression: a full reconcile only read the first REST page. A repo whose
  // open-issue count crosses the page boundary would silently drop later
  // workstreams from the backfill — this pins the fix.
  const pages = [
    { body: [{ number: 1 }, { number: 2 }], link: '<https://api.github.com/p2>; rel="next"' },
    { body: [{ number: 3 }], link: '<https://api.github.com/p3>; rel="next"' },
    { body: [{ number: 4 }], link: "" }, // no rel="next" — last page
  ];
  let call = 0;

  t.mock.method(globalThis, "fetch", async () => {
    const page = pages[call++];
    return {
      ok: true,
      headers: { get: (name) => (name === "link" ? page.link : null) },
      json: async () => page.body,
    };
  });

  const issues = await restAll("/repos/x/y/issues?state=open&per_page=100", "tok");
  assert.deepEqual(
    issues.map((i) => i.number),
    [1, 2, 3, 4],
  );
  assert.equal(call, 3, "should have followed exactly 2 next-links after the first page");
});

test("restAll stops at a single page when there is no Link header", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    headers: { get: () => null },
    json: async () => [{ number: 1 }],
  }));

  const issues = await restAll("/repos/x/y/issues", "tok");
  assert.deepEqual(
    issues.map((i) => i.number),
    [1],
  );
});
