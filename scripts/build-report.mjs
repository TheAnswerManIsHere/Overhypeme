#!/usr/bin/env node
// SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead.
/**
 * The build report: one independent, plain-English account of a unit of work,
 * ON DEMAND ONLY (David, 2026-11-25: it runs when he types `/buildreport`, never
 * at close-out; it replaced, on 2026-10-21, the per-round translation of #36).
 *
 * WHAT IT IS. For a unit of work -- one or more merged pull requests, or a
 * prototype version delivered on its own branch -- the Fable role
 * `fable-build-report` reads the unit from GitHub itself (the workstream issue,
 * every pull request and its review rounds, the commits) and writes a short
 * answer: what was built, whether it agrees with the builder's account, and,
 * only when they hold something, the decisions it questions, what should not
 * have shipped unfixed, what was overbuilt and what it could not check; then
 * one sentence on what is next.
 *
 * WHY IT IS MACHINERY. One property: the role's account reaches David
 * unedited. `chatReport` composes the message from the validated answer's own
 * fields, and the builder pastes it in chat. The only words in it that are not
 * the role's are the labels.
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
 * "AGREES" IS NEVER PRINTED PLAINLY OVER AN UNASSESSED ITEM. The one rule
 * carried over from the translation: could-not-observe is not the favourable
 * answer, and every place the report asserts a fact reads the same fact
 * (`facts`).
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
 * report names the unit from the values the brief carried rather than from a
 * second typing -- both ends of a branch range included, since the head is the
 * next version's `--since` (#224 round 1).
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
 * holds the plan or agreed scope, the State of Play and the decisions line,
 * and a report without it cannot say where the plan stands.
 * The evidence is one or more pull requests, or a prototype branch with the
 * head the evidence stops at -- the branch regime opens no pull request, and
 * the translation this replaced could not report on one for exactly that
 * reason (Codex, #222 round 1).
 */
