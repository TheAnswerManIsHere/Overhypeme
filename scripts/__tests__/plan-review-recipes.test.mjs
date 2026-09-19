/**
 * The skill's own recipe text, RUN.
 *
 * WHY THIS EXISTS. Three times in one pull request a documented recipe in
 * `plan-review-loop/SKILL.md` could not run at the moment it was meant to run:
 * the round-1 assess recipe refused on a missing ledger (#124 `4043982586`),
 * the pre-draft recipe demanded a plan that does not exist yet (`4043982594`),
 * and the correction for THAT one used `$S` eighty-eight lines before anything
 * assigns it (`4044552651`'s round, `4044735116`). Every one was caught by a
 * full Codex round plus two assessments plus a commit -- the most expensive
 * detector available -- and every one would have been caught by typing the
 * command. The script was thoroughly tested; the sentence telling an agent how
 * to reach the script was not tested at all.
 *
 * IT READS THE REAL FILE, for the reason `plan-provenance-producers.test.mjs`
 * gives for doing the same: "A test that transcribed their templates would be a
 * third statement of the format and would drift from both."
 *
 * WHAT IT DOES NOT COVER, and this list is load-bearing rather than modest --
 * a check advertised as "the recipes are verified" would earn back the overclaim
 * finding this same pull request already paid for:
 *
 *   1. THE DETACHED WRAPPER IS NOT RUN. `setsid nohup bash -c "..."`, the
 *      redirects, the `rm -f` of the marker and the exit file are stripped; only
 *      the `node` invocation inside survives.
 *   2. NO EXCHANGE IS SPAWNED. Every recipe that is not already `--prompt-only`
 *      gets `--dry-run` appended -- including the foreground scope exchange,
 *      which is otherwise a real ten-minute run. Both modes return before the
 *      sign-in check, so nothing here says an exchange would succeed; what is
 *      checked is that the invocation is accepted and composes its package.
 *   3. THE PLACEHOLDER VALUES ARE MINE, not an agent's. `<slug>`, `<N>`,
 *      `<tier>` and `<file>` are substituted from the table below. A recipe that
 *      only fails on some other value is not covered.
 *
 * BOTH PAYLOAD LAYOUTS ARE RUN, and until #124 round 8 only one was. The sync
 * routes `core/X -> X`, so the payload sits at `core/scripts/...` here and at
 * `scripts/...` in every consumer -- and the consumer layout is the one every
 * repository except this one actually runs. The fixture built only the
 * handbook's, so two consumer-only mechanisms were documented and never
 * executed: the `P=` line's `[ -f "$P" ] || P=scripts/plan-review.mjs` fallback
 * (`SKILL.md:23`), and `readVerbatim`'s consumer-first candidate, which tries
 * `docs/ai-context/...` before retrying under `core/`. `LAYOUTS` below runs
 * every recipe under both, which is what David asked for when he said the
 * check should cover the other repositories.
 *
 * WHAT THE FIXTURE SUPPLIES, and why the line is where it is. Only what the
 * skill tells an agent to create: the oracle (the scope-of-work gate says to
 * write it), the plan (the drafting step), the concern ledger (written after
 * every exchange), and the question file (the discussion recipe). Repository
 * configuration the checkout always has -- the contract, the Worth rule,
 * `.agents/machinery.json` -- is supplied too. It does NOT export `S` or `P`:
 * supplying those would conceal exactly the class this check exists for. The two
 * artifacts the SCRIPT produces rather than the agent -- an accepted assessment
 * and its plan snapshot -- are seeded for the discussion case, because a dry run
 * cannot produce them, and they are the one thing here staged rather than
 * earned.
 *
 * `bash --noprofile --norc -u` is what turns an unassigned variable into a
 * failure instead of an empty string, which is the mechanism of `4044735116`.
 *
 * IT CATCHES ALL THREE, which is why it is worth more than a fix. Measured by
 * reverting each one and watching this check go red, rather than by reasoning:
 *
 *   `$S` restored at :45      -> `bash: line 2: S: unbound variable`
 *   the assess form at :45    -> `--plan docs/plans/PLAN_RECIPES.md does not exist`
 *   the ledger not written    -> `no concern ledger at .agents/reviews/recipes/
 *                                concerns.json, and exchange(s) 0 already ran`
 *
 * THE LAYOUT SPLIT IS MEASURED THE SAME WAY, once per consumer-only mechanism,
 * and the discriminating result is that the handbook half stays green -- a
 * check that went all-red would not have told us which half it was exercising:
 *
 *   `readVerbatim`'s consumer candidate removed  -> 5 consumer cases fail,
 *                                                   5 handbook cases pass
 *   the `P=` fallback removed from SKILL.md:23   -> 5 consumer cases fail,
 *                                                   5 handbook cases pass
 *
 * The third is reached by changing the fixture rather than the document, which
 * is the honest shape of that one: the staging is authored here, so it holds
 * only while someone keeps it in step with the instructions.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
// `../..` is `core/` in the handbook and the repository root in a consumer, so
// one relative path reaches the skill in both payload layouts.
const PAYLOAD = resolve(HERE, "..", "..");
const SKILL = join(PAYLOAD, ".claude/skills/plan-review-loop/SKILL.md");
const SCRIPT = join(PAYLOAD, "scripts/plan-review.mjs");

const SLUG = "recipes";
const PLAN_PATH = `docs/plans/PLAN_${SLUG.toUpperCase()}.md`;

/** The angle-bracket placeholders an agent fills in, and what this check fills them with. */
const PLACEHOLDERS = [
  [/<product\|sensitive\|internal>/g, "internal"],
  [/PLAN_<SLUG>\.md/g, `PLAN_${SLUG.toUpperCase()}.md`],
  [/<slug>/g, SLUG],
  [/<tier>/g, "internal"],
  [/<file>/g, PLAN_PATH],
  [/<N>/g, "1"],
  [/<M>/g, "1"],
];

