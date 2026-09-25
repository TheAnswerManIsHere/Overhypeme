#!/usr/bin/env node
// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
/**
 * The small shared module: this repository's machinery configuration, and the
 * dependency-free schema validator both dispatched roles answer through.
 *
 * WHY IT EXISTS. Until the #89 cut these helpers lived inside
 * `review-budget.mjs`, so every script that needed to know which repository it
 * was in imported the review-round budget to find out. When the budget was
 * removed the helpers had no home, and fourteen import sites pointed at a file
 * that was leaving. They are neutral — they decide nothing about a review loop
 * — so they became their own module rather than being rehoused in whichever
 * surviving script happened to be largest.
 *
 * WHAT BELONGS HERE. Two things, and they share the property of being read by
 * more than one caller while deciding nothing on their own: the configuration
 * every script needs to name its repository and resolve a model tier, and the
 * validator every structured answer is checked against. Nothing that rules on
 * a finding, counts a round, or gates a merge — that machinery is gone, and
 * this module is not where it grows back.
 */

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MACHINERY_CONFIG_FILE = ".agents/machinery.json";

/**
 * The root of the repository this machinery governs: the nearest enclosing
 * directory that declares a machinery configuration.
 *
 * WHY NOT `dirname(script)/..`, WHICH THIS REPLACES. That form assumes the
 * scripts sit exactly one level below the root. True in a consumer, where the
 * sync lands them at `<repo>/scripts/`; false in the handbook, where they are
 * payload at `<repo>/core/scripts/` and `..` is `core/`. So the handbook read
 * a configuration that is not there -- `core/.agents/machinery.json` does not
 * exist -- and wrote its artifacts INSIDE its own payload, where a sync would
 * carry one repository's history to every other.
 *
 * THE MARKER IS THE CONFIGURATION ITSELF, because "which root?" and "whose
 * configuration?" have to have one answer. Any other marker can disagree with
 * the file that declares identity, and a root disagreeing with its own
 * configuration is the bug being replaced, not a variant of it.
 *
 * BOUNDED BY THE ENCLOSING REPOSITORY. The walk stops at a `.git`, so a
 * checkout that declares nothing fails closed with `machineryConfig`'s own
 * message instead of silently binding to a PARENT directory's configuration
 * -- a wrong-repo mistake in its most confusing form, since every artifact
 * would then be stamped with a repository the operator never chose.
 *
 * TOTAL BY CONSTRUCTION: it cannot throw. `existsSync` reports false rather
 * than raising, and an unfound marker falls back to the previous resolution,
 * so an unconfigured checkout behaves exactly as it did and fails with the
 * same message.
 *
 * A CONSUMER SEES NO CHANGE. From `<repo>/scripts`, the first directory up
 * carrying `.agents/machinery.json` is `<repo>` -- the answer `..` gave.
 */