export function buildBrief({
  root,
  unit,
  issue,
  issueTitle = null,
  prs = [],
  prTitles = [],
  branch = null,
  privatePath = false,
  privateSource = null,
  privateRef = null,
  io = undefined,
  now = () => new Date(),
}) {
  assertUnit(unit);
  const noIssue = issue === undefined || issue === null || Number.isNaN(issue);
  if (privateSource !== null && (typeof privateSource !== "string" || privateSource.trim() === "")) {
    throw new Error(
      "build-report: the private source is empty. It is the text David relayed from the workstream's draft " +
        "Project item -- the plan and the decisions -- and an empty one would leave the report " +
        "with nothing to hold the work against.",
    );
  }
  if (noIssue && privateSource === null) {
    // A WORKSTREAM WITH NO PUBLIC ISSUE IS A REAL CASE, NOT A TYPO: one that
    // is sensitive from the start lives on a private draft Project item the
    // role cannot read (workstream-tracking.md, *Sensitive /
    // disclosure-carve-out workstreams*). Its route is the relay (#227):
    // David pastes the item's text, the builder passes it here.
    throw new Error(
      "build-report: no workstream issue and no private source were given. A workstream with no public issue " +
        "(one on the private path from the start) is reported from the text David relays from its draft Project " +
        "item: ask him to paste it, write it to your scratchpad, and pass --private-source <file>. If this " +
        "workstream has an issue, pass --issue <n>.",
    );
  }
  if (privatePath === true && privateSource === null) {
    // THE PRIVATE FLAG ALONE IS NOT A ROUTE. On the private path the issue,
    // if there is one, is sanitized: the plan and the decisions are on the
    // draft Project item, so a brief built from the flag
    // would tell the role to read them from an issue that does not hold
    // them, and the report would claim a check it never made (#231's build
    // report). The relay is the only source of that side.
    throw new Error(
      "build-report: --private yes was given without a private source. On the private path the plan and the " +
        "decisions live on the draft Project item, not the issue: ask David to paste its " +
        "text, write it to your scratchpad, and pass --private-source <file> (which marks the unit private by itself).",
    );
  }
  if (!noIssue) assertPositiveInt("issue", issue);
  if (!Array.isArray(prs)) throw new Error("build-report: prs must be an array of pull request numbers.");
  for (const n of prs) assertPositiveInt("each pull request number", n);
  // EVERY NUMBER CARRIES ITS TITLE, OR THE BRIEF REFUSES. The coordinates
  // recorded here name the unit to David at the head of the report,
  // and a bare number tells him nothing (claude-core.md, interaction rule 14;
  // KITT #241's build report named this line as the one bare-number
  // line nobody in the loop writes). The script fetches nothing from GitHub,
  // so the titles arrive from the builder, who holds them; a missing one is
  // refused rather than printed as a gap, since a report that reads
  // "title not recorded" would be the defect wearing a label.
  const okTitle = (t) => typeof t === "string" && t.trim() !== "";
  if (!noIssue && !okTitle(issueTitle)) {
    throw new Error(
      "build-report: --issue was given without --issue-title. The report names the workstream " +
        "issue to David, and a number alone is never sufficient (interaction rule 14): pass the issue's title as read " +
        "from GitHub.",
    );
  }
  if (!Array.isArray(prTitles) || prTitles.length !== prs.length || !prTitles.every(okTitle)) {
    throw new Error(
      "build-report: every --pr needs its --pr-title, in the same order. The report names each " +
        "pull request to David, and a number alone is never sufficient (interaction rule 14): pass each title as " +
        "read from GitHub.",
    );
  }
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
  // A PRIVATE SOURCE MAKES THE UNIT PRIVATE, whatever the flag says: the
  // report will be written from the restricted text, so it may carry it.
  // The source's TEXT is never recorded here -- only that one was used and
  // the reference the builder gave the item.
  const isPrivate = privatePath === true || privateSource !== null;
  fs.writeFileSync(
    unitPath(root, unit),
    JSON.stringify({
      issue: noIssue ? null : issue,
      issueTitle: noIssue ? null : issueTitle.trim(),
      prs,
      prTitles: prTitles.map((t) => t.trim()),
      branch,
      private: isPrivate,
      privateSource: privateSource !== null,
      privateRef: typeof privateRef === "string" && privateRef.trim() ? privateRef.trim() : null,
    }) + "\n",
  );
  const until = now().toISOString();
  const schema = loadSchema();
  const lines = [
    "Read your role definition's instructions and follow them. This message is your whole brief: you hold no tool that can open a file, so nothing here points at one.",
    "",
    "## This unit of work",
    "",
    `- **Repository:** \`${repo}\``,
  ];
  if (!noIssue) {
    lines.push(
      privateSource === null
        ? `- **Workstream issue:** ${issueRef(issue, issueTitle)} — the plan or agreed scope, the State of Play, and the decisions taken on recommendation live here.`
        : `- **Workstream issue:** ${issueRef(issue, issueTitle)} — public, and sanitized: it carries labels and tracking only. The plan and the decisions are in the private source below.`,
    );
  }
  if (prs.length) {
    lines.push(`- **Pull requests:** ${prs.map((n, i) => prRef(n, prTitles[i])).join(" · ")} — read each one whole: body, reviews, threads, comments, commits and the cumulative change.`);
  }
  if (branch) {
    lines.push(
      `- **Prototype branch:** \`${branch.name}\`, evidence from after \`${branch.since}\` through \`${branch.head}\` — it opens no pull request, so read its commits (\`list_commits\` on that branch from the head back to \`${branch.since}\`, exclusive) and the full patch of each. \`main\` is merged into the branch from time to time; commits that arrived by such a merge are not this version's work.`,
    );
  }
  if (privateSource !== null) {
    lines.push(
      `- **Private workstream${privateRef ? ` (${privateRef})` : ""}:** its plan and its decisions taken on recommendation live on a draft Project item no tool can read. David relayed its text and the builder quotes it below, verbatim. Read the plan and the decisions from it, and fetch no issue for them. It is David's own record relayed through the builder: weigh it as his, and say in \`took_on_trust\` that you could not check the relay against the item. Your answer is delivered in chat only, so it may refer to what the source says.`,
    );
  }
  lines.push(
    `- **Until:** ${until} — activity after this moment belongs to a later report.`,
    "",
    "## Your answer",
    "",
    `Write it to \`${file}\` as a single JSON object satisfying this schema, and nothing else in that file:`,
    "",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  );
  if (privateSource !== null) {
    lines.push(
      "",
      "## The private source (relayed by David from the draft Project item, quoted verbatim by the builder)",
      "",
      "<private-source>",
      privateSource.trim(),
      "</private-source>",
    );
  }
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
 * A pull request or an issue named to David: number AND title, in interaction
 * rule 14's form. A title the coordinates do not carry -- a unit prepared by
 * an older brief -- is said to be missing rather than silently dropped, so
 * the line never reads as a bare number nobody noticed.
 */
const titled = (kind, n, title) =>
  typeof title === "string" && title.trim() !== "" ? `${kind} #${n} — ${title.trim()}` : `${kind} #${n} (title not recorded)`;
export const issueRef = (n, title) => titled("Issue", n, title);
export const prRef = (n, title) => titled("PR", n, title);

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
 * How the unit is named to David at the head of the report. The slug the
 * builder chose (`pr-243`) is a PR number with no title -- the one bare number
 * left in the first words of every report after #243 fixed the Evidence line
 * (its own build report named it). So the unit is named from the coordinates
 * the brief recorded, in interaction rule 14's form: each PR by number and
 * title, or the branch for a branch unit; the slug only when no coordinates
 * were recorded, where the report already says so.
 */
export function unitLabel(unit, coords) {
  if (!coords) return unit;
  if (Array.isArray(coords.prs) && coords.prs.length) {
    return coords.prs.map((n, i) => prRef(n, Array.isArray(coords.prTitles) ? coords.prTitles[i] : undefined)).join(" · ");
  }
  // A BRANCH UNIT IS NAMED BY BOTH ENDS OF ITS RANGE: the head is what the
  // next version's `--since` is read from.
  if (coords.branch) return `branch \`${coords.branch.name}\` from after \`${coords.branch.since}\` through \`${coords.branch.head}\``;
  return unit;
}

/**
 * THE DELIVERABLE: what the builder pastes in chat, and the only thing it says
 * about the unit (David, 2026-11-25, section by section). What was built; then
 * "Agrees", or each disagreement; then the decisions it questions, what should
 * not have shipped unfixed, what was overbuilt and its caveats, each only when
 * it holds something; then one sentence on what is next. Every word is the
 * role's except the labels.
 *
 * "AGREES" IS NEVER PRINTED OVER AN UNASSESSED ITEM: when something could not
 * be checked, the line says how far the agreement reaches.
 */
export function chatReport(report, { askedModel = null, coords = undefined } = {}) {
  const f = facts(report);
  // A FAILURE SAYS SO IN THE HEADER, so it can never be skimmed as a quiet unit.
  const out = [`**Build report — ${unitLabel(report.unit, coords)}${f.failed ? " · report failed" : ""}**`, ""];
  // A PRIVATE-PATH UNIT IS KEPT BY DAVID, in the workstream's private item:
  // the report is a plain account of the diff, and from a relayed source the
  // restricted plan too (workstream-tracking.md).
  if (coords && coords.private === true) {
    out.push("*Private-path workstream: David, paste this into its private item to keep it.*", "");
  }
  if (f.failed) {
    out.push(
      `No independent account of this unit exists. The role was dispatched and produced nothing usable — ${f.reason}. This is a failure of the report, not a sign that the work was quiet.`,
    );
    return out.join("\n");
  }
  const a = report.answer;
  out.push(a.what_was_built, "");
  if (a.disagreements.length) {
    out.push("**Where it disagrees with the builder**", "");
    for (const d of a.disagreements) out.push(`- **${d.what}** — ${d.why_it_matters}`);
  } else {
    out.push(f.unassessed ? "**Agrees, as far as it could check** (see the caveat below)." : "**Agrees** with the builder's account.");
  }
  const questioned = a.decisions.filter((d) => d && typeof d.concern === "string");
  if (questioned.length) {
    out.push("", "**Decisions it questions**", "");
    for (const d of questioned) out.push(`- **${d.choice}** — ${d.concern} · undo: ${d.undo}`);
  }
  const unfixed = a.shipping_unfixed.filter((g) => g && g.reasonable !== true);
  if (unfixed.length) {
    out.push("", "**Should not have shipped unfixed**", "");
    for (const g of unfixed) out.push(`- **${g.what}** — ${g.why}`);
  }
  if (a.overbuilt.length) {
    out.push("", "**Overbuilt**", "");
    for (const o of a.overbuilt) out.push(`- ${o}`);
  }
  const caveats = [];
  if (f.unassessed) caveats.push(`It could not check everything: ${a.could_not_assess}`);
  const got = a.model ?? null;
  if (!got) caveats.push(`It did not say which model wrote it${askedModel ? `; this repository asks for ${askedModel}` : ""}.`);
  else if (askedModel && got.trim() !== askedModel.trim()) caveats.push(`It was written by ${got}, not the ${askedModel} this repository asks for.`);
  for (const c of caveats) out.push("", `*Caveat:* ${c}`);
  out.push("", `**Next:** ${a.next}`);
  return out.join("\n");
}

/**
 * Read the relayed private text, refusing a file inside the checkout.
 *
 * THE RELAY LIVES IN THE SCRATCHPAD, NEVER THE REPOSITORY
 * (workstream-tracking.md: "the session writes the relayed text to its
 * scratchpad, never the repository"). A copy inside the checkout is one
 * `git add -A` from a public commit, and a commit cannot be unpublished.
 * A cheap check on a path the builder chooses, which catches the slip.
 */
export function readPrivateSource(root, file) {
  const abs = path.resolve(root, file);
  const rel = path.relative(path.resolve(root), abs);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new Error(
      `build-report: the private source ${JSON.stringify(file)} is inside the checkout. Relayed private text lives ` +
        "in the session's scratchpad, never the repository, where one `git add -A` would publish it. Move it out " +
        "and pass that path.",
    );
  }
  return fs.readFileSync(abs, "utf8");
}

