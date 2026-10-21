#!/usr/bin/env node
// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
/**
 * The build report: one independent, plain-English account per unit of work
 * (David, 2026-10-21, replacing the per-round translation of #36).
 *
 * WHAT IT IS. At the close of a unit of work -- a pull request's merge, or a
 * prototype version delivered on its own branch -- the Fable role
 * `fable-build-report` reads the whole unit from GitHub itself (the workstream
 * issue, every pull request and its review rounds, the commits) and writes an
 * answer in fixed sections, in a fixed order, so David can scan it: what was
 * built, the decisions taken on the builder's recommendation with their undo,
 * the ramifications, what ships unfixed, the spend, and where the plan stands.
 *
 * WHAT SURVIVES FROM THE TRANSLATION, AND WHY IT IS MACHINERY. One property:
 * the role's account reaches David unedited. `chatReport` composes the message
 * from the validated answer's own fields, and the builder pastes it, in chat
 * and as a comment on the workstream issue. The only words in it that are not
 * the role's are the labels and the session line, which is printed under its
 * own label because only the builder's session can see its own context.
 *
 * THE BRIEF TRAVELS IN THE DISPATCH, NEVER AS A FILE. The role holds no tool
 * that can open a file -- measured on #222's interim account, which was
 * dispatched with a path to its brief, could not read it, and rebuilt its
 * coordinates from the pull request. So `brief` prints the whole brief,
 * schema included, and the dispatch prompt IS that text.
 *
 * NO STATE SURVIVES A SESSION, AND NONE IS NEEDED. Every coordinate is either
 * pinned by the caller (the issue, the pull requests or the branch and its
 * head) or derivable from GitHub. The answer path is derived from the unit's
 * name, never supplied.
 *
 * "AGREES" IS NEVER PRINTED OVER AN UNASSESSED ITEM. The one rule the verdict
 * line carries over from the translation: could-not-observe is not the
 * favourable answer, and every place the report asserts a fact reads the same
 * fact (`facts`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { claudeAlias, modelTier, validate, assertSchemaSupported, repoSlug } from "./machinery.mjs";

export const REVIEWS_DIR = ".agents/reviews";
export const ROLE = "fable-build-report";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const schemaPath = () =>
  path.resolve(SCRIPT_DIR, "..", ".agents", "roles", "schemas", `${ROLE}.schema.json`);
const loadSchema = () => JSON.parse(fs.readFileSync(schemaPath(), "utf8"));

const UNIT = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The unit's name, which names the answer file. A choice of the caller's, so
 * it gets a cheap well-formedness check: an unchecked one is interpolated into
 * a path, and a typo there is a valid answer written where `readAnswer` never
 * looks -- a success reported as a failure.
 */
function assertUnit(unit) {
  if (typeof unit !== "string" || !UNIT.test(unit)) {
    throw new Error(
      `build-report: unit must be a short lowercase slug (letters, digits, hyphens), got ${JSON.stringify(unit)}. ` +
        `It names the answer file, so a malformed one would send a valid answer where the read never looks.`,
    );
  }
}

function assertPositiveInt(name, value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`build-report: ${name} must be a positive integer, got ${JSON.stringify(value)}.`);
  }
}

/** Where the role writes its answer. Derived, never supplied. */
export const answerPath = (root, unit) => {
  assertUnit(unit);
  return path.join(root, REVIEWS_DIR, `build-${unit}.answer.json`);
};

/**
 * Where `brief` records the unit's coordinates for `report` to read, so the
 * posted report names the evidence it covered from the values the brief
 * carried rather than from a second typing (#224 round 1: a branch unit's
 * range ends must survive into the issue comment, where the next version's
 * dispatch reads its lower bound).
 */
export const unitPath = (root, unit) => {
  assertUnit(unit);
  return path.join(root, REVIEWS_DIR, `build-${unit}.unit.json`);
};

/**
 * Keep the answer directory ignored: an answer file is a session artifact and
 * must never be committed. `review-proxy.mjs` writes its packages here too.
 */