/**
 * Every fenced block, with the line its fence opened on and the prose leading
 * into it.
 *
 * THE LEAD IS WHAT DECIDES THE STAGE, and it has to be the document's words
 * rather than the recipe's flags. Keying the fixture off `--kind` was the first
 * shape of this check and it was circular: restoring the pre-draft recipe's old
 * `--kind assess --plan <file>` form made the fixture supply a plan, so the
 * broken recipe re-staged the world to suit itself and the check passed. A
 * recipe must not get to choose the conditions it is tested under.
 */
function fencedBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let open = null;
  let heading = "";
  lines.forEach((line, i) => {
    if (open) {
      if (/^```\s*$/.test(line)) {
        blocks.push({ line: open.line, body: open.body.join("\n"), lead: open.lead, heading: open.heading });
        open = null;
      } else open.body.push(line);
      return;
    }
    if (/^#{2,}\s/.test(line)) heading = line;
    if (/^```/.test(line)) {
      open = { line: i + 1, body: [], heading, lead: lines.slice(Math.max(0, i - 8), i).join("\n") };
    }
  });
  return blocks;
}

/** Pre-plan or post-plan, read off the document rather than off the command. */
const stageOf = (block) =>
  /before drafting|before the plan is written|scope-of-work gate/i.test(`${block.heading}\n${block.lead}`)
    ? "pre-plan"
    : "post-plan";

/**
 * A detached block, reduced to the invocation it wraps.
 *
 * Deliberately narrow: this rewrites a shape this repository authors, not shell
 * in general. If it ever stops matching, the assertions below fail loudly rather
 * than quietly checking nothing -- which is the failure mode a check like this
 * must not have.
 *
 * THAT IS NOT A HOPE, IT IS MEASURED. Quoting `$PWD` in the two launch blocks
 * (#124 round 5) stopped this matching, and the shape test below failed on the
 * recipe count rather than the file quietly checking three recipes instead of
 * five. Keep `LAUNCH` in step with the document; the guard is what tells you.
 */
const LAUNCH = `setsid nohup bash -c 'cd "$1" && `;

function undetach(body) {
  const start = body.indexOf(LAUNCH);
  if (start === -1) return body;
  const head = body.slice(0, start);
  let cmd = body.slice(start + LAUNCH.length);
  cmd = cmd.slice(0, cmd.indexOf('> "$3/'));
  // The positional shape (#124 round 12): the program text is single-quoted and
  // the outer shell's values arrive as `$1`/`$2`/`$3`/`$4`. Running it here
  // without the wrapper means substituting them back -- `$1` is the checkout,
  // which is the fixture root the recipe already runs in, so `node "$1/$2"`
  // becomes `node "$P"`.
  return `${head}${cmd.replace(/"\$1\/\$2"/g, '"$P"').replace(/"\$4"/g, '"$Q"')}`;
}

/**
 * `--dry-run` on anything that is not already `--prompt-only`.
 *
 * Both modes return before the sign-in check, so nothing here can reach Codex.
 * This is not only for the detached recipes: the foreground scope exchange at
 * the scope-exchange recipe is a real invocation, and without this the check
 * would try to start a ten-minute `xhigh` run -- or, in CI, fail on a missing
 * `codex` binary, which is a failure about the environment rather than about
 * the recipe.
 */