/**
 * The command line.
 *
 *   node build-report.mjs brief  --unit <slug> (--issue <n> --issue-title <title> | --private-source <file> [--private-ref <ref>]) [--pr <n> --pr-title <title> ...] [--branch <name> --since <sha> --head <sha>] [--private yes]
 *   node build-report.mjs prepare --unit <slug>
 *   node build-report.mjs report --unit <slug>
 *
 * `brief` prints the dispatch prompt (it also prepares the answer path, so the
 * two cannot be done out of order); `report` prints what is pasted.
 */
export function main({ argv = process.argv.slice(2), root = process.cwd(), io = undefined, stdout = process.stdout } = {}) {
  const [cmd, ...rest] = argv;
  const opts = { pr: [], prTitle: [] };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    const v = rest[i + 1];
    if (!k.startsWith("--") || v === undefined) throw new Error(`build-report: expected --flag value pairs, got ${JSON.stringify(rest.slice(i))}`);
    const name = k.slice(2);
    if (name === "pr") opts.pr.push(Number(v));
    else if (name === "pr-title") opts.prTitle.push(v);
    else opts[name] = v;
    i++;
  }
  if (cmd === "brief") {
    prepareAnswerPath(root, opts.unit);
    const branch = opts.branch ? { name: opts.branch, since: opts.since, head: opts.head } : null;
    const issue = opts.issue === undefined ? undefined : Number(opts.issue);
    const privateSource = opts["private-source"] === undefined ? null : readPrivateSource(root, opts["private-source"]);
    stdout.write(
      buildBrief({
        root,
        unit: opts.unit,
        issue,
        issueTitle: opts["issue-title"] ?? null,
        prs: opts.pr,
        prTitles: opts.prTitle,
        branch,
        privatePath: opts.private === "yes",
        privateSource,
        privateRef: opts["private-ref"] ?? null,
        io,
      }) + "\n",
    );
    return 0;
  }
  if (cmd === "prepare") {
    stdout.write(prepareAnswerPath(root, opts.unit) + "\n");
    return 0;
  }
  if (cmd === "report") {
    stdout.write(chatReport(readAnswer(root, opts.unit), { askedModel: dispatchModel(io).id, coords: readUnit(root, opts.unit) }) + "\n");
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