export function ensureReviewsIgnored(root) {
  const dir = path.join(root, REVIEWS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  return ignore;
}

/**
 * Prepare the answer path for ONE attempt, before every dispatch: the
 * directory exists (the role holds `Write` and nothing that creates a parent),
 * it is ignored, and no earlier attempt's answer is left where `readAnswer`
 * will look -- a re-dispatch that wrote nothing must read as a failure, never
 * as its predecessor's answer. Validates before any side effect.
 */
export function prepareAnswerPath(root, unit) {
  const file = answerPath(root, unit);
  ensureReviewsIgnored(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  fs.rmSync(unitPath(root, unit), { force: true });
  return file;
}

/**
 * The dispatch model: the full id `chatReport` compares the role's reported
 * model against, and the alias the Agent tool takes. Bound once per dispatch.
 * Effort's only route is the role definition's frontmatter, held equal to the
 * pin by `scripts/check-agent-models.mjs`.
 */
export function dispatchModel(io = undefined) {
  const entry = modelTier("strongestClaude", io);
  const id = typeof entry === "string" ? entry : entry?.id;
  const effort = typeof entry === "object" ? (entry?.effort ?? null) : null;
  const alias = claudeAlias(id);
  if (!alias) {
    throw new Error(
      `.agents/machinery.json's models.strongestClaude.id is ${JSON.stringify(id)}, which is not a Claude model, ` +
        `so it cannot be dispatched as a subagent. The Agent tool takes one of fable, opus, sonnet, haiku.`,
    );
  }
  return { id, agentModel: alias, effort, effortRoute: "definition" };
}

/**
 * The whole brief, as the dispatch prompt. The role definition carries how to
 * read and what to write; this carries where to look and the schema.
 *
 * A UNIT IS AN ISSUE PLUS ITS EVIDENCE. The workstream issue is required: it
 * holds the plan or agreed scope, the State of Play, the decisions line and
 * the spend line, and a report without it cannot say where the plan stands.
 * The evidence is one or more pull requests, or a prototype branch with the
 * head the evidence stops at -- the branch regime opens no pull request, and
 * the translation this replaced could not report on one for exactly that
 * reason (Codex, #222 round 1).
 */
export function buildBrief({ root, unit, issue, prs = [], branch = null, privatePath = false, io = undefined, now = () => new Date() }) {
  assertUnit(unit);
  if (issue === undefined || issue === null || Number.isNaN(issue)) {
    // A WORKSTREAM WITH NO PUBLIC ISSUE IS A REAL CASE, NOT A TYPO: one that
    // is sensitive from the start lives on a private draft Project item the
    // role cannot read (workstream-tracking.md, *Sensitive /
    // disclosure-carve-out workstreams*). Its report has no route yet, so the
    // refusal says so and names the fallback (#224 round 1, recorded gap).
    throw new Error(
      "build-report: no workstream issue was given. A workstream with no public issue (one on the private path " +
        "from the start) has no build report yet: write the unit up yourself, labelled as your own account, in " +
        "chat only. If this workstream does have an issue, pass --issue <n>.",
    );
  }
  assertPositiveInt("issue", issue);
  if (!Array.isArray(prs)) throw new Error("build-report: prs must be an array of pull request numbers.");
  for (const n of prs) assertPositiveInt("each pull request number", n);
  if (branch !== null) {
    const ok = (v) => typeof v === "string" && v.trim() !== "";
    if (!branch || !ok(branch.name) || !ok(branch.head) || !ok(branch.since)) {
      // BOTH ENDS OF THE RANGE ARE PINNED. The head is where the evidence
      // stops; `since` is where it starts -- the previous version's head, or
      // the branch's base for the first version. Neither is derivable by the
      // role (it holds no compare, and `list_commits` on the branch walks back
      // through all of main's history), and an absent one asks for an
      // unbounded range: the next version re-reported as new work, under an
      // "agrees" headline (#224 round 1).
      throw new Error(
        "build-report: branch must be { name, since, head }, all non-empty -- `since` is the previous version's " +
          "head (or the branch's base for the first version) and `head` is where the evidence stops. An absent end " +
          "asks for an unbounded range.",
      );
    }
  }
  if (prs.length === 0 && branch === null) {
    throw new Error(
      "build-report: a unit needs its evidence -- at least one pull request, or a branch with its head. " +
        "A report built from the issue alone would describe the builder's account of the work, not the work.",
    );
  }
  const repo = repoSlug(io);
  const file = answerPath(root, unit);
  // THE COORDINATES ARE RECORDED HERE, where they are validated, for `report`
  // to print. Written beside the answer, in the ignored directory.
  ensureReviewsIgnored(root);
  fs.writeFileSync(unitPath(root, unit), JSON.stringify({ issue, prs, branch, private: privatePath === true }) + "\n");
  const until = now().toISOString();
  const schema = loadSchema();
  const lines = [
    "Read your role definition's instructions and follow them. This message is your whole brief: you hold no tool that can open a file, so nothing here points at one.",
    "",
    "## This unit of work",
    "",
    `- **Repository:** \`${repo}\``,
    `- **Workstream issue:** #${issue} — the plan or agreed scope, the State of Play, the decisions taken on recommendation and the \`Spend so far\` line live here.`,
  ];
  if (prs.length) {
    lines.push(`- **Pull requests:** ${prs.map((n) => `#${n}`).join(", ")} — read each one whole: body, reviews, threads, comments, commits and the cumulative change.`);
  }
  if (branch) {
    lines.push(
      `- **Prototype branch:** \`${branch.name}\`, evidence from after \`${branch.since}\` through \`${branch.head}\` — it opens no pull request, so read its commits (\`list_commits\` on that branch from the head back to \`${branch.since}\`, exclusive) and the full patch of each. \`main\` is merged into the branch from time to time; commits that arrived by such a merge are not this version's work.`,
    );
  }
  lines.push(
    `- **Until:** ${until} — activity after this moment belongs to a later report.`,
    "- **Paid-run ledger:** the repository's open issue labelled `paid-ai-ledger`, one comment per paid AI run. Total the comments from the seven days before **Until**. If there is no such issue, `paid_runs_this_week` is null.",
    "",
    "## Your answer",
    "",
    `Write it to \`${file}\` as a single JSON object satisfying this schema, and nothing else in that file:`,
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  );
  return lines.join("\n");
}

/**
 * Check an answer against the schema. Returns the problems rather than
 * throwing: the report is off the critical path and a broken one must never
 * stop a loop.
 */
export function validateAnswer(answer) {
  const schema = loadSchema();
  assertSchemaSupported(schema, ROLE);
  const problems = validate(answer, schema, ROLE);
  if (answer && typeof answer.could_not_assess === "string" && answer.could_not_assess.trim() === "") {
    problems.push(`${ROLE}: "could_not_assess" is blank -- null means fully assessed and a sentence means not; whitespace is neither`);
  }
  return problems;
}

/**
 * Read what the role wrote, in the shape `chatReport` consumes. No file, an
 * unparseable file and a schema-invalid answer are all one shape: a FAILED
 * report, visibly a failure, never the favourable "nothing to report".
 */
export function readAnswer(root, unit) {
  const file = answerPath(root, unit);
  const failed = (reason) => ({ unit, failed: true, reason });
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    return failed(`the role wrote no answer file (${err.code === "ENOENT" ? "not found" : err.code})`);
  }
  let answer;
  try {
    answer = JSON.parse(raw);
  } catch (err) {
    return failed(`the answer file is not valid JSON: ${err.message}`);
  }
  const problems = validateAnswer(answer);
  if (problems.length) return failed(`the answer did not match the expected shape: ${problems.join("; ")}`);
  return { unit, answer };
}

/**
 * The coordinates `brief` recorded for this unit, or null when it recorded
 * none -- a report read without its brief is still printed, and says so.
 */
export function readUnit(root, unit) {
  try {
    return JSON.parse(fs.readFileSync(unitPath(root, unit), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The evidence line, from the brief's own coordinates. For a branch unit it
 * names both ends of the range, which is what the next version's dispatch
 * reads its `since` from.
 */
export function evidenceLine(coords) {
  if (!coords) return "*Evidence:* *not recorded — this report was read without its brief's coordinates.*";
  const parts = [`workstream #${coords.issue}`];
  if (Array.isArray(coords.prs) && coords.prs.length) parts.push(`PRs ${coords.prs.map((n) => `#${n}`).join(", ")}`);
  if (coords.branch) parts.push(`branch \`${coords.branch.name}\` from after \`${coords.branch.since}\` through \`${coords.branch.head}\``);
  return `*Evidence:* ${parts.join(" · ")}`;
}

/** The facts the verdict, the headings and the empty labels all read. */
export function facts(report) {
  if (report.failed) return { failed: true, reason: report.reason ?? "the report could not be produced" };
  const a = report.answer ?? {};
  const len = (k) => (Array.isArray(a[k]) ? a[k].length : 0);
  return {
    failed: false,
    disagreements: len("disagreements"),
    unassessed: typeof a.could_not_assess === "string",
    notReasonable: (Array.isArray(a.shipping_unfixed) ? a.shipping_unfixed : []).filter((g) => g && g.reasonable !== true).length,
    concerns: (Array.isArray(a.decisions) ? a.decisions : []).filter((d) => d && typeof d.concern === "string").length,
    overbuilt: len("overbuilt"),
  };
}

const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * The verdict line. "Agrees" is last and only reachable when nothing differs,
 * nothing shipping unfixed is called unreasonable, no decision drew a concern
 * and everything reachable was assessed.
 */
export function chatLine(report) {
  const f = facts(report);
  const u = report.unit;
  if (f.failed) return `${u}: report failed — ${f.reason}`;
  const flags = [];
  if (f.disagreements) flags.push(`differs on ${plural(f.disagreements, "point")}`);
  if (f.notReasonable) flags.push(`${f.notReasonable} not reasonable to ship`);
  if (f.concerns) flags.push(`${plural(f.concerns, "decision")} questioned`);
  if (f.overbuilt) flags.push(`${f.overbuilt} overbuilt`);
  if (f.unassessed) flags.push("partial — something could not be assessed");
  return flags.length ? `${u}: ${flags.join("; ")}` : `${u}: agrees with the builder's account`;
}

const SESSION_VERDICTS = ["continue", "hand off"];

/**
 * THE DELIVERABLE: what the builder pastes, in chat and on the issue, and the
 * only thing it says about the unit. Fixed sections in a fixed order (David,
 * 2026-10-21). Every word is the role's except the labels and `session`, the
 * builder's own call, printed under a label saying so.
 */
export function chatReport(report, { askedModel = null, session = null, coords = undefined } = {}) {
  const f = facts(report);
  const out = [`**Build report — ${chatLine(report)}**`, ""];
  // A PRIVATE-PATH UNIT IS DELIVERED IN CHAT ONLY. The role writes a plain
  // account of the diff, and on a workstream whose plan took the private path
  // that is the content the canonical disclosure check keeps off GitHub
  // wherever it appears (workstream-tracking.md). So the report says so at its
  // top, where the builder pasting it cannot miss it (#224 round 1).
  if (coords && coords.private === true) {
    out.push("*Private-path workstream: deliver this report in chat only, never as an issue comment.*", "");
  }
  if (f.failed) {
    out.push(
      `No independent account of this unit exists. The role was dispatched and produced nothing usable — ${f.reason}. This is a failure of the report, not a sign that the work was quiet.`,
    );
    return out.join("\n");
  }
  const a = report.answer;
  out.push(`*${a.about}*`, "");
  if (coords !== undefined) out.push(evidenceLine(coords), "");
  out.push(`**Needs you:** ${a.needs_you}`, "", "**What was built**", "", a.what_was_built);

  out.push("", "**Decisions taken on my recommendation**", "");
  if (a.decisions.length) {
    for (const d of a.decisions) out.push(`- **${d.choice}** — undo: ${d.undo}${d.concern ? ` · *Concern:* ${d.concern}` : ""}`);
  } else out.push("*None recorded.*");

  out.push("", "**Ramifications**", "", a.ramifications);

  out.push("", "**Shipping unfixed**", "");
  if (a.shipping_unfixed.length) {
    for (const g of a.shipping_unfixed) out.push(`- ${g.reasonable ? "Reasonable" : "**Not reasonable**"}: ${g.what} — ${g.why}`);
  } else out.push(f.unassessed ? "*Nothing reported, on what could be assessed.*" : "*Nothing reported.*");

  out.push("", `**Where it disagrees with the builder** (${f.disagreements})`, "");
  if (a.disagreements.length) {
    for (const d of a.disagreements) out.push(`- **${d.what}** — ${d.why_it_matters}`);
  } else out.push(f.unassessed ? "*No disagreements reported, on what could be assessed.*" : "*No disagreements reported.*");

  if (a.overbuilt.length) {
    out.push("", "**Overbuilt**", "");
    for (const o of a.overbuilt) out.push(`- ${o}`);
  }

  out.push(
    "",
    "**Spend**",
    "",
    `- This build: ${a.spend.build_total ?? "*no Spend so far line on the issue*"}`,
    `- Paid AI runs, last seven days: ${a.spend.paid_runs_this_week ?? "*no paid-run ledger in this repository*"}`,
  );

  out.push(
    "",
    "**Where we are**",
    "",
    `- *Planned:* ${a.where_we_are.planned}`,
    `- *Done:* ${a.where_we_are.done}`,
    `- *Next:* ${a.where_we_are.next}`,
  );

  out.push("", `*Does not do:* ${a.what_landed.does_not_do}`, "", `*You are now trusting:* ${a.what_landed.now_trusting}`);

  // THE SESSION LINE IS THE BUILDER'S, AND SAYS SO. Only the builder's session
  // can see its own context, so the role cannot judge continue-or-hand-off;
  // printing the builder's call under the role's voice would be the builder's
  // words reaching David as the independent account.
  if (session && SESSION_VERDICTS.includes(session.verdict)) {
    out.push("", `**Session** (the builder's call): ${session.verdict}${session.why ? ` — ${session.why}` : ""}`);
  } else {
    out.push("", "**Session** (the builder's call): *not stated.*");
  }

  if (f.unassessed) out.push("", `*Could not assess:* ${a.could_not_assess}`);

  const got = a.model ?? null;
  const alias = askedModel ? claudeAlias(askedModel) : null;
  if (!got) out.push("", `*This report did not say which model wrote it${askedModel ? `; this repository pins ${askedModel}` : ""}.*`);
  else if (askedModel && got.trim() !== askedModel.trim()) {
    const sameFamily = alias !== null && claudeAlias(got) === alias;
    const why = !alias
      ? ""
      : sameFamily
        ? ` The dispatch sends the family alias \`${alias}\`, not a version, so one likely explanation is that the pin and the version that alias resolves to have drifted apart.`
        : ` The alias \`${alias}\` cannot resolve to ${got}, so a different model answered. The one cause on record is a content refusal, which falls Claude back to Opus.`;
    out.push("", `*Written by ${got}; this repository pins ${askedModel}.${why} The dispatch cannot enforce the model, only report what answered.*`);
  }
  return out.join("\n");
}

/**
 * The command line.
 *
 *   node build-report.mjs brief  --unit <slug> --issue <n> [--pr <n> ...] [--branch <name> --since <sha> --head <sha>] [--private yes]
 *   node build-report.mjs prepare --unit <slug>
 *   node build-report.mjs report --unit <slug> [--session continue|"hand off"] [--session-why <text>]
 *
 * `brief` prints the dispatch prompt (it also prepares the answer path, so the
 * two cannot be done out of order); `report` prints what is pasted.
 */
export function main({ argv = process.argv.slice(2), root = process.cwd(), io = undefined, stdout = process.stdout } = {}) {
  const [cmd, ...rest] = argv;
  const opts = { pr: [] };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    const v = rest[i + 1];
    if (!k.startsWith("--") || v === undefined) throw new Error(`build-report: expected --flag value pairs, got ${JSON.stringify(rest.slice(i))}`);
    const name = k.slice(2);
    if (name === "pr") opts.pr.push(Number(v));
    else opts[name] = v;
    i++;
  }
  if (cmd === "brief") {
    prepareAnswerPath(root, opts.unit);
    const branch = opts.branch ? { name: opts.branch, since: opts.since, head: opts.head } : null;
    const issue = opts.issue === undefined ? undefined : Number(opts.issue);
    stdout.write(buildBrief({ root, unit: opts.unit, issue, prs: opts.pr, branch, privatePath: opts.private === "yes", io }) + "\n");
    return 0;
  }
  if (cmd === "prepare") {
    stdout.write(prepareAnswerPath(root, opts.unit) + "\n");
    return 0;
  }
  if (cmd === "report") {
    const session = opts.session ? { verdict: opts.session, why: opts["session-why"] ?? null } : null;
    stdout.write(chatReport(readAnswer(root, opts.unit), { askedModel: dispatchModel(io).id, session, coords: readUnit(root, opts.unit) }) + "\n");
    return 0;
  }
  throw new Error(`build-report: unknown command ${JSON.stringify(cmd)}; expected brief, prepare or report.`);
}

// `pathToFileURL`, never a hand-built `file://` string: the two differ whenever
// the checkout path needs escaping, and a script that never runs exits 0.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}