export function findRepoRoot(startDir) {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, MACHINERY_CONFIG_FILE))) return dir;
    if (fs.existsSync(path.join(dir, ".git"))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = findRepoRoot(SCRIPT_DIR) ?? path.resolve(SCRIPT_DIR, "..");

export const MACHINERY_CONFIG_HOWTO =
  `Commit ${MACHINERY_CONFIG_FILE} declaring this repository's machinery configuration. Shape: ` +
  `{"repo": "owner/name", "models": {"strongestClaude": {"id": "<full model id>", "effort": "<level>"}, ...}}.`;

const SLUG_RE = /^[^/\s]+\/[^/\s]+$/;

// The exact value `machinery.template.json` ships. Compared EXACTLY, not
// case-folded: "Owner/Repo" is a plausible real repository name, and a check
// that rejected it would refuse a legitimate consumer to catch an edit
// nobody makes -- changing the placeholder's case while leaving its letters.
const PLACEHOLDER_SLUG = "OWNER/REPO";

// Memoized per root: a checkout's configuration cannot change inside one
// process, and this is read on paths that run per command.
const CONFIG_CACHE = new Map();

/**
 * The minimal reader `machineryConfig` needs, injectable so a test can supply
 * a configuration without touching the filesystem.
 *
 * DELIBERATELY SMALLER THAN THE ADAPTER IT REPLACES. `review-budget.mjs`'s
 * `nodeIo` carried exclusive-create claims, a receipts lister and a git-ref
 * reader, all for the budget guard. None of that has a caller now, so none of
 * it moved: what is left is a repo-relative read and the root it resolves
 * against.
 *
 * `read` returns null ONLY for ENOENT. A permissions or I/O fault throws, so
 * an unreadable configuration is never collapsed into "absent" -- which would
 * turn a broken checkout into an unconfigured one and lose the real reason.
 */
export function nodeIo(root = REPO_ROOT) {
  return {
    root,
    read(rel) {
      try {
        return fs.readFileSync(path.join(root, rel), "utf8");
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },
  };
}

/**
 * This repository's declared identity, read from the working tree.
 *
 * THE THREAT MODEL IS MY OWN MISTAKES, NOT AN ADVERSARY. Ten review rounds on
 * PR #7 moved this read from the working tree to the durable ref to the base
 * commit and back, each time defending against an actor who can edit files in
 * this checkout -- who is the person running the script. That actor needs no
 * exploit; it can simply not run the script. The controls against deliberate
 * action are the server-side rulesets and David working alongside, reading the
 * latitude line every authority-widening PR carries, and no local script can
 * add to them. What this read has to do is catch a MISTAKE: running in the
 * wrong checkout, or running with the seed placeholder still in place. It does
 * that by failing closed on absent, malformed, or placeholder, and by being
 * the ONE place identity is read.
 * (`.agents/memory/machinery-threat-model-is-my-own-mistakes.md`.)
 */
export function machineryConfig(io = nodeIo()) {
  const key = io.root ?? "";
  if (!CONFIG_CACHE.has(key)) {
    const raw = io.read(MACHINERY_CONFIG_FILE);
    if (raw === null) {
      throw new Error(
        `${MACHINERY_CONFIG_FILE} is missing, so this checkout cannot say which repository it is. ` +
          MACHINERY_CONFIG_HOWTO,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${MACHINERY_CONFIG_FILE} is not valid JSON. ${MACHINERY_CONFIG_HOWTO}`);
    }
    const repo = typeof parsed?.repo === "string" ? parsed.repo.trim() : "";
    if (!SLUG_RE.test(repo)) {
      throw new Error(`${MACHINERY_CONFIG_FILE} must declare "repo" as "owner/name". ${MACHINERY_CONFIG_HOWTO}`);
    }
    // The seed's placeholder is SHAPED like an identity, so every structural
    // check passed it and an unedited template produced a working config
    // naming a repository that does not exist. (Codex, PR #7 round 6.)
    if (repo === PLACEHOLDER_SLUG) {
      throw new Error(
        `${MACHINERY_CONFIG_FILE} still carries the template's placeholder "${repo}". Replace it with ` +
          `this repository's real owner/name -- the seed is a form to fill in, not a default.`,
      );
    }
    CONFIG_CACHE.set(key, { repo, models: parsed?.models ?? null });
  }
  return CONFIG_CACHE.get(key);
}

/**
 * The model a TIER resolves to, and the effort it runs at.
 *
 * "Fable" and "Astra" name the strongest model from each family, not a
 * version (David, 2026-09-11). Every role definition and every reviewer pin
 * names a tier; this is the one place a tier becomes an id, so a new model
 * release is a one-value edit rather than a sweep through definitions,
 * scripts and documents.
 *
 * A FULL ID, NEVER AN ALIAS, and the refusal is the same one the role
 * definitions used to carry: a dispatch stamps the id it asked for against
 * the id that answered, and `fable` compared to `claude-fable-5-1` establishes
 * nothing. Moving the id into configuration moves that check here; it does not
 * remove it.
 *
 * Fails closed on every shape: no block, no tier, no id, an alias-shaped id.
 * The alternative is a dispatch that silently runs on whatever the provider
 * picks, which is precisely the "probably ran on 5.1" this check exists to
 * replace with an observation.
 */
export const MODEL_TIERS = ["strongestClaude", "strongestCodex"];

const FULL_MODEL_ID = /^[a-z][a-z0-9.]*(-[a-z0-9.]+)+$/;

export function modelTier(tier, io = nodeIo()) {
  const { models } = machineryConfig(io);
  if (!models || typeof models !== "object") {
    throw new Error(
      `${MACHINERY_CONFIG_FILE} declares no "models" block, so the tier "${tier}" cannot be resolved to a ` +
        `model id. Add it: {"models": {"strongestClaude": {"id": "<full model id>", "effort": "<level>"}, ` +
        `"strongestCodex": {"id": "<full model id>", "effort": "<level>"}}}.`,
    );
  }
  const entry = models[tier];
  if (!entry || typeof entry !== "object") {
    throw new Error(
      `${MACHINERY_CONFIG_FILE}'s "models" block declares no "${tier}". Known tiers: ${MODEL_TIERS.join(", ")}.`,
    );
  }
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!id) throw new Error(`${MACHINERY_CONFIG_FILE}'s models.${tier} declares no "id"`);
  if (!FULL_MODEL_ID.test(id)) {
    throw new Error(
      `${MACHINERY_CONFIG_FILE}'s models.${tier}.id is ${JSON.stringify(id)}, which is an alias or an ` +
        `unrecognised id. A dispatch stamps the model it asked for against the model that answered, and an ` +
        `alias cannot be compared -- "it ran on the strongest tier" would be probably-true and never ` +
        `established. Declare a full model id (for example claude-fable-5-1, or gpt-6-astra).`,
    );
  }
  const effort = typeof entry.effort === "string" ? entry.effort.trim() : "";
  if (!effort) throw new Error(`${MACHINERY_CONFIG_FILE}'s models.${tier} declares no "effort"`);
  return { tier, id, effort };
}

export function repoSlug(io = nodeIo()) {
  return machineryConfig(io).repo;
}

// ---------------------------------------------------------------------------
// Agent-definition frontmatter
// ---------------------------------------------------------------------------

/**
 * The settings block at the top of an agent definition, read as flat pairs.
 *
 * ONE COPY, BECAUSE TWO CONSUMERS NEED IT AND THEY LIVE IN DIFFERENT TREES.
 * `scripts/check-agent-models.mjs` holds a role's declared model and effort
 * equal to the pin; `review-proxy.mjs` reads the declared effort to say, in an
 * assessment's header, what the role actually runs at. Those are the two ends
 * of one fact, and a second copy of the reader is a second thing to drift --
 * the failure this whole area is about. The handbook-only checker can import
 * payload code; payload code cannot import the checker, so the shared copy
 * lives here. (Both assessors, #131 round 1.)
 *
 * DELIBERATELY NOT A YAML PARSER. The only shapes in these files are
 * `key: value` on one line, and this repository's archive names a hand-rolled
 * parser chasing a real language's syntax as a losing shape. What it must not
 * do is quietly accept a file it did not understand: a missing opening or
 * closing `---` returns null rather than an empty block, so a caller cannot
 * mistake "could not read it" for "it declares nothing".
 */
export function splitFrontmatter(text) {
  // `/\r?\n/`, NOT `"\n"`. A CRLF checkout leaves the closing delimiter as
  // `"---\r"`, which an exact `indexOf("---", 1)` never finds, so every
  // definition read as unreadable. Splitting on the pair fixes the delimiters
  // and the field lines in one token, and is byte-identical on LF.
  //
  // THE HALF-FIX IS WORSE THAN THE DEFECT, which is why this is the whole
  // change and not a trimmed delimiter comparison. Measured: with the close
  // found by trimming but the fields still carrying `\r`, `name`, `model` and
  // `effort` all read null -- and `check-agent-models` selects roles by
  // `name.startsWith("fable-")`, so the role would be SKIPPED rather than
  // reported. That turns a loud refusal into a check that passes having
  // checked nothing. (Astra, #131 round 2, naming the insufficiency; the
  // Fable assessor weighed the same finding as unreachable and said folding
  // in a one-token fix costs nothing. `plan-provenance.mjs` already splits
  // this way.)
  //
  // SCOPE IS THIS FUNCTION, DELIBERATELY. Four other readers still split on
  // `"\n"` -- `check-docs-accuracy.mjs`, `check-uat-format.mjs`,
  // `check-root-wiring.mjs` and `plan-review.mjs` -- and are left alone, so
  // this batch is not read as having fixed a class it did not. They are
  // outside this finding's consequence. If a CRLF environment ever enters the
  // fleet, the source-level answer is a `.gitattributes` pinning LF, which
  // makes every parser immune at once, rather than per-parser tolerance
  // spread by hand.
  const lines = String(text ?? "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  return { head: lines.slice(1, end), body: lines.slice(end + 1), endIndex: end };
}

/** `key: value` from a frontmatter block. Later wins, as YAML does. */
export function frontmatterValue(head, key) {
  let found = null;
  for (const line of head ?? []) {
    const m = new RegExp(`^${key}\\s*:\\s*(.*)$`).exec(line);
    if (m) found = m[1].trim().replace(/^["']|["']$/g, "");
  }
  return found;
}

/**
 * The family alias the Agent tool takes, from a full Claude model id.
 *
 * ONE COPY, BECAUSE THREE PLACES NEED THE SAME ANSWER. The dispatch passes it,
 * an assessment header names it, and the translator's mismatch line explains
 * it. A second derivation is a second thing to drift, and what drifts here is
 * the difference between "the platform substituted a model" and "your pin is
 * behind the alias" -- two diagnoses, one of which is a one-line edit David
 * owns. (Astra and the Fable assessor, #131 round 2, independently.)
 *
 * THE ALIAS IS ALL THE ARGUMENT CAN CARRY. The Agent tool's per-invocation
 * `model` parameter is an enum of `sonnet`, `opus`, `haiku`, `fable`; a full
 * id is refused at input validation (David's 2026-09-18 probe of `best`
 * returned exactly that value list, and this session's own tool schema
 * declares the same four). A full id IS accepted in a definition's
 * frontmatter -- which is why `model-routing` states the two layers
 * separately, and why one sentence there conflating them was corrected in
 * this same change.
 *
 * Null for anything that is not a Claude id, so a caller can say so rather
 * than print a guess.
 */
export function claudeAlias(id) {
  const m = typeof id === "string" ? /^claude-(fable|opus|sonnet|haiku)\b/.exec(id) : null;
  return m ? m[1] : null;
}

/**
 * One key from an agent definition, or null if anything at all is in the way.
 *
 * THE PATH IS THE SAME IN BOTH LAYOUTS. `.claude/agents/<name>.md` is a real
 * file in a consumer and a per-file symlink into `core/` in the handbook, so
 * one relative path resolves in both -- which is why this does not need the
 * `core/scripts` vs `scripts` dance `INVOCATION` does.
 *
 * NULL IS A REAL ANSWER AND CALLERS MUST TREAT IT AS ONE. A caller that
 * substituted a plausible default here would be inventing the very fact this
 * exists to report honestly.
 */
export function agentFrontmatter(root, name, key) {
  try {
    const parts = splitFrontmatter(fs.readFileSync(path.join(root, ".claude", "agents", `${name}.md`), "utf8"));
    return parts ? frontmatterValue(parts.head, key) : null;
  } catch {
    return null;
  }
}

/** Test seam: forget any parsed configuration. Never called in production. */
export function __resetRepoSlugCache() {
  CONFIG_CACHE.clear();
}

// ---------------------------------------------------------------------------
// The answer validator, shared by every dispatched role
// ---------------------------------------------------------------------------

/**
 * Validate a parsed value against the subset of JSON Schema these schemas use.
 *
 * Dependency-free on purpose: this repo installs nothing, and a validator that
 * needs `npm install` is a validator that does not run on a fresh container.
 * The subset is exactly what the role schemas express -- object, array,
 * string, number, boolean, required, additionalProperties:false, enum, items,
 * properties. A keyword outside it would silently pass, so
 * `assertSchemaSupported` refuses a schema this validator cannot actually
 * enforce rather than pretending.
 *
 * SHARED, BUT ONLY THE SHAPE. It locks how an answer is checked, never what
 * the answer may say: each role keeps its own schema and its own semantic
 * checks. Moving policy in here would make one edit change every role's
 * meaning at once.
 */
export function validate(value, schema, at = "$") {
  const problems = [];
  const say = (msg) => problems.push(`${at}: ${msg}`);

  if (schema.enum && !schema.enum.includes(value)) {
    say(`${JSON.stringify(value)} is not one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
    return problems;
  }

  // A UNION TYPE -- `"type": ["string", "null"]` -- means "any one of these".
  // `could_not_assess` has been declared that way since the role was written,
  // and until this was added the switch below fell through to "unsupported
  // type" on EVERY answer: the schema was never satisfiable, which nothing
  // noticed because no surviving caller validated against it. Recorded rather
  // than quietly fixed, because "a check nothing runs" is the class this
  // repository keeps paying for.
  if (Array.isArray(schema.type)) {
    const { type, ...rest } = schema;
    const attempts = type.map((t) => validate(value, { ...rest, type: t }, at));
    if (attempts.some((a) => a.length === 0)) return [];
    say(`matched none of the permitted types ${type.map((t) => JSON.stringify(t)).join(", ")}`);
    return problems;
  }

  switch (schema.type) {
    case "null":
      if (value !== null) say(`expected null, got ${describe(value)}`);
      return problems;
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        say(`expected an object, got ${describe(value)}`);
        return problems;
      }
      for (const key of schema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) say(`missing required key "${key}"`);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(schema.properties ?? {})[key]) say(`unexpected key "${key}"`);
        }
      }
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          problems.push(...validate(value[key], sub, `${at}.${key}`));
        }
      }
      return problems;
    }
    case "array": {
      if (!Array.isArray(value)) {
        say(`expected an array, got ${describe(value)}`);
        return problems;
      }
      if (schema.items) {
        value.forEach((item, i) => problems.push(...validate(item, schema.items, `${at}[${i}]`)));
      }
      return problems;
    }
    case "string":
      if (typeof value !== "string") {
        say(`expected a string, got ${describe(value)}`);
        return problems;
      }
      // THE KEYWORD IS `minTrimmedLength`, AND THE NAME IS THE FIX. It exists
      // in these schemas for exactly one reason: a field the model must
      // actually FILL. `minLength` cannot express that -- JSON Schema measures
      // the raw string, so "   " satisfies `minLength: 1` and every required
      // prose field in a schema could be whitespace while the answer validated
      // and rendered under a favourable headline. Measured on the
      // round-translation schema: every required field set to three spaces gave
      // `problems: []`. (#116, from #109 round 9.)
      //
      // Enforcing a trim UNDER THE NAME `minLength` was the other available
      // fix and is refused: `assertSchemaSupported` exists so that what the
      // schema publishes and what this validator enforces are the same thing,
      // and quietly redefining a published keyword is that guarantee failing in
      // the other direction. `minLength` is now refused outright, with a
      // message naming this keyword, so the next schema author cannot reach for
      // the fail-open one by accident.
      if (typeof schema.minTrimmedLength === "number" && value.trim().length < schema.minTrimmedLength) {
        say(
          `is ${value.trim().length} character(s) long once trimmed, and at least ${schema.minTrimmedLength} is required`,
        );
      }
      return problems;
    case "number":
    case "integer":
      if (typeof value !== "number") say(`expected a number, got ${describe(value)}`);
      return problems;
    case "boolean":
      if (typeof value !== "boolean") say(`expected a boolean, got ${describe(value)}`);
      return problems;
    default:
      say(`schema declares an unsupported type ${JSON.stringify(schema.type)}`);
      return problems;
  }
}

const describe = (v) => (v === null ? "null" : Array.isArray(v) ? "an array" : typeof v);

/** Keywords `validate` actually enforces. Anything else is a silent pass, so refuse it. */
const SUPPORTED_KEYWORDS = new Set([
  "type",
  "required",
  "additionalProperties",
  "properties",
  "items",
  "enum",
  "description",
  "minTrimmedLength",
]);

export function assertSchemaSupported(schema, at = "$") {
  for (const key of Object.keys(schema)) {
    // `minLength` gets its own message rather than the generic one, because the
    // author reaching for it wants a field that is really filled and would read
    // "this validator does not enforce it" as an invitation to add support --
    // rebuilding the fail-open. Name the replacement instead. (#116.)
    if (key === "minLength") {
      throw new Error(
        `${at} uses "minLength", which this repo's validator deliberately refuses. It measures the raw string, so ` +
          `"   " satisfies "minLength": 1 and a required prose field validates while carrying nothing. Use ` +
          `"minTrimmedLength", which measures the string with surrounding whitespace removed.`,
      );
    }
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new Error(
        `${at} uses the JSON Schema keyword "${key}", which this repo's dependency-free validator does not enforce. ` +
          `A keyword that is sent to the model but not checked here means an output could be accepted that does not ` +
          `satisfy the schema -- add support for it, or drop it.`,
      );
    }
  }
  for (const [key, sub] of Object.entries(schema.properties ?? {})) assertSchemaSupported(sub, `${at}.${key}`);
  if (schema.items) assertSchemaSupported(schema.items, `${at}[]`);
}

// ---------------------------------------------------------------------------
// The Codex CLI runner
// ---------------------------------------------------------------------------

/**
 * ONE COPY OF THE FLAGS, BECAUSE THE FLAGS ARE THE MECHANISM. This lived in
 * `plan-review.mjs` while it had one caller. `review-proxy.mjs` is the second,
 * and a duplicated `runCodex` is not two copies of some glue: it is two copies
 * of `--sandbox read-only` and `--ignore-user-config`, either of which can
 * drift in one file and leave that caller's reviewer able to write, or steered
 * by a stray user config. A reviewer that quietly stopped being read-only looks
 * exactly like one that is fine. So both callers import this, and
 * `plan-review.mjs` re-exports what its own suite already names.
 */
export const codexBin = () => process.env.CODEX_BIN || "codex";

/**
 * Is there a ChatGPT sign-in in this container?
 *
 * `codex login status` exits 1 and prints "Not logged in" when there is not
 * (measured, CLI 0.153.4). Both signals are read, because an exit code is a
 * thin thing to hang a refusal on and a future version could change either.
 * This function never touches $CODEX_HOME/auth.json — the bundle is David's
 * ChatGPT account credential, and nothing in this repo reads, prints or
 * copies it.
 */
export function signInStatus({ run = spawnSyncDefault } = {}) {
  let result;
  try {
    result = run(codexBin(), ["login", "status"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    return { signedIn: false, missingBinary: true, detail: err.message };
  }
  if (result.error) {
    return { signedIn: false, missingBinary: result.error.code === "ENOENT", detail: String(result.error.message) };
  }
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const signedIn = result.status === 0 && !/not logged in/i.test(text);
  return { signedIn, missingBinary: false, detail: text };
}

export const spawnSyncDefault = (...args) => spawnSync(...args);

export const SIGN_IN_INSTRUCTIONS = [
  "No ChatGPT sign-in in this container, so there is no reviewer to run.",
  "",
  "Sign-in is per session and is never stored (core/docs/ai-context/web-research.md). To get one:",
  "",
  "  1. npm install @openai/codex   (in a scratch directory; set CODEX_BIN to the binary)",
  "  2. $CODEX_BIN login --device-auth </dev/null   (a bare `codex` will not resolve)",
  "  3. Give David the URL and the code as a 🛑 blocking ask, with a push notification.",
  "     He approves it on his phone; David never runs a command.",
  "",
  "The token bundle stays in $CODEX_HOME for the life of this container. It is never written to the",
  "environment block, never sent through chat, and never handed over in a file.",
].join("\n");

/**
 * One `codex exec` run.
 *
 * Every flag here is load-bearing:
 *   -                        the prompt arrives on stdin. `codex exec` waits
 *                            forever on an open stdin in this harness, so the
 *                            stream is written and closed, never inherited.
 *   --output-last-message    writes that message to a file, so the result is
 *                            read from disk rather than scraped out of a
 *                            transcript that contains 45 tool calls.
 *   --sandbox read-only      the reviewer reads the repo and cannot change it.
 *                            (It also blocks /tmp — a reviewer that must run
 *                            the suite needs workspace-write on a scratch
 *                            checkout, or a TMPDIR inside the workspace.)
 *   --ignore-user-config     a stray ~/.codex/config.toml must not steer this
 *                            reviewer -- its model, its sandbox or its tools.
 *                            Auth still comes from CODEX_HOME.
 *   --ignore-rules           same reasoning for execpolicy .rules files.
 *   --ephemeral              no session file on disk; each round is a fresh
 *                            context by construction, not by convention.
 *
 * stdout and stderr are inherited so a long run shows progress where a human
 * or a log file can see it; the answer never comes from either stream.
 */
export function runCodex({ prompt, outFile, model, effort, sandbox, cwd, timeoutMs, run = spawnSyncDefault }) {
  const args = [
    "exec",
    "--model", model,
    "-c", `model_reasoning_effort="${effort}"`,
    "--sandbox", sandbox,
    "--cd", cwd,
    "--output-last-message", outFile,
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color", "never",
    "-",
  ];
  const started = Date.now();
  const result = run(codexBin(), args, {
    input: prompt,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
    timeout: timeoutMs,
    cwd,
  });
  return { args, status: result.status, signal: result.signal, error: result.error, seconds: (Date.now() - started) / 1000 };
}