const neverSpawns = (cmd) => (/--prompt-only|--dry-run/.test(cmd) ? cmd : `${cmd} --dry-run`);

/**
 * The repository as it stands AT THE MOMENT a given recipe runs.
 *
 * STAGING IS THE POINT, not tidiness. A fixture that always holds a plan would
 * pass the pre-draft recipe's OLD form -- the one that demanded a plan before
 * drafting (#124 `4043982594`) -- and so would check instance three of the class
 * while being blind to instance two. `--kind scope` runs before the plan is
 * written, so at that stage there is no plan; an assessment runs after the scope
 * exchange, so at that stage `round-0.md` exists and makes the ledger required,
 * which is the condition instance one hit.
 *
 * THE LIMIT, stated rather than left to be discovered: this staging is authored
 * here, from the document's sequence, so it tracks the instructions only as far
 * as someone keeps it in step. If the skill stopped telling an agent to write
 * the ledger, this fixture would keep supplying one and the check would keep
 * passing.
 */
const LAYOUTS = [
  { name: "handbook", prefix: "core" },
  { name: "consumer", prefix: "" },
];

function fixture({ stage, layout }) {
  const root = mkdtempSync(join(tmpdir(), "recipes-"));
  // `core/` in the handbook, nothing in a consumer -- the one difference the
  // sync makes, and the whole point of running every recipe twice.
  const at = (rel) => join(root, layout.prefix, rel);
  mkdirSync(join(root, layout.prefix || "."), { recursive: true });
  // The script, reachable at the path the recipe's own `P=` line looks for.
  //
  // COPIED, NEVER SYMLINKED, and this is not a detail. `node` sets
  // `process.argv[1]` to the path it was given while `import.meta.url` resolves
  // through the symlink to the real file, so the entry-point guard
  // (`import.meta.url === pathToFileURL(process.argv[1]).href`) is false and the
  // script runs NOTHING and exits 0. The first version of this check symlinked,
  // and all six of its cases passed against a script that never executed -- the
  // exact "reports success having evaluated nothing" failure CLAUDE.md records
  // three instances of (#11, #16, #59). `machinery.mjs` imports only node
  // builtins, so copying the pair is enough.
  mkdirSync(at("scripts"), { recursive: true });
  copyFileSync(SCRIPT, at("scripts/plan-review.mjs"));
  copyFileSync(join(PAYLOAD, "scripts/machinery.mjs"), at("scripts/machinery.mjs"));

  mkdirSync(at("docs/ai-context"), { recursive: true });
  writeFileSync(at("docs/ai-context/planning-contract.md"), "# The planning contract\n\nRole-neutral body.\n");
  writeFileSync(at("docs/ai-context/review-judgment.md"), "# The Worth rule\n\nIs this intervention worthwhile?\n");

  // Repository configuration, in the same class as the contract files above:
  // the checkout has it before any planning happens, and the skill never tells
  // an agent to create it.
  mkdirSync(join(root, ".agents"), { recursive: true });
  writeFileSync(
    join(root, ".agents/machinery.json"),
    `${JSON.stringify(
      { repo: "owner/fixture", models: { strongestClaude: { id: "claude-fable-5-1", effort: "xhigh" }, strongestCodex: { id: "gpt-6-astra", effort: "xhigh" } } },
      null,
      2,
    )}\n`,
  );

  // Only what the skill tells an agent to write.
  const dir = join(root, ".agents/reviews", SLUG);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `oracle-${SLUG}.md`), "Direction: keep the recipes runnable.\n\nProduct intent: they run.\n");
  writeFileSync(join(dir, `question-1-1.txt`), "Does the evidence change your view?\n");
  if (stage !== "pre-plan") writeFileSync(
    join(dir, "concerns.json"),
    JSON.stringify(
      ["C2", "C5"].map((id) => ({
        id,
        title: `A concern called ${id}`,
        state: "open",
        raised_by: "astra",
        source: "round-0.md",
        concern: `${id}'s reasoning, as it was written.`,
        response: "",
      })),
      null,
      2,
    ),
  );
  if (stage !== "pre-plan") {
    // The scope exchange has happened, so its assessment is on disk and the
    // ledger it produced is what the next exchange needs.
    writeFileSync(join(dir, "round-0.md"), "# Scope assessment\n\nThe boundary looks right.\n");
    mkdirSync(join(root, "docs/plans"), { recursive: true });
    writeFileSync(join(root, PLAN_PATH), "# The plan\n\n```plan-oracle\nDirection: keep the recipes runnable.\n```\n\nDo the thing.\n");
  }
  return { root, dir };
}

