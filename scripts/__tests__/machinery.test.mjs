// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
//
// The shared module's own suite. Every case here was already covered before
// the #89 cut -- the configuration half by `review-budget.test.mjs` and the
// root walk by `check-claude-md-budget.test.mjs`, both of which went with
// their scripts. The behaviour outlived them, so the tests did too: this file
// is those cases carried over, not new coverage invented for a new module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MACHINERY_CONFIG_FILE,
  findRepoRoot,
  machineryConfig,
  modelTier,
  nodeIo,
  repoSlug,
  validate,
  assertSchemaSupported,
  splitFrontmatter,
  frontmatterValue,
  agentFrontmatter,
  claudeAlias,
  __resetRepoSlugCache,
} from "../machinery.mjs";

// ---------------------------------------------------------------------------
// Locating the repository
// ---------------------------------------------------------------------------

const fresh = () => mkdtempSync(join(tmpdir(), "machinery-"));

const repoWith = (config) => {
  const root = fresh();
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(join(root, MACHINERY_CONFIG_FILE), JSON.stringify(config));
  return root;
};

test("findRepoRoot asks the filesystem rather than matching the path string", () => {
  // The scripts live one level deeper in the handbook than in a consumer, and
  // deciding that by looking for "/core/" in a path is the compare-a-path-as-a
  // -string defect class this repository has paid for repeatedly.
  const root = repoWith({ repo: "o/r" });
  try {
    const deep = join(root, "core", "scripts");
    mkdirSync(deep, { recursive: true });
    assert.equal(findRepoRoot(deep), root);
    assert.equal(findRepoRoot(join(root, "scripts")), root, "and from a consumer's depth");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findRepoRoot reports 'not found' rather than guessing a root", () => {
  // Null instead of a throw: callers turn it into their own refusal, and a
  // total function cannot surprise one that reads it at import time.
  const orphan = fresh();
  try {
    assert.equal(findRepoRoot(orphan), null);
  } finally {
    rmSync(orphan, { recursive: true, force: true });
  }
});

test("root discovery stops at the enclosing repository, not the filesystem", () => {
  // A checkout nested under a configured parent must fail closed rather than
  // adopt the parent's configuration and stamp every artifact with a
  // repository the operator never chose. (Codex, #60 round 1, reproduced.)
  const parent = repoWith({ repo: "parent/repo" });
  try {
    const child = join(parent, "child");
    mkdirSync(join(child, ".git"), { recursive: true });
    mkdirSync(join(child, "scripts"), { recursive: true });
    assert.equal(findRepoRoot(join(child, "scripts")), null, "must not cross the child's .git");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The declared identity
// ---------------------------------------------------------------------------

// A reader over an in-memory configuration, keyed by a distinct root so the
// per-root memo does not leak one case into the next.
let ioSeq = 0;
const fakeIo = (config) => ({
  root: `/test/machinery-${ioSeq++}`,
  read: (rel) => (rel === MACHINERY_CONFIG_FILE ? config : null),
});

test("the declared identity is what every caller binds to", () => {
  __resetRepoSlugCache();
  const io = fakeIo(JSON.stringify({ repo: "Owner/Repo" }));
  assert.equal(repoSlug(io), "Owner/Repo");
  assert.deepEqual(Object.keys(machineryConfig(io)), ["repo", "models"], "identity and the model tiers -- one read");
  __resetRepoSlugCache();
});

test("`requiredChecks` is no longer read, so a consumer is not asked to fill in a dead field", () => {
  // It existed for `pr-ready.mjs`'s merge gate, which the #89 cut removed
  // (#97 meets that requirement with GitHub's own ruleset instead). A config
  // that still carries one is accepted and ignored rather than refused -- a
  // consumer's file is theirs, and a removal here must not break their repo.
  __resetRepoSlugCache();
  const io = fakeIo(JSON.stringify({ repo: "Owner/Repo", requiredChecks: [] }));
  assert.equal(repoSlug(io), "Owner/Repo", "an empty list used to refuse; now it is simply unread");
  __resetRepoSlugCache();
});

test("REFUSES to operate when no identity is declared", () => {
  // The fail-closed direction is the point: a script that guessed would stamp
  // its output with a repository nobody chose.
  __resetRepoSlugCache();
  assert.throws(() => repoSlug(fakeIo(null)), /is missing/);
  __resetRepoSlugCache();
});

test("REFUSES a malformed declaration rather than reading past it", () => {
  // Each of these is a different way to arrive at "no usable identity", and
  // every one must refuse rather than fall through to a default.
  const bad = {
    "not json at all": /not valid JSON/,
    "{}": /must declare "repo"/,
    '{"repo":"onlyone"}': /must declare "repo"/,
    '{"repo":"Owner/Repo/extra"}': /must declare "repo"/,
    '{"repo":"   "}': /must declare "repo"/,
    '{"repo":"OWNER/REPO"}': /still carries the template's placeholder/,
  };
  for (const [config, expected] of Object.entries(bad)) {
    __resetRepoSlugCache();
    assert.throws(() => repoSlug(fakeIo(config)), expected, config);
  }
  __resetRepoSlugCache();
});

test("identity is read from the WORKING TREE, by design", () => {
  // Ten rounds on PR #7 moved this read to the durable ref and the base commit
  // to defend against an actor who can edit this checkout -- the person
  // running the script, who needs no exploit. It is configuration, so it lives
  // where configuration lives, and it exists to catch MISTAKES.
  // (.agents/memory/machinery-threat-model-is-my-own-mistakes.md)
  __resetRepoSlugCache();
  assert.equal(repoSlug(fakeIo(JSON.stringify({ repo: "Other/Repo" }))), "Other/Repo");
  __resetRepoSlugCache();
});

test("identity is read ONCE per checkout, not per call", () => {
  __resetRepoSlugCache();
  let reads = 0;
  const io = {
    root: "/test/counted",
    read: (rel) => {
      if (rel !== MACHINERY_CONFIG_FILE) return null;
      reads++;
      return JSON.stringify({ repo: "A/B" });
    },
  };
  assert.equal(repoSlug(io), "A/B");
  assert.equal(repoSlug(io), "A/B");
  assert.equal(repoSlug(io), "A/B");
  assert.equal(reads, 1);
  __resetRepoSlugCache();
});

test("an unreadable configuration throws rather than reading as absent", () => {
  // ENOENT-only tolerance. Collapsing a permissions or I/O fault into "absent"
  // turns a broken checkout into an unconfigured one and loses the real
  // reason, which is the direction every read in this repo fails the other way.
  const root = repoWith({ repo: "o/r" });
  try {
    const io = nodeIo(root);
    assert.equal(io.read("nothing-here.json"), null, "a genuinely absent file is null");
    // A directory read raises EISDIR, which is not ENOENT and must escape.
    assert.throws(() => io.read(".git"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Model tiers
// ---------------------------------------------------------------------------

test("a model TIER resolves through configuration, and every bad shape fails closed", () => {
  __resetRepoSlugCache();
  const withModels = (models) => fakeIo(JSON.stringify({ repo: "Owner/Repo", models }));

  const ok = modelTier("strongestClaude", withModels({ strongestClaude: { id: "claude-fable-5-1", effort: "xhigh" } }));
  assert.deepEqual(ok, { tier: "strongestClaude", id: "claude-fable-5-1", effort: "xhigh" });

  __resetRepoSlugCache();
  assert.throws(() => modelTier("strongestClaude", withModels(null)), /declares no "models" block/);
  __resetRepoSlugCache();
  assert.throws(
    () => modelTier("strongestCodex", withModels({ strongestClaude: { id: "a-b", effort: "x" } })),
    /declares no "strongestCodex"/,
  );
  // AN ALIAS IS THE REFUSAL THAT MOVED HERE from the role definitions: a
  // dispatch stamps the id it asked for against the id that answered, and
  // "fable" cannot be compared to "claude-fable-5-1".
  for (const alias of ["fable", "best", "opus"]) {
    __resetRepoSlugCache();
    assert.throws(() => modelTier("strongestClaude", withModels({ strongestClaude: { id: alias, effort: "x" } })), /alias or an/);
  }
  __resetRepoSlugCache();
  assert.throws(() => modelTier("strongestClaude", withModels({ strongestClaude: { effort: "x" } })), /declares no "id"/);
  __resetRepoSlugCache();
  assert.throws(() => modelTier("strongestClaude", withModels({ strongestClaude: { id: "a-b" } })), /declares no "effort"/);
  __resetRepoSlugCache();
});

test("this repository's own configuration resolves", () => {
  // The module is read by scripts that run here, so the live file is part of
  // the contract rather than a fixture.
  __resetRepoSlugCache();
  assert.match(repoSlug(), /^[^/\s]+\/[^/\s]+$/);
  for (const tier of ["strongestClaude", "strongestCodex"]) {
    assert.ok(modelTier(tier).id.includes("-"), `${tier} resolves to a full id`);
  }
  __resetRepoSlugCache();
});

// ---------------------------------------------------------------------------
// The shared validator
// ---------------------------------------------------------------------------

test("validate enforces every keyword the schemas use", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["name", "tags"],
    properties: {
      name: { type: "string" },
      status: { type: "string", enum: ["ok", "bad"] },
      count: { type: "number" },
      done: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
      bio: { type: "string", minTrimmedLength: 1 },
    },
  };
  assert.deepEqual(validate({ name: "a", tags: [], status: "ok", count: 1, done: true }, schema), []);
  assert.ok(validate({ tags: [] }, schema).some((p) => p.includes('missing required key "name"')));
  assert.ok(validate({ name: "a", tags: [], extra: 1 }, schema).some((p) => p.includes('unexpected key "extra"')));
  assert.ok(validate({ name: "a", tags: [], status: "maybe" }, schema).some((p) => p.includes("is not one of")));
  assert.ok(validate({ name: "a", tags: "x" }, schema).some((p) => p.includes("expected an array")));
  assert.ok(validate({ name: "a", tags: [1] }, schema).some((p) => p.includes("$.tags[0]")));
  assert.ok(validate({ name: 1, tags: [] }, schema).some((p) => p.includes("expected a string")));
  assert.ok(validate([], schema).some((p) => p.includes("expected an object")));
  // `minTrimmedLength` measures the string a reader would actually get, which
  // is the whole reason it is not `minLength`: a required prose field set to
  // three spaces used to validate and render under a favourable headline.
  // (#116, from #109 round 9.)
  assert.deepEqual(validate({ name: "a", tags: [], bio: "x" }, schema), []);
  for (const blank of ["", " ", "   ", "\n\t "]) {
    assert.ok(
      validate({ name: "a", tags: [], bio: blank }, schema).some((p) => p.includes("once trimmed")),
      `bio ${JSON.stringify(blank)} should be refused as unfilled`,
    );
  }
});

test("assertSchemaSupported refuses a keyword the validator cannot enforce", () => {
  // A keyword sent to the model but not checked here means an output could be
  // accepted that does not satisfy the schema. Refusing the SCHEMA is the only
  // place that mismatch is visible; at answer time it is a silent pass.
  assert.throws(
    () => assertSchemaSupported({ type: "object", properties: { a: { type: "string", format: "email" } } }),
    /format/,
  );
  assert.throws(() => assertSchemaSupported({ type: "array", items: { type: "string", pattern: "x" } }), /pattern/);
  // `minTrimmedLength` moved from refused to enforced when the
  // round-translation schema needed it. The pair below is the point: it is
  // accepted HERE only because `validate` actually checks it, which the
  // keyword test above asserts.
  assert.doesNotThrow(() =>
    assertSchemaSupported({ type: "object", properties: { a: { type: "string", minTrimmedLength: 3 } } }),
  );
  // And `minLength` is refused BY NAME rather than falling through to the
  // generic message, which an author would read as "add support for it" --
  // rebuilding the fail-open this keyword exists to close. (#116.)
  assert.throws(
    () => assertSchemaSupported({ type: "object", properties: { a: { type: "string", minLength: 1 } } }),
    /minTrimmedLength/,
  );
  assert.throws(
    () => assertSchemaSupported({ type: "array", items: { type: "string", minLength: 1 } }),
    /minTrimmedLength/,
    "the refusal reaches nested schemas, where most of the prose fields live",
  );
  assert.doesNotThrow(() =>
    assertSchemaSupported({ type: "object", required: ["a"], additionalProperties: false, properties: { a: { type: "string" } } }),
  );
});

// ---------------------------------------------------------------------------
// Agent-definition frontmatter (#126, #131)
// ---------------------------------------------------------------------------

const DEFINITION = [
  "---",
  "name: fable-review-assessor",
  'description: "A role."',
  "tools: Read, Grep",
  "model: claude-fable-5-1",
  "effort: xhigh",
  "---",
  "",
  "# Prose",
  "",
  "Body text.",
].join("\n");

test("a CRLF definition parses identically to an LF one, field for field", () => {
  // THE ASSERTION THE HALF-FIX FAILS, which is why it is here as a check
  // rather than as a warning in prose. Finding 4051974440 proposed trimming
  // the closing delimiter; that makes `splitFrontmatter` return a block whose
  // every field still carries `\r`, and JS `.` does not match `\r`, so `name`,
  // `model` and `effort` all read null. `check-agent-models` selects roles by
  // `name.startsWith("fable-")`, so the role would be SKIPPED and the check
  // would pass having checked nothing — strictly worse than today's loud
  // "unreadable". Splitting on /\r?\n/ covers delimiters and fields together.
  // (The Fable assessor, #131 round 2 follow-up 1, which asked for exactly
  // this fixture; Astra named the insufficiency of the half-fix.)
  const lf = splitFrontmatter(DEFINITION);
  const crlf = splitFrontmatter(DEFINITION.replace(/\n/g, "\r\n"));

  assert.ok(lf, "LF frontmatter did not parse");
  assert.ok(crlf, "CRLF frontmatter did not parse");
  for (const key of ["name", "model", "effort", "tools"]) {
    assert.equal(frontmatterValue(crlf.head, key), frontmatterValue(lf.head, key), `${key} differs between LF and CRLF`);
  }
  assert.equal(frontmatterValue(crlf.head, "name"), "fable-review-assessor");
  assert.equal(frontmatterValue(crlf.head, "effort"), "xhigh");
});

test("a file this cannot parse returns null, never an empty block", () => {
  // A caller must be able to tell "declares nothing" from "could not be read":
  // the first is a finding about the file, the second is a finding about this
  // reader, and collapsing them is how a checker reports success having
  // evaluated nothing.
  assert.equal(splitFrontmatter("no frontmatter at all\n"), null);
  assert.equal(splitFrontmatter("---\nname: x\nnever closed\n"), null);
  assert.equal(splitFrontmatter(""), null);
  assert.equal(splitFrontmatter(null), null);
});

test("a missing definition, or a missing key, is null rather than a plausible default", () => {
  const root = fresh();
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  writeFileSync(join(root, ".claude", "agents", "fable-review-assessor.md"), DEFINITION);

  assert.equal(agentFrontmatter(root, "fable-review-assessor", "effort"), "xhigh");
  assert.equal(agentFrontmatter(root, "fable-review-assessor", "nonesuch"), null);
  assert.equal(agentFrontmatter(root, "does-not-exist", "effort"), null);
  rmSync(root, { recursive: true, force: true });
});

test("the alias is derived from the pin, and is null for anything that is not a Claude id", () => {
  // The Agent tool's per-invocation `model` takes one of four aliases; a full
  // id is refused at input validation. So the alias is what the call actually
  // carries, and the header has to be able to say so separately from the pin
  // — otherwise a pin trailing the alias reads as the platform substituting a
  // model. (#131 round 2, both assessors.)
  assert.equal(claudeAlias("claude-fable-5-1"), "fable");
  assert.equal(claudeAlias("claude-opus-5"), "opus");
  assert.equal(claudeAlias("claude-haiku-4-5-20251001"), "haiku");
  for (const not of ["gpt-6-astra", "fable", "", null, undefined, 5]) {
    assert.equal(claudeAlias(not), null, `claudeAlias(${JSON.stringify(not)})`);
  }
});