/** Run one recipe the way an agent would: a fresh `bash -u`, nothing exported. */
function runRecipe(root, script) {
  // --noprofile --norc because /etc/bash.bashrc trips `-u` on PS1 on this
  // image, and a check whose output is full of the machine's noise is a check
  // nobody reads carefully.
  return spawnSync("bash", ["--noprofile", "--norc", "-u", "-c", script], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PLAN_REVIEW_ROOT: root },
  });
}

const text = readFileSync(SKILL, "utf8");
const blocks = fencedBlocks(text);
const setup = blocks.find((b) => /^P=/.test(b.body.trim()));
// Two shapes: the foreground blocks invoke `node "$P"`, and the detached ones
// `node "$1/$2"` since #124 round 12 put the checkout and script paths in
// positional arguments. The shape test below is what catches this drifting,
// and did twice -- on round 5's quoting change and again on round 12's, where
// the count went 5 -> 3 the moment `$P` left the `node` call.
const recipes = blocks.filter((b) => /node\s+"\$(P"|1\/\$2")/.test(b.body));

test("the document still has the shape this check assumes", () => {
  // WITHOUT THIS THE WHOLE FILE CAN PASS VACUOUSLY. If the `P=` line moves or a
  // recipe stops matching, every assertion below would run against an empty set
  // and report success having checked nothing.
  assert.ok(setup, "the session-level `P=` assignment is still the first fenced block");
  assert.equal(recipes.length, 5, "five recipes invoke the script; add the new one to this check deliberately");
  for (const kind of ["scope", "assess", "discuss"]) {
    assert.ok(recipes.some((r) => r.body.includes(`--kind ${kind}`)), `a ${kind} recipe is still documented`);
  }
  // Both stages must be populated, or the staging is decorative and the check is
  // only ever exercising one set of conditions.
  for (const stage of ["pre-plan", "post-plan"]) {
    assert.ok(recipes.some((r) => stageOf(r) === stage), `at least one recipe runs at the ${stage} stage`);
  }
});

for (const layout of LAYOUTS)
for (const recipe of recipes) {
  const label = `${recipe.body.match(/--kind (\w+)/)?.[1] ?? "?"}${recipe.body.includes("--role claude") ? ", my own copy" : ""}${recipe.body.includes("setsid") ? ", detached" : ""}`;

  test(`SKILL.md:${recipe.line} — the ${label} recipe runs as written, ${layout.name} layout`, () => {
    const { root, dir } = fixture({ stage: stageOf(recipe), layout });
    // An accepted assessment and its snapshot: script outputs, not authored
    // content, and a dry run cannot produce them.
    if (recipe.body.includes("--kind discuss")) {
      writeFileSync(join(dir, "round-1.md"), "# Assessment 1\n\nSomething substantive.\n");
      writeFileSync(join(dir, "plan-round-1.md"), readFileSync(join(root, PLAN_PATH), "utf8"));
    }
    let body = neverSpawns(undetach(recipe.body));
    for (const [pattern, value] of PLACEHOLDERS) body = body.replace(pattern, value);
    const script = `${setup.body}\n${body}`;

    // The transform must not have eaten the invocation.
    assert.match(script, /--kind (scope|assess|discuss)/, "the reduced recipe still invokes the script");
    assert.doesNotMatch(script, /setsid|nohup/, "the detached wrapper was stripped, not left to run");

    const out = runRecipe(root, script);
    rmSync(root, { recursive: true, force: true });
    const shown = `--- what was run ---\n${script}\n--- stderr ---\n${out.stderr}\n--- stdout ---\n${out.stdout.slice(0, 600)}`;
    assert.equal(out.status, 0, `the recipe at SKILL.md:${recipe.line} does not run as written.\n${shown}`);

    // EXIT 0 IS NOT EVIDENCE THE SCRIPT RAN. A script whose entry-point guard is
    // false does nothing and exits 0, which is how the first version of this
    // check passed six cases against a script that never executed. So every case
    // must produce the output its mode is defined to produce.
    const evidence = script.includes("--prompt-only") ? /# The contract you both apply/ : /dry run — nothing spawned/;
    assert.match(
      `${out.stdout}${out.stderr}`,
      evidence,
      `the recipe at SKILL.md:${recipe.line} exited 0 without producing its package — the script did not run.\n${shown}`,
    );
  });
}
