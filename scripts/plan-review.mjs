#!/usr/bin/env node
// SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead.
/**
 * One exchange of the in-session planning loop: two peers, one contract, and a
 * plan that never leaves this container.
 *
 * WHAT THIS IS, AFTER THE 2026-09-18 REDESIGN. Astra and I develop the plan
 * together. Astra reads the plan, the agreed oracle and the open concerns, and
 * writes Markdown. I argue where I disagree, investigate the facts myself, and
 * then say what happens next in an explicit `plan-action` block. **Nothing
 * parses an assessment.** No phrase in one can authorise work, and agreement
 * between the two of us never substitutes for David's approval.
 *
 * WHAT IT REPLACED, AND WHY. The first version had Astra return JSON against a
 * ten-section schema; this file validated it, refused it if it failed to
 * reconcile a prior finding, and computed `convergence` from its fields, which
 * the skill's stop rule then read. That made Astra's returned verdict the thing
 * driving the loop. David replaced that design after working through it with
 * Astra: the two of us are peers, the response is prose, and the next action is
 * stated rather than derived.
 *
 * SO THERE IS NO SCHEMA HERE, DELIBERATELY, and no re-ask: the substantive
 * output is Markdown because a person reads it, and there is nothing to
 * validate prose against. What survives from the old file is every piece of
 * machinery that protects something other than a verdict -- the oracle pin, the
 * publication refusals, the plan-drift refusal, the reviewer pin -- and those
 * are load-bearing for reasons recorded beside each one.
 *
 * ONE CONTRACT, TWO ROLES (David, 2026-09-18). `planning-contract.md` is
 * role-neutral and read verbatim by both parties. The facts that differ by role
 * -- who holds the plan, who settles a purely technical tie, where the output
 * goes -- are emitted by `roleBlock` and never left for either party to infer.
 * Both parties must receive the same words, or a difference between two
 * readings is a difference of briefing rather than of judgement. `--role claude
 * --prompt-only` is how I get my own copy.
 *
 * CONTINUITY LIVES IN A LEDGER, NOT IN THE ANSWER. Concerns cross exchanges in
 * `concerns.json` with their reasoning intact, each entry naming the assessment
 * file it came from, so the original argument can be read rather than
 * reconstructed from my summary of it. Open concerns, concerns waiting on
 * David, and any concern a discussion selects render in full; the rest render
 * as one line by reference.
 *
 * USAGE  (`--help` prints these with the path THIS checkout actually has:
 *         `core/scripts/...` in the handbook, `scripts/...` in a consumer)
 * -----
 *   # The scope exchange, before a plan exists: the oracle alone.
 *   node <this file> --kind scope --slug <slug> --oracle <file>
 *
 *   # An assessment of the plan as it now stands.
 *   node <this file> --kind assess --round 1 --tier internal --plan docs/plans/PLAN_X.md
 *
 *   # A focused discussion: no plan edit, no new round, no new assessment.
 *   node <this file> --kind discuss --round 1 --discussion 1 --tier internal \
 *        --plan docs/plans/PLAN_X.md --concerns C2,C5 --question "<the question>"
 *
 *   # My own copy of the same package. TWO FORMS, and the assess one is not
 *   # usable before a plan exists -- which is how the skill's recipe failed
 *   # twice (#124 rounds 1 and 3). Corrected there and, until round 3, not here.
 *   node <this file> --kind scope --slug <slug> --oracle <file> \
 *        --role claude --prompt-only            # before drafting
 *   node <this file> --kind assess --round 1 --tier internal --plan <file> \
 *        --role claude --prompt-only            # once a plan is written
 *
 *   --dry-run  assembles the prompt, writes it, spawns nothing.
 *
 * An exchange is ~9-10 minutes at xhigh (522 s hand-run, 576 s scripted), which
 * is longer than a comfortable Bash tool call. RUN IT DETACHED -- `setsid nohup`
 * with an exit file to wait on; a foreground run that gets cut off loses the
 * exchange, Astra's work included. The skill carries the exact shape.
 *
 * Output: .agents/reviews/<slug>/round-N.md (the assessment), or
 * round-N.discussion-M.md, plus the prompt, the meta and a snapshot of the plan
 * that was actually read. The whole directory is gitignored -- these are session
 * artifacts, and the plan is deliberately not published into git history.
 *
 * EXIT CODES
 *   0  an assessment was written
 *   1  a refusal, or the exchange failed
 *   2  no ChatGPT sign-in in this container -- David has to approve one
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  modelTier,
  codexBin,
  signInStatus,
  spawnSyncDefault,
  SIGN_IN_INSTRUCTIONS,
  runCodex,
} from "./machinery.mjs";

/**
 * The repository root, found by walking up to `.git` rather than counting
 * directories.
 *
 * THIS FILE SITS AT A DIFFERENT DEPTH IN EVERY REPOSITORY THAT RUNS IT. The
 * sync routes `core/X -> X`, so the handbook's `core/scripts/plan-review.mjs`
 * lands at `scripts/plan-review.mjs` in a consumer. A fixed `"..", ".."` is
 * therefore correct in exactly one of the two layouts: it finds the repo root
 * here and the repo's PARENT in every consumer, where the script would then
 * read the contract, create `docs/plans/` and write `.agents/reviews/`
 * OUTSIDE the repository -- silently, since every one of those paths is
 * created on demand.
 *
 * `.git` is the anchor because it is what makes a directory the root, in both
 * layouts and in a worktree (where `.git` is a file -- `existsSync` covers
 * both). The two-up fallback is kept for the one case with no `.git` at all,
 * an extracted tarball, where the old behaviour is no worse than a throw.
 */
export function findRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = process.env.PLAN_REVIEW_ROOT
  ? path.resolve(process.env.PLAN_REVIEW_ROOT)
  : (findRepoRoot(SCRIPT_DIR) ?? path.resolve(SCRIPT_DIR, "..", ".."));

/**
 * Settled: the strongest Codex model, at the effort its tier runs, read-only.
 * Overridable only for smoke tests.
 *
 * THE TIER IS THE SETTLED THING, NOT THE VERSION (David, 2026-09-11). "Astra"
 * means the strongest Codex or ChatGPT model available, so the id lives in
 * `.agents/machinery.json` and a new release is an edit there rather than in
 * this file, every role definition and the documents that name a tier.
 *
 * A FUNCTION RATHER THAN A CONSTANT, deliberately: resolving at module load
 * would make importing this file throw in a checkout whose configuration has
 * no `models` block, which would take out `--help` and `--dry-run` along with
 * the reviewer.
 */
export const defaultReviewer = () => modelTier("strongestCodex");
export const DEFAULT_SANDBOX = "read-only";
export const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];

export const REVIEWS_DIR = ".agents/reviews";

/**
 * The two files read VERBATIM into every package, by their CONSUMER paths
 * first. In the handbook the payload sits one directory deeper and there is no
 * consumer-shaped copy, so the resolver retries under `core/`.
 *
 * VERBATIM RATHER THAN BY PATH, which is the change from the old design. The
 * old prompt handed the contract over as a path and told the reviewer to read
 * it, which is an instruction that can be skipped without anything noticing.
 * Both parties must demonstrably receive the same words -- that is the whole
 * point of one role-neutral contract -- so both are inlined. It costs prompt
 * size and nothing else: this text is byte-identical across the exchanges of a
 * loop, so it sits in the provider's prefix cache.
 */
export const CONTRACT_PATH = "docs/ai-context/planning-contract.md";
/**
 * The Worth rule lives in ONE file, quoted verbatim into both parties' packages
 * and pointed at by the contracts. A judgement rule restated in three places is
 * three rules a year from now.
 *
 * NOTE THE COUPLING, because it is deliberate and worth knowing about: this
 * file is also read by `review-proxy.mjs`, so an edit to it reaches the code
 * loop and the planning loop at once. That is the right coupling -- one rule,
 * one statement -- and naming it here is what keeps a future edit from
 * surprising whoever makes it.
 */
export const JUDGMENT_PATH = "docs/ai-context/review-judgment.md";

/** A lens is emphasis the caller chose. Capped, and framed as emphasis. */
export const MAX_LENS_CHARS = 500;

/**
 * How much of one ledger field is rendered before it is cut.
 *
 * GENEROUS, AND NEVER SILENT. The old file flattened a prior finding's title
 * and note to one capped line, which destroyed exactly the reasoning a focused
 * discussion needs (Astra, on the redesign plan). A cut here names itself and
 * points at the source file, so the full text is one `cat` away.
 */
export const MAX_FIELD_CHARS = 6000;

/** What the caller may state as the next action. */
export const ACTIONS = ["investigate", "scope", "assess", "discuss", "revise", "present-to-david"];

/** The kinds of exchange this script composes. */
export const KINDS = ["scope", "assess", "discuss"];

/** Who the package is addressed to. */
export const ROLES = ["astra", "claude"];

/**
 * What a concern can be.
 *
 * `withdrawn` and `accepted-by-david` are both here on purpose. A party must be
 * able to withdraw a finding it no longer believes without that reading as
 * "addressed", and a trade-off is recorded as accepted only under the name of
 * the person entitled to accept it.
 *
 * `settled-over-dissent` records a technical choice the plan's holder made
 * after discussion while the other party maintained its recommendation. It
 * keeps both arguments prominent in later exchanges and identifies the
 * disagreement for the approval handoff. Ordinary settled concerns remain
 * recoverable from their sources. This state neither selects an action nor
 * requires the other party's agreement.
 *
 * THE JUSTIFICATION IS NARROWER THAN THE ONE IT REPLACED, deliberately. The
 * first version said the argument would otherwise become unreadable. Astra
 * corrected that while assessing this change: rendering by reference does not
 * make an argument unreadable -- the source stays available, and a settled
 * concern selected for a discussion already expands. What the state actually
 * buys is prominence for a disagreement that must be disclosed at handoff, and
 * the distinction between "resolved" and "decided over an objection", which the
 * other states cannot express. The two alternatives were weighed: references
 * alone preserve recoverability but give a live disagreement no prominence, and
 * expanding every entry with a non-empty response uses the wrong distinction,
 * since ordinary resolved concerns have responses too.
 */
export const CONCERN_STATES = [
  "open",
  "addressed",
  "superseded",
  "withdrawn",
  "settled-over-dissent",
  "for-david",
  "accepted-by-david",
];

/**
 * States whose reasoning is rendered in full on every exchange: still live,
 * waiting on David, or settled over an objection that can still be revisited.
 */
const ALWAYS_FULL = new Set(["open", "for-david", "settled-over-dissent"]);

/**
 * The tier of the thing being planned, and what it tells a reader.
 *
 * IT NAMES WHAT IS DOWNSTREAM. IT SETS NO THRESHOLD. Until 2026-09-18 these
 * three names selected a rubric, and `internal` reserved a blocking finding for
 * "a very high chance of a CRITICAL flaw" while everything softer was a
 * recommendation. That is a decline quota, the mirror image of the fix quota it
 * was built to correct, and both are gone. What a tier still supplies is the
 * thing no rule can derive: who or what bears the consequence. The Worth rule
 * needs that in order to weigh a consequence at all, and nobody but the caller
 * can supply it.
 *
 * The lesson from #102 round 1 still binds: a tier that is validated, pinned
 * and logged while never reaching the reader selects nothing. So it reaches the
 * reader, in the script-owned prefix.
 */
export const TIERS = ["product", "sensitive", "internal"];

export const TIER_LENSES = {
  product: [
    "**What is downstream: product code.** Users run this and David cannot read it. Weigh consequences by",
    "what someone using the product would experience, and for how long, before anyone noticed.",
  ],
  sensitive: [
    "**What is downstream: auth, payments or a migration.** Recoverability is the thing to weigh hardest",
    "here, because a wrong authorization decision and a wrong migration cannot be taken back by a",
    "follow-up fix. This does not make every finding in these areas worthwhile; it changes which factor",
    "dominates.",
  ],
  internal: [
    "**What is downstream: the software factory.** This is tooling, process, or instructions agents read.",
    "Nobody's money or data is downstream, so weigh it by its effect on David's ability to direct agents,",
    "build features, fix bugs and understand results -- including recurring reversible disruption, which",
    "costs him real time even though each incident is individually recoverable.",
  ],
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A slug names a directory, so it is checked as one rather than trusted as one. */
export function assertSlug(slug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug ?? "")) {
    throw new Error(
      `--slug must match /^[a-z0-9][a-z0-9-]*$/, got ${JSON.stringify(slug)}. It becomes a path segment under ` +
        `${REVIEWS_DIR}/, so anything else is a traversal waiting to happen.`,
    );
  }
  return slug;
}

/** `docs/plans/PLAN_FOO_BAR.md` -> `foo-bar`, so the common case needs no flag. */
export function slugFromPlanPath(planPath) {
  const base = path.basename(planPath).replace(/\.md$/i, "");
  const slug = base
    .replace(/^PLAN[_-]/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") throw new Error(`cannot derive a slug from ${planPath} -- pass --slug explicitly`);
  return assertSlug(slug);
}

/** The body of the first ```<tag> fenced block, or null. */
export function extractFenced(text, tag) {
  const re = new RegExp("^```" + tag + "\\s*\\n([\\s\\S]*?)\\n```\\s*$", "m");
  const m = re.exec(text ?? "");
  return m ? m[1].trim() : null;
}

/**
 * The oracle: direction, product intent, must-not-change, settled decisions,
 * now/next/never, tier, criticality -- agreed with David BEFORE the plan was
 * written, which is what makes it an oracle rather than a summary of the plan.
 * A plan measured only against itself can be perfectly coherent and still have
 * dropped a requirement. So a missing oracle is a refusal, never an exchange
 * that quietly measures the plan against its own reasoning.
 */
export function oracleFrom({ oracleText, planText }) {
  for (const source of [oracleText, planText]) {
    if (source == null) continue;
    const fenced = extractFenced(source, "plan-oracle");
    if (fenced) return fenced;
  }
  if (oracleText != null && oracleText.trim() !== "") return oracleText.trim();
  throw new Error(
    `no oracle. Either pass --oracle <file>, or give the plan a fenced \`\`\`plan-oracle block at its head ` +
      `carrying the direction, product intent, must-not-change, settled decisions and now/next/never boundaries ` +
      `agreed before the plan was written. Measuring a plan against itself is not the contract.`,
  );
}

/**
 * The concern ledger, checked rather than trusted.
 *
 * WHAT THIS REPLACED. The old file carried prior findings across as id, title,
 * disposition and one flattened line of note, deliberately withholding the
 * original reasoning so the reviewer would re-derive from the current plan.
 * That made sense while the reviewer's job was to reconcile a list. It does not
 * survive a design where a focused discussion argues about a specific concern:
 * the reasoning IS the thing being discussed, and a one-line summary of it
 * written by the party being argued with is the worst possible rendering.
 *
 * WHAT IS CHECKED, AND WHY EACH ONE. A duplicate id, because two concerns
 * sharing one are indistinguishable to every later reference. An unknown state,
 * because a state nobody recognises renders as nothing. A missing source,
 * because the point of the ledger is that the original argument can be read
 * rather than reconstructed from my account of it. An open concern with no
 * text, because that is a title pretending to be a concern.
 *
 * WHAT IS NOT CHECKED, AND CANNOT BE. Whether a concern I never wrote down
 * exists. The ledger is mine to maintain, and no check here reaches that. It is
 * named in the plan, in the skill, and here, rather than papered over.
 */
export function normalizeLedger(raw) {
  if (!Array.isArray(raw)) throw new Error("the ledger must contain a JSON array of concerns");
  const seen = new Map();
  return raw.map((c, i) => {
    const at = `ledger[${i}]`;
    if (c === null || typeof c !== "object" || Array.isArray(c)) throw new Error(`${at} is not an object`);
    const id = typeof c.id === "string" ? c.id.trim() : "";
    if (id === "") throw new Error(`${at} has no "id"`);
    if (seen.has(id)) {
      throw new Error(
        `${at} repeats id ${JSON.stringify(id)}, already used by ledger[${seen.get(id)}]. Every later reference -- ` +
          `a discussion's --concerns, a rendering, David's reading -- is keyed by id, so two concerns sharing one ` +
          `are indistinguishable. Give them distinct ids.`,
      );
    }
    seen.set(id, i);
    const title = typeof c.title === "string" ? c.title.trim() : "";
    if (title === "") throw new Error(`${at} (${id}) has no "title"`);
    if (!CONCERN_STATES.includes(c.state)) {
      throw new Error(
        `${at} (${id}) has state ${JSON.stringify(c.state)}; it must be one of ${CONCERN_STATES.join(", ")}. ` +
          `An unrecognised state renders as nothing, which is how an open concern disappears.`,
      );
    }
    const source = typeof c.source === "string" ? c.source.trim() : "";
    if (source === "") {
      throw new Error(
        `${at} (${id}) has no "source". Every concern names where its reasoning came from -- the assessment file ` +
          `it was raised in, or who raised it -- because the point of this ledger is that the original argument ` +
          `can be READ rather than reconstructed from a summary of it.`,
      );
    }
    // EVERY STATE CARRIES ITS TEXT. This used to exempt the settled states, on
    // the premise that `source` held the reasoning instead -- a premise the
    // test that covered it stated in its own name ("because its source holds
    // it") and which is false: `source` is validated as any non-empty string,
    // and the error above documents a PERSON'S NAME as a valid one. A settled
    // concern sourced to "Astra" rendered an empty fenced block under the
    // heading "The concern, as written", followed by prose saying the full
    // reasoning was in the source file (Codex and both assessors, #124 round 7,
    // reproduced verbatim by the Fable assessor).
    //
    // REMOVING THE EXEMPTION RATHER THAN VALIDATING `source` AS A PATH, which
    // was the reviewer's first suggestion and the Fable assessor's tie-break
    // went the other way: this deletes a conditional instead of adding a check,
    // keeps the documented person-name source safe rather than forbidden, and
    // makes the ledger self-contained -- which is what "earlier reasoning
    // survives across exchanges" actually requires. Rendering by reference is
    // untouched, so no package grows; only the ledger file does.
    const concern = typeof c.concern === "string" ? c.concern.trim() : "";
    if (concern === "") {
      throw new Error(
        `${at} (${id}) carries no "concern" text. Every concern keeps its reasoning in the ledger, in every state: ` +
          `a settled one is rendered by reference rather than in full, and "by reference" has to lead somewhere. ` +
          `"source" can be a person rather than a file, so it cannot be relied on to hold the argument.`,
      );
    }
    return {
      id,
      title,
      state: c.state,
      source,
      raised: typeof c.raised === "string" ? c.raised.trim() : "",
      concern,
      proposed: typeof c.proposed === "string" ? c.proposed.trim() : "",
      evidence: Array.isArray(c.evidence) ? c.evidence.filter((e) => typeof e === "string") : [],
      response: typeof c.response === "string" ? c.response.trim() : "",
      david: typeof c.david === "string" ? c.david.trim() : "",
    };
  });
}

/**
 * Wrap free text so nothing inside it can open a section of the package.
 *
 * THE REASON IS FORMATTING, AND SAYING SO IS THE POINT. An earlier version of
 * this justified the wrapper as protection against the builder steering the
 * reviewer through a crafted field. That threat model belonged to a design
 * where the two parties were adversaries by construction; in a peer loop the
 * builder's argument is SUPPOSED to reach the other party, at full length, with
 * its structure intact. What is left is ordinary and still worth doing: a `##`
 * inside a concern body would render as a heading of the package and confuse a
 * reader about where one section ends.
 *
 * The fence is computed rather than fixed, so text containing `~~~` does not
 * close its own wrapper.
 */
export function fenced(text) {
  const runs = [...String(text).matchAll(/~{3,}/g)].map((m) => m[0].length);
  const longest = runs.length ? Math.max(...runs) : 0;
  const fence = "~".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * Cut a field, and say WHERE THE REST IS -- a storage location, never an
 * attribution.
 *
 * It used to name `c.source`, which is validated as any non-empty string and is
 * documented to be a person: a 9,000-character concern sourced to "Astra"
 * ended "the full text is in Astra", telling the reader to go and read a
 * person. The class is a retrieval reference that supplies attribution where a
 * storage location is needed, and this was its third site and the worst one,
 * because truncation fires on an OPEN concern rendered in full -- the one case
 * the design means to show completely. (Codex, #124 round 13 `4050405448`;
 * Astra bounded the class and the Fable assessor reversed its own stop to
 * reach it.)
 */
function capField(text, where) {
  const s = String(text ?? "");
  if (s.length <= MAX_FIELD_CHARS) return s;
  return `${s.slice(0, MAX_FIELD_CHARS)}\n\n[truncated at ${MAX_FIELD_CHARS} characters — the full text is in ${where}]`;
}

/**
 * Render the ledger for one exchange.
 *
 * FULL TEXT FOR THREE GROUPS, one of which is the correction that matters
 * most: a concern the caller SELECTED for a discussion renders in full whatever
 * its state. A focused question may well challenge something already addressed,
 * withdrawn or superseded -- that is a large share of what there is to argue
 * about -- and a rule that gave full text only to open concerns would strip
 * exactly the reasoning the discussion is about (Astra, on the redesign plan).
 */
export function renderLedger(concerns, { selected = [], ledgerPath = null } = {}) {
  const ledger = ledgerPath ?? `${REVIEWS_DIR}/<slug>/concerns.json`;
  if (!concerns.length) return ["No concerns are on the ledger yet."];
  const pick = new Set(selected.map((s) => String(s).trim()));
  const full = [];
  const brief = [];
  for (const c of concerns) {
    if (!ALWAYS_FULL.has(c.state) && !pick.has(c.id)) {
      brief.push(`- **${c.id}** — ${c.title} — *${c.state}*${c.raised ? `, raised ${c.raised}` : ""} (${c.source})`);
      continue;
    }
    const lines = [`### ${c.id} — ${c.title}`, "", `- State: **${c.state}**${c.raised ? ` · raised ${c.raised}` : ""}`, `- Source: \`${c.source}\``];
    if (c.evidence.length) lines.push(`- Evidence: ${c.evidence.map((e) => `\`${e}\``).join(", ")}`);
    const where = `${ledger} (entry ${c.id})`;
    lines.push("", "**The concern, as written:**", "", fenced(capField(c.concern, where)));
    if (c.proposed) lines.push("", "**What was proposed:**", "", fenced(capField(c.proposed, where)));
    if (c.response) lines.push("", "**The response to it:**", "", fenced(capField(c.response, where)));
    if (c.david) lines.push("", "**David's decision:**", "", fenced(capField(c.david, where)));
    full.push(lines.join("\n"));
  }
  const out = [];
  if (full.length) out.push(...full);
  if (brief.length) {
    out.push(
      [`**Concerns already settled**, listed for reference. The full reasoning of each is in \`${ledger}\`, under its id;`,
       "the source on each says where it was RAISED, which may be a person rather than a file.",
       "Any of them can be reopened by naming it in a discussion — settled is not closed.", "", ...brief].join("\n"),
    );
  }
  return out;
}

/**
 * Who each party is, who the other one is, and who settles what.
 *
 * ONE CONTRACT, TWO READERS, SO THE ROLE-SPECIFIC FACTS ARE THE SCRIPT'S. The
 * contract is deliberately generic -- "your counterpart" throughout -- because
 * both parties must receive the same words for a difference between their
 * readings to mean a difference of judgement rather than of briefing. But a
 * generic contract cannot tell either party which of them holds the plan, and
 * the code loop has already paid for getting this wrong once: its first version
 * shipped one assessor's brief to the other unchanged, so a role read that it
 * discussed with itself and that itself settled ties.
 *
 * So the facts that genuinely differ are emitted here, per role, and never left
 * for either party to infer.
 */
/**
 * NO ASSESSMENT PATH IN HERE. It used to name the concrete file, which made the
 * first bytes of the package change every exchange -- so `stablePrefix` was not
 * stable, which is the property its name and its comment both assert (Codex and
 * both assessors, #124 round 5). The CLI writes that file from the final
 * message whatever the sandbox, so the path was informational and is now
 * simply absent. (This sentence used to say Astra is in a read-only sandbox
 * and cannot write the file -- true by default, false under the supported
 * workspace-write override, and the stale rationale for a decision is exactly
 * what gets re-litigated later.)
 */
export function roleBlock(role) {
  if (!ROLES.includes(role)) {
    throw new Error(`role must be one of ${ROLES.join(", ")}, got ${JSON.stringify(role)}`);
  }
  const astra = role === "astra";
  return [
    "## Your role in this exchange",
    "",
    astra
      // SANDBOX-NEUTRAL, because "read-only" is the DEFAULT and not a fact.
      // `--sandbox workspace-write --unpinned "<why>"` is supported, and the
      // danger-full-access refusal below RECOMMENDS it -- "If it must run the
      // suite, that is workspace-write on a scratch checkout" -- so on a path
      // the script itself proposes, this sentence told the reviewer it could
      // not do what it had just been given permission to do. The class is a
      // standing instruction asserting an environmental restriction that
      // supported execution can change (Astra's bounding), and it had TWO
      // sites; the reviewer reported one. Rendering the selected sandbox here
      // instead would make the role block configuration-dependent, which is
      // what neither assessor wanted. (Codex, #124 round 14 `4051418744`, plus
      // the second site the Fable assessment found.)
      ? "- **You are Astra**, the independent technical planning peer, reached through the Codex CLI in a sandbox."
      : "- **You are Claude**, running Fable: the product engineer developing this plan.",
    astra
      ? "- **Your counterpart is Claude**, running Fable, reading this same contract."
      : "- **Your counterpart is Astra**, reached through the Codex CLI, reading this same contract.",
    // PROSPECTIVE, because the block is emitted at the scope exchange too --
    // where the same package says "There is no plan yet." These said the
    // counterpart "holds the authoritative plan" and asked for "replacement
    // passages" for a document that does not exist, which is the last
    // role-block sentence failing one of the four corners the block has to
    // survive (scope, first assessment, chained discussion, Claude's pre-draft
    // reread). Pre-existing rather than introduced by round 10 -- what round 10
    // got wrong was its CHECK, "true of every exchange", tested against assess
    // and discuss and never against scope. (Codex, #124 round 11 `4050124296`;
    // both assessors concurred, and neither wanted `kind` threaded in here.)
    astra
      ? "- **The authoritative plan is your counterpart's to write and hold.** Propose alternatives, and once a plan exists, replacement passages; it maintains the plan and incorporates the conclusions of your discussion. Do not implement the work."
      : "- **The authoritative plan is yours to write and hold.** Incorporate the conclusions of the discussion into it. Do not implement the work: building starts only on David's explicit approval of the plan.",
    astra
      ? "- **A purely technical disagreement that survives investigation and discussion is your counterpart's to settle**, with its reasoning recorded. You are not obliged to agree, and you are not asked to declare agreement afterwards."
      : "- **A purely technical disagreement that survives investigation and discussion is yours to settle.** Record the reasoning and the material concern that remains. Astra is not obliged to agree.",
    "- **Neither of you can settle what is reserved for David**: intended behaviour, scope, whether a user-facing shortfall is acceptable, and approval of the plan itself. If a disagreement turns out to rest on one of those, say so and stop.",
    astra
      // KIND-NEUTRAL, DELIBERATELY. This said "return the complete assessment",
      // which every `--kind discuss` package then carried alongside
      // `exchangeContext`'s "It is not a new assessment" and "Do not repeat your
      // assessment" -- two live instructions in one package, either of which can
      // fire, and the one that fires wrong costs a ten-minute xhigh re-review
      // landing in the discussion file and updating the ledger. What the reply
      // IS belongs to `exchangeContext`, which knows the kind; what belongs here
      // is what is true of every exchange: the final message is the deliverable.
      //
      // NOT A KIND-CONDITIONAL ROLE BLOCK, which is what the finding asked for.
      // This block is the first bytes of `stablePrefix`, and round 5 removed
      // per-exchange variation from it for that reason; making it vary by kind
      // reintroduces the same class one step weaker. Both assessors recommended
      // against the literal suggestion, independently. (Codex, #124 round 10
      // `4049965635`.)
      ? "- **Return your complete reply as your final message, in Markdown.** The CLI saves that message to this exchange's file — you do not need to write it yourself, and you do not need its path. Do not replace the reply with a completion acknowledgement, and do not spend it narrating the sandbox."
      : "- **Your output is the readout you give David in chat, and — once there is a plan — the revision you make to it.** Nothing is published to a page, and no assessment file is written by you.",
    "",
  ].join("\n");
}

/** The contract and the Worth rule, read verbatim, in either payload layout. */
export function readVerbatim(rel, root = REPO_ROOT) {
  const tried = [];
  for (const candidate of [rel, path.posix.join("core", rel)]) {
    const abs = path.join(root, candidate);
    if (fs.existsSync(abs)) {
      return { path: candidate, text: fs.readFileSync(abs, "utf8").replace(/^<!--[\s\S]*?-->\s*/, "").trim() };
    }
    tried.push(candidate);
  }
  throw new Error(
    `cannot find ${rel} in either payload layout -- tried ${tried.join(" and ")}. Both parties read that file; ` +
      `without it there is no exchange to run.`,
  );
}

// ---------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------

/**
 * The standing half: identical bytes across the exchanges of a loop, for one
 * role.
 *
 * ORDERING IS FOR THE PREFIX CACHE. The role block, the contract, the Worth
 * rule, the tier and the oracle do not change while a loop runs, so they go
 * first and the provider serves them from cache; only "## This exchange"
 * varies. The pilot's 2,893,824-of-3,089,593 cached figure is NOT evidence for this
 * ordering and never was: it aggregates one `codex exec` run whose many repository
 * commands re-send a growing conversation, and a whole package is ~9.5k tokens --
 * under a third of a percent of it (#124 round 5, both assessors). What the
 * ordering buys between exchanges is unmeasured here; what it costs is nothing,
 * and keeping the varying part last is right on its own terms.
 *
 * The PLAN is handed over as a PATH, not inlined -- which both keeps this
 * prefix stable while the plan is rewritten under it, and keeps the reader's
 * evidence its own.
 */
export function stablePrefix({ role, kind, contract, judgment, oracle, planPath, tier = null }) {
  const looking =
    kind === "scope"
      ? [
          "## What you are looking at",
          "",
          "**There is no plan yet.** This is the scope exchange: David and the builder have agreed what they",
          "think should be built, and before a line of the plan is written you are being asked the cheapest",
          "question in the loop — **should this exist at all, and is the boundary in the right place?**",
          "Section 3 of the contract is the part that governs here.",
          "",
          "Inspect the repository before you answer. The claim that a thing is missing, or already exists, or",
          "cannot work the way the intent assumes, is checkable — check it.",
        ]
      : [
          "## The plan",
          "",
          `\`${planPath}\` in the current checkout. Read the whole file.`,
          "",
          "**The plan cites paths and lines in this checkout, and nothing here has verified that the checkout is",
          "the one it was written against.** The loop checks that the plan file itself does not change while an",
          "exchange runs; it makes no claim about the rest of the tree. So treat a path or line number the plan",
          "cites as a claim to check, not as a given — and if what you find does not match what the plan",
          "describes, say so rather than assuming you are looking at the wrong revision.",
        ];

  return [
    roleBlock(role),
    "---",
    "",
    "# The contract you both apply",
    "",
    "Quoted in full so that both parties demonstrably receive the same words. It is role-neutral; the role",
    "block above is what differs.",
    "",
    contract,
    "",
    "---",
    "",
    "# The Worth rule",
    "",
    "Quoted in full, from its one canonical file. The contract's section 4 points at it.",
    "",
    judgment,
    "",
    "---",
    "",
    ...(tier && TIER_LENSES[tier]
      ? ["## What is downstream of this plan", "", ...TIER_LENSES[tier], "", "It names who bears the consequence. It sets no threshold.", ""]
      : []),
    ...looking,
    "",
    "## The oracle: what David agreed this work should achieve",
    "",
    "Agreed before the plan was written. Authority over intended behaviour, scope and acceptance. Measure",
    "against THIS, not only against the plan's internal coherence: a plan can be perfectly consistent with",
    "itself and still have dropped a requirement the intent called for.",
    "",
    oracle,
  ].join("\n");
}

/** The varying half. Everything that changes exchange to exchange lives here, and only here. */
export function exchangeContext({ kind, round, discussion = 0, lens, concerns, selected = [], question = null, priorAssessment = null, predecessor = null, inventory = null, reviewDir = null, ledgerPath = null }) {
  const ledgerRef = ledgerPath ?? `${REVIEWS_DIR}/<slug>/concerns.json`;
  const out = ["## This exchange", ""];

  if (kind === "scope") {
    out.push("This is the scope exchange. There is no plan file and no earlier exchange.");
  } else if (kind === "discuss") {
    out.push(
      `This is a **focused discussion** (round ${round}, discussion ${discussion}). **It is not a new assessment.**`,
      "No new plan revision has been written and no new code exists; the plan is exactly what you last saw.",
      "",
      "Answer the question below directly: what the evidence establishes, whether your view changes, and what",
      "remains unresolved. **Everything you are not asked about keeps the state it already has**, including",
      "unresolved questions and decisions waiting on David. Do not repeat your assessment.",
    );
  } else {
    out.push(
      `This is assessment ${round}.`,
      round > 1
        ? "Assess the plan as it now stands. Carry forward conclusions whose premises have not changed; there is no obligation to reinvestigate everything, to find something new, or to attack from an angle you have not used before."
        : "This is the first assessment of this plan.",
    );
    if (predecessor) {
      out.push(
        "",
        `**The changes since you last saw it are readable, not remembered.** You start cold every time, so what`,
        `exchange ${predecessor.round} worked from is preserved in the checkout:`,
        "",
        `- \`${predecessor.plan}\` — the plan exactly as exchange ${predecessor.round} read it. Diff it against the`,
        "  live plan to see what the revision actually changed.",
        // ROLE-NEUTRAL, because this line is emitted to BOTH roles from the
        // shared section. It said "your own assessment", which is true for
        // Astra and false for me -- the file is Astra's, and my own package
        // addresses me in the second person as a participant, so it read as an
        // attribution rather than a mirror (Codex and both assessors, #124
        // round 7). A role-dependent fact outside the role block is exactly
        // what the role block exists to prevent.
        `- \`${predecessor.assessment}\` — the assessment from that exchange, in full.`,
        "",
        "Read them if you are judging what changed or whether an earlier conclusion still holds. Those two are the",
        "baseline to compare against; the whole record of this loop is named below.",
      );
    }
  }

  if (question) {
    out.push("", "### The question", "", question.trim());
  }

  // --- where the whole record is, stated once, instead of listed ------------
  //
  // A POINTER AND A CONVENTION, NOT AN ENUMERATION, and that is this feature's
  // third shape rather than its first. Round 9 made a sentence conditional,
  // round 10 made one neutral, round 10 also enumerated the previous round's
  // discussion files -- and each move fixed one corner of a space with four
  // axes (role, kind, round, discussion index) and exposed the next. The
  // enumeration's corner was the round axis: it listed `prev` only, so a
  // concern settled in round 1's discussion vanished from round 3's package
  // once round 2 legitimately omitted the settled concern (Codex, #124 round 11
  // `4050124291`). Completing the enumeration would have worked today and kept
  // the shape whose correctness depends on the script listing every relevant
  // file.
  //
  // Naming the directory and the convention says ONE thing that is true at
  // every corner, and it closes cases nobody reported: `round-0.md`, the scope
  // reply, was never named in any later package either. It derives nothing --
  // the directory is already computed and the convention is already enforced by
  // `assessmentPath` -- which is the shape David asked for on the round-9 fork:
  // tell the consumer, do not compute it. (Both assessors concurred; the Fable
  // assessor revised its own round-10 recommendation to reach it.)
  //
  // NOT ON A SCOPE EXCHANGE, where the directory holds nothing yet.
  if (kind !== "scope") {
    out.push(
      "",
      "### The whole record of this loop, if you need it",
      "",
      // THE RESOLVED DIRECTORY, not the literal `<slug>`. A pointer that names
      // no path is not a pointer: with an explicit `--slug` differing from the
      // plan filename, on a first assessment or a round-1 discussion, nothing
      // else in the package names the directory either -- the predecessor block
      // only exists from round 2, and a ledger `source` may be a person's name.
      // The value was already computed at the call site and simply not passed.
      // (Codex, #124 round 12 `4050265290`; both assessors concurred.)
      `Everything either of us has written is in \`${reviewDir ?? REVIEWS_DIR + "/<slug>"}/\`, beside the files named above,`,
      "under one convention:",
      "",
      "- `round-0.md` — the scope exchange's reply, before any plan existed.",
      "- `round-N.md` — assessment N. `plan-round-N.md` — the plan exactly as assessment N read it.",
      // NOT "a question and its answer": the canonical file is promoted from
      // `--output-last-message`, so it holds the reply alone. A free rider on
      // `4050265290`'s edit -- six lines away, same function, same commit --
      // rather than a finding that earned a write (Codex, #124 round 12
      // `4050265293`; both assessors called it a recorded gap under David's
      // lens, and both said to correct it anyway while the block is open).
      "- `round-N.discussion-M.md` — the reply in the M-th focused discussion on assessment N. The question it",
      "  answered is under *The question* in `round-N.discussion-M.prompt.md` beside it; the two are the record.",
      "",
      "**A concern the ledger below shows as settled was usually settled in one of the discussion files**, not in",
      // NOT "the entry's own source names the argument". `source` is validated as
      // any non-empty string and is documented to be a person, so it is
      // attribution; the argument itself is in the ledger, whose path is
      // computed at the call site and was simply not passed -- the same defect
      // round 12 fixed one field over for `reviewDir`. A custom `--ledger` is what
      // makes this more than wording: the ledger then sits outside the review
      // directory this block names, and nothing in the package located it at
      // all (Codex, #124 round 13 `4050405448`; Astra bounded the class).
      `the assessment that raised it — so the full text of every concern is in \`${ledgerRef}\`, and the reply`,
      "that answered it is a file away. Read what you need; nothing here asks you to read all of it.",
    );
  }

  out.push("", "### The concern ledger", "");
  if (kind === "discuss") {
    out.push(
      "The concerns named in the question are rendered in full below, whatever state they are in, because a",
      "focused question is often about one that was already settled. Everything else keeps its state.",
      "",
    );
  } else {
    out.push(
      "Concerns still open, those waiting on David, and those settled over a maintained objection are rendered",
      "in full with the reasoning as it was written. The rest are listed by reference; the full text of each is",
      `in \`${ledgerRef}\` under its id, and any of them can be reopened if its basis changed.`,
      "",
    );
  }
  out.push(...renderLedger(concerns, { selected, ledgerPath }));

  if (priorAssessment) {
    // Same class as the predecessor line above: the second site Astra found.
    //
    // NAMED BY WHAT THE FILE ACTUALLY IS, because for discussion 2 onward it is
    // NOT the assessment. `assessmentPath(dir, round, discussion - 1)` returns
    // `round-N.discussion-(M-1).md` once `M-1 > 0`, so a chained reply quoted a
    // narrow focused answer under a heading calling it the round's assessment
    // -- in the same package that tells the reader a discussion "is not a new
    // assessment" and "Do not repeat your assessment". A cold reader handed a
    // narrow reply labelled as the assessment can reasonably conclude that
    // everything absent from it was dropped, which is the opposite of the
    // "everything you are not asked about keeps its state" line two paragraphs
    // above it. (Codex, #124 round 9 `4049773970`; both assessors concurred.)
    out.push(
      "",
      discussion > 1
        ? `### The previous focused reply of this round (discussion ${discussion - 1}), quoted`
        : "### The assessment of this round, quoted",
      "",
      priorAssessment.trim(),
    );
  }

  if (inventory) {
    out.push(
      "",
      "### The plan's own affected-file inventory",
      "",
      "A starting map, not a boundary — the plan's author listed these as the files the work touches. Where it",
      "is wrong or incomplete, that is itself worth raising.",
      "",
      inventory,
    );
  }

  out.push(
    "",
    // `--lens` is refused with `--kind discuss` (see the parser), so this
    // branch only ever describes an assessment. The no-lens heading still has
    // to stop saying "assess" on a discussion, whose scope is the question.
    `### Emphasis for this exchange: ${lens ? lens : kind === "discuss" ? "none — answer the question asked" : "none — assess evenly"}`,
    "",
    lens
      ? "Attack from that angle specifically. It directs EMPHASIS, not scope: still read and assess the whole thing, and a serious problem outside it is still worth raising."
      : "No particular angle was requested.",
    "",
    "---",
    "",
    "Write Markdown. Lead with the short plain-English readout for David. Nothing you write starts an exchange,",
    "authorises implementation, or approves the plan — what happens next is stated explicitly by the party",
    "holding it, and approval is David's alone.",
  );
  return out.join("\n");
}

export function assemblePackage(parts) {
  return [stablePrefix(parts), "", exchangeContext(parts)].join("\n");
}

/**
 * The next action, stated by the party holding the plan.
 *
 * NOTHING PARSES AN ASSESSMENT TO GET HERE. The contract is explicit that an
 * assessment does not command the harness, and that agent agreement does not
 * substitute for David's approval. This renders the stated selection as a block
 * a reader can find, in the shape `plan-provenance` and `review-action` already
 * use.
 */
export function actionBlock({ action, concerns = [], note = "" }) {
  if (!ACTIONS.includes(action)) {
    throw new Error(`action must be one of ${ACTIONS.join(", ")}, got ${JSON.stringify(action)}`);
  }
  const lines = ["```plan-action", `action: ${action}`];
  if (concerns.length) lines.push(`concerns: ${concerns.map((c) => String(c).trim()).join(", ")}`);
  if (note.trim()) lines.push(`note: ${String(note).replace(/\s+/g, " ").trim()}`);
  lines.push("```");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export const assessmentPath = (dir, round, discussion = 0) =>
  path.join(dir, discussion > 0 ? `round-${round}.discussion-${discussion}.md` : `round-${round}.md`);

/**
 * Read an assessment.
 *
 * ALL THAT IS CHECKED IS THAT SOMETHING SUBSTANTIVE ARRIVED. There is no schema
 * any more, so there is nothing to validate against; prose is judged by reading
 * it. What still matters is that a missing or empty file is reported as a FAILED
 * exchange in plain words, never as a quiet one -- the lesson from #109, where a
 * failed read rendered as "nothing to report".
 */
export function readAssessment(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { failed: true, reason: `no assessment file was written (${err.code === "ENOENT" ? "not found" : err.code})` };
  }
  if (raw.trim() === "") return { failed: true, reason: "the assessment file is empty" };
  return { failed: false, markdown: raw.trim() };
}

const defaultGit = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });

/**
 * Refuse anything git would publish.
 *
 * ONE QUESTION, ASKED IN ONE PLACE. `kind` selects only the WORDS -- what this
 * particular file exposes, and how to fix it -- never the logic. A new path
 * added to this script cannot be quietly unguarded: there is nowhere else to
 * put the check.
 *
 * TWO PROBES, because git answers differently depending on whether the thing
 * exists yet. A file that exists is asked with `git status --porcelain
 * --untracked-files=all`, where a `??` prefix is exactly "a file `git add -A`
 * would stage". A path that does not exist yet is asked with `git check-ignore`,
 * which answers from the ignore rules alone.
 *
 * Both ask GIT rather than reading patterns, which is the load-bearing lesson: a
 * `.gitignore` is not a set of patterns, it is an ordered program whose LAST
 * match decides, so `*` followed by `!PLAN_SECRET.md` leaves that one plan
 * exposed while every pattern scan calls it protected.
 *
 * Not being able to ask is not the same as a bad answer, and is never refused:
 * outside a git repository there is no commit to make by accident.
 */
const PROTECTED = {
  plan: {
    // The ONLY kind that tolerates a tracked file. David asking for a plan on
    // `main` is a supported, deliberate act with the disclosure check in front
    // of it. Nothing else here has an equivalent case.
    allowTracked: true,
    noun: (p) => p,
    why:
      "A plan is exactly the document that might name an unpatched vulnerability, an auth-bypass specific, a " +
      "customer or an embargoed launch.",
    remedy:
      "docs/plans/.gitignore exists and carries an ignoring pattern, but a later negation overrides it. Fix the " +
      "negation, or move the plan.",
  },
  oracle: {
    noun: (p) => `the oracle ${p}`,
    why:
      "The oracle is the agreed scope, which is where an unpatched vulnerability, an auth-bypass specific, a " +
      "customer name or an embargoed launch gets written down -- the same material the disclosure carve-out " +
      "protects, one document before the plan.",
    remedy: null,
  },
  ledger: {
    noun: (p) => `the concern ledger ${p}`,
    why:
      "The ledger carries every concern's full reasoning, which restates the plan's most sensitive parts in two " +
      "parties' words -- so it holds the same material the plan and the oracle are protected for, in a file that " +
      "looks like bookkeeping.",
    remedy: null,
  },
  reviews: {
    noun: (p) => `the review directory ${p}`,
    why:
      "Every exchange writes its composed package there, and the package CONTAINS THE WHOLE ORACLE -- so this " +
      "directory holds the most sensitive text in the loop, in the file least likely to be looked at. The " +
      "assessments beside it restate the plan's concerns.",
    remedy:
      `${REVIEWS_DIR}/.gitignore exists but does not actually ignore this slug -- most likely a negation ` +
      `elsewhere, since a .gitignore is an ordered program and the last matching rule wins. Fix it, or move ` +
      `the loop under a slug that is ignored.`,
  },
};

export function assertIgnored(root, relPath, git = defaultGit, kind = "oracle") {
  if (!relPath) return;
  const spec = PROTECTED[kind] ?? PROTECTED.oracle;
  const abs = path.join(root, relPath);
  const isFile = fs.existsSync(abs) && fs.statSync(abs).isFile();

  // The `status` probe is what tells a tracked file from an untracked one, so
  // it is used ONLY where being tracked is an allowed answer. Everywhere else
  // `check-ignore` decides, and it refuses a tracked file too -- correctly: a
  // tracked oracle reports " M" or "M " rather than "??", so the status probe
  // waved through a modified-and-staged oracle that `git add -A` publishes.
  let probe;
  if (isFile && spec.allowTracked) {
    const out = git(["status", "--porcelain", "--untracked-files=all", "--", relPath], root);
    if (out.error || out.status !== 0 || typeof out.stdout !== "string") return;
    if (!out.stdout.split("\n").some((l) => l.startsWith("??"))) return;
    probe = '`git status --porcelain --untracked-files=all` reports it as "??"';
  } else {
    const out = git(["check-ignore", "-q", "--", relPath], root);
    // 1 is the ONLY exposed answer, and it covers both ways a path is exposed:
    // untracked with no rule ignoring it, and already tracked. 0 is ignored;
    // 128 (and a failed spawn) is git declining to answer, which is not
    // evidence of exposure.
    if (out.error || out.status !== 1) return;
    probe = "`git check-ignore` reports it as not ignored (untracked with no rule covering it, or already tracked)";
  }

  throw new Error(
    `${spec.noun(relPath)} is NOT ignored by git -- ${probe}, so \`git add -A\` would stage it. ${spec.why} ` +
      `${spec.remedy ?? `Move it under docs/plans/ (which this script keeps ignored), under the loop's own ` +
        `${REVIEWS_DIR}/<slug>/ directory, or another ignored path.`} This exchange is refused rather than run ` +
      `against an unprotected path.`,
  );
}

/**
 * The exchange directory, with a `.gitignore` that ignores everything in it.
 *
 * Written by the script rather than shipped as a payload file, so it exists in
 * every consumer the first time an exchange runs and cannot be half-installed.
 * `*` ignores the `.gitignore` itself too, which is the intent: a plan under
 * development is deliberately not published into git history, and neither is
 * either party's assessment of it.
 */
export function ensureRoundDir(root, slug, git = defaultGit) {
  const dir = path.join(root, REVIEWS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(root, REVIEWS_DIR, ".gitignore");
  if (fs.existsSync(ignore)) {
    // A consumer that already has one is VERIFIED, not trusted. Append the
    // managed pattern when the file does not carry one; never rewrite what a
    // consumer put there. Then ask git, because the pattern being present is
    // not the question -- whether git concludes "ignored" is.
    const patterns = fs
      .readFileSync(ignore, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    if (!patterns.includes("*")) {
      fs.appendFileSync(
        ignore,
        "\n# Added by the planning loop: an exchange's package contains the whole\n" +
          "# oracle, so nothing under here is ever committed by accident.\n*\n",
      );
    }
  } else {
    fs.writeFileSync(
      ignore,
      [
        "# Planning exchanges are session artifacts, not repo history.",
        "#",
        "# The plan under development is deliberately never published into git, which is",
        "# what dissolved the disclosure gate the old public plan-review PR needed. Both",
        "# parties' assessments of it are the same class of thing. What survives a loop is",
        "# the approved plan (if David asks for it) and the harvest comment on the",
        "# workstream issue.",
        "#",
        "# `*` covers this file too, deliberately.",
        "*",
        "",
      ].join("\n"),
    );
  }
  assertIgnored(root, path.relative(root, dir), git, "reviews");
  return dir;
}

/**
 * `docs/plans/` ignores itself, so `git add -A` during implementation cannot
 * publish a plan.
 */
export function ensurePlansIgnored(root, planPath = null, git = defaultGit) {
  const dir = path.join(root, "docs", "plans");
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (fs.existsSync(ignore)) {
    // A consumer that already has one is verified, not trusted: the file's
    // existence says nothing about whether it ignores a plan.
    const patterns = fs
      .readFileSync(ignore, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    if (!patterns.some((l) => l === "*" || l === "PLAN_*.md" || l === "/PLAN_*.md")) {
      fs.appendFileSync(
        ignore,
        "\n# Added by the planning loop: a plan under development is never committed by accident.\nPLAN_*.md\n",
      );
    }
    assertIgnored(root, planPath, git, "plan");
    return;
  }
  fs.writeFileSync(
    ignore,
    [
      "# A plan under development is never published, and this is what makes that true",
      "# rather than merely intended: `git add -A` during implementation would",
      "# otherwise stage it, and a plan is exactly the document that might name an",
      "# unpatched vulnerability, an auth-bypass specific, a customer or an embargoed",
      "# launch.",
      "#",
      "# A plan reaches `main` only when David asks for it, deliberately, with the",
      "# disclosure check in front of it.",
      "PLAN_*.md",
      "",
    ].join("\n"),
  );
  assertIgnored(root, planPath, git, "plan");
}

/**
 * The oracle, pinned to the text David agreed, for the life of the loop.
 *
 * Without this the oracle is read from the plan file the builder rewrites every
 * exchange, so deleting a requirement from the plan AND from its oracle block
 * makes the next exchange measure the plan against the rewritten intent. That is
 * the builder steering the process through the one input nobody was watching.
 *
 * A deliberate change is still possible; it just cannot be silent.
 */
export function pinOracle(dir, oracle, { changedReason = null } = {}) {
  const file = path.join(dir, "oracle.txt");
  // The DECISION is made now, so a drifted oracle refuses before anything runs;
  // the WRITE waits for `commit()`, which main calls only when the exchange
  // completes. Written up front, an --oracle-changed run that was then refused
  // -- or exited 2 without a sign-in -- had already made the new oracle
  // authoritative, and the next run reported it as matching with no reason ever
  // stamped.
  const commit = () => fs.writeFileSync(file, `${oracle}\n`);
  if (!fs.existsSync(file)) {
    return { pinned: sha256Full(oracle), changed: false, firstPin: true, commit };
  }
  const pinnedText = fs.readFileSync(file, "utf8").trim();
  if (pinnedText === oracle.trim()) return { pinned: sha256Full(oracle), changed: false, firstPin: false, commit: () => {} };
  if (!changedReason) {
    throw new Error(
      `the oracle differs from the one pinned at ${path.relative(process.cwd(), file)} when this loop started, and ` +
        `nothing says why. The oracle is what David agreed BEFORE the plan was written; if it can be edited as the ` +
        `plan is revised, the plan is being measured against itself. Restore it, or pass ` +
        `--oracle-changed "<what David agreed to change>" so the change is recorded.`,
    );
  }
  return { pinned: sha256Full(oracle), changed: true, changedReason, firstPin: false, commit };
}

/**
 * Refuse a tier that disagrees with the one this loop already ran under.
 *
 * Read from the earliest meta that recorded one, so the pin is the tier the loop
 * STARTED on rather than whatever the last exchange happened to pass. A meta
 * without a tier (the scope exchange runs before `--tier` is required) is
 * skipped rather than treated as a mismatch.
 */
export function assertTierPinned(dir, earlier, tier) {
  for (const n of [...earlier].sort((a, b) => a - b)) {
    const file = path.join(dir, `round-${n}.meta.json`);
    if (!fs.existsSync(file)) continue;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const pinned = meta?.tier;
    if (typeof pinned !== "string" || pinned === "") continue;
    if (pinned === tier) return;
    throw new Error(
      `this loop ran exchange ${n} as tier "${pinned}", and this one says "${tier}". The tier names what is ` +
        `downstream, so changing it mid-loop re-frames earlier exchanges against a consequence they never ran ` +
        `against. Re-run with --tier ${pinned}, or start a new loop under a new slug if the work genuinely ` +
        `changed tier.`,
    );
  }
}

/** Exchanges already run for this loop, counted from disk rather than stored. */
export function roundsRun(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((n) => /^round-(\d+)\.md$/.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

const sha256Full = (text) => crypto.createHash("sha256").update(text).digest("hex");
/** Short digests, for telling two revisions apart in a log line. */
const sha256 = (text) => sha256Full(text).slice(0, 12);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const flags = {};
  const bools = { "dry-run": "dryRun", "no-ledger": "noLedger", help: "help", "prompt-only": "promptOnly" };
  const values = {
    kind: "kind", round: "round", discussion: "discussion", plan: "plan", oracle: "oracle", slug: "slug",
    lens: "lens", ledger: "ledger", concerns: "concerns", question: "question", role: "role",
    model: "model", effort: "effort", sandbox: "sandbox", timeout: "timeout", tier: "tier",
    unpinned: "unpinned", "oracle-changed": "oracleChanged",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
    const name = arg.slice(2);
    if (bools[name]) {
      flags[bools[name]] = true;
      continue;
    }
    if (values[name]) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`--${name} needs a value`);
      flags[values[name]] = value;
      continue;
    }
    throw new Error(`unknown flag --${name}`);
  }
  return flags;
}

/**
 * How to invoke THIS copy, computed rather than written down.
 *
 * The sync routes `core/X -> X`, so the same file is `core/scripts/...` in the
 * handbook and `scripts/...` in every consumer. A hardcoded usage line is
 * therefore wrong in one of them, and wrong in the place a reader is most
 * likely to trust it: `--help` and every argument-error response, which is
 * exactly what someone copies when they are already confused.
 */
const INVOCATION = path.relative(REPO_ROOT, fileURLToPath(import.meta.url)).split(path.sep).join("/");
const FLAG_COLUMN = " ".repeat("  node ".length + INVOCATION.length + 1);

export const USAGE = [
  "The planning loop: one exchange between two peers reading one contract.",
  "",
  "Usage:",
  `  node ${INVOCATION} --kind scope --slug <slug> --oracle <file>`,
  `  node ${INVOCATION} --kind assess --round <N> --tier <t> --plan <file>`,
  `${FLAG_COLUMN}[--slug <s>] [--oracle <f>] [--lens <text>] [--ledger <f> | --no-ledger]`,
  `  node ${INVOCATION} --kind discuss --round <N> --discussion <M> --tier <t> --plan <file>`,
  `${FLAG_COLUMN}--concerns <id,id> --question <text>`,
  "",
  `  --kind        ${KINDS.join(" | ")} (default assess)`,
  `  --tier        ${TIERS.join(" | ")} — what is downstream, not a threshold. Required except for scope.`,
  `  --role        ${ROLES.join(" | ")} (default astra). Selects the role block; 'claude' needs --prompt-only.`,
  "  --ledger      the concern ledger, default <reviews>/<slug>/concerns.json",
  "  --concerns    ids rendered in FULL for a discussion, whatever state they are in",
  "  --prompt-only print the package and run nothing — how I get my own copy",
  "  --dry-run     assemble the package, write it, spawn nothing",
  "  --oracle-changed <reason>   the oracle differs from the pinned one, deliberately",
  "",
  `  Astra is PINNED to the strongestCodex tier in \`.agents/machinery.json\`, in a ${DEFAULT_SANDBOX} sandbox.`,
  "  --model / --effort / --sandbox are refused unless --unpinned <reason> is given,",
  "  and danger-full-access is refused always. The reason is stamped on the exchange.",
  "",
  "  --timeout     seconds, default 2700",
  "  CODEX_BIN     path to the codex binary, if it is not on PATH",
].join("\n");

export function main(argv = process.argv.slice(2), { root = REPO_ROOT, run = spawnSyncDefault, log = console.error, git = defaultGit } = {}) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    log(`planning: ${err.message}\n\n${USAGE}`);
    return 1;
  }
  if (flags.help) {
    log(USAGE);
    return 0;
  }

  try {
    // --- kind, role, round ------------------------------------------------
    const kind = flags.kind ?? "assess";
    if (!KINDS.includes(kind)) throw new Error(`--kind must be one of ${KINDS.join(", ")}, got ${JSON.stringify(flags.kind)}`);

    const role = flags.role ?? "astra";
    if (!ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(", ")}, got ${JSON.stringify(flags.role)}`);
    // THE ROLE PICKS THE PACKAGE, AND ONLY ASTRA'S IS RUN BY THIS SCRIPT. My own
    // copy is something I read; there is no process to start for it, and a
    // `--role claude` run that spawned Astra would hand Astra a package telling
    // it that it holds the plan.
    if (role === "claude" && !flags.promptOnly) {
      throw new Error(
        `--role claude composes the package for the party this script does not run — it is mine to read. Use ` +
          `--prompt-only.`,
      );
    }

    // --- what `--prompt-only` is actually exempt FOR ----------------------
    //
    // TWO REFUSALS EXEMPT IT, and both were written as `!flags.promptOnly`
    // while the reason for both is one legitimate use: me re-reading my own
    // copy. An exemption granted to the FLAG rather than to the REASON let an
    // astra-role preview past the accepted-assessment refusal and overwrite
    // `round-N.prompt.md` -- the record of what Astra was actually sent --
    // while the meta still carried the original package digest, on a round
    // that is otherwise immutable (Codex and both assessors, #124 round 5).
    //
    // Named once, used at both sites, so the next exemption cannot drift from
    // its reason the way these two did. Checked before narrowing: both
    // `--prompt-only` recipes in the payload pass `--role claude`
    // (SKILL.md:46 and :58), so nothing documented is refused by this.
    const myReread = flags.promptOnly && role === "claude";

    let round = 0;
    if (kind === "scope") {
      if (flags.round != null && Number(flags.round) !== 0) {
        throw new Error("--kind scope is the exchange before a plan exists; it takes no --round.");
      }
      if (flags.plan) throw new Error("--kind scope runs BEFORE a plan exists; it takes --oracle, not --plan.");
      if (!flags.oracle) throw new Error("--kind scope needs --oracle <file>: it assesses the intent, and the intent is all it gets.");
    } else {
      if (flags.round == null) throw new Error(`--kind ${kind} needs --round <N>`);
      round = Number(flags.round);
      if (!Number.isInteger(round) || round < 1) throw new Error(`--round must be an integer >= 1, got ${JSON.stringify(flags.round)}`);
      if (!flags.plan) throw new Error(`--kind ${kind} needs --plan <file>`);
    }

    let discussion = 0;
    if (kind === "discuss") {
      if (flags.discussion == null) throw new Error("--kind discuss needs --discussion <M>, so two discussions of one round do not overwrite each other");
      discussion = Number(flags.discussion);
      if (!Number.isInteger(discussion) || discussion < 1) throw new Error(`--discussion must be an integer >= 1, got ${JSON.stringify(flags.discussion)}`);
      if (!flags.question || !flags.question.trim()) throw new Error("--kind discuss needs --question <text>: a discussion without a question is a re-assessment");
      if (!flags.concerns || !flags.concerns.trim()) {
        throw new Error(
          "--kind discuss needs --concerns <id,id>: the concerns in dispute are rendered in full whatever state " +
            "they are in, and without them the other party is asked to argue about nothing in particular.",
        );
      }
      // A lens is emphasis for a reading of the WHOLE plan, and its own prose
      // says so -- "still read and assess the whole thing" -- which is the
      // instruction a discussion exists to avoid. `USAGE` documents `--lens` on
      // the assess line only; the parser took it anywhere, so the undocumented
      // combination shipped the contradiction. Removing the input beats
      // branching on it: the question already carries the emphasis. (Codex,
      // #124 round 10 `4049965635`; the Fable assessor preferred the refusal
      // over a branch and Astra was content with either.)
      if (flags.lens != null) {
        throw new Error(
          "--lens belongs to --kind assess: it directs emphasis across a whole plan, and its own wording asks for " +
            "the whole thing to be read and assessed -- which is the opposite of a focused discussion. Put the " +
            "emphasis in --question, which is what the other party is answering.",
        );
      }
      // THE SECOND INSTANCE OF THE CLASS THE --lens REFUSAL ABOVE CLOSED, and
      // the worse one. USAGE documents --oracle, --lens, --ledger and
      // --oracle-changed on the assess line and none of them on the discuss
      // line; the parser takes them anywhere. --lens widened what the other
      // party was asked to READ; --oracle-changed changes what it MEASURES
      // AGAINST, while the ledger it is shown was settled under the old
      // boundary and the package says in its own words that the plan is
      // exactly what it last saw and everything unasked keeps its state.
      //
      // NOTHING TELLS ANYONE. `pin.changed` reaches `round-N.meta.json` and the
      // DRY-RUN log line only; the live completion log prints kind, concerns,
      // seconds and tier and no oracle line at all, and the package has no
      // oracle-change input. So the operator gets no notice at the time and
      // the peer gets none ever.
      //
      // REFUSED HERE, before `pinOracle` runs, so nothing is pinned and no
      // prompt file is written. The message names the next round, because
      // `pinOracle`'s own refusal says "pass --oracle-changed" without knowing
      // the kind -- a caller who follows that advice on a discussion lands
      // here, and this has to be the last hop.
      //
      // --oracle ITSELF IS NOT REFUSED: a loop whose assessments took an
      // external oracle file, with no fenced block in the plan, needs the
      // discussion to receive the same file or `oracleFrom` refuses outright.
      // An UNCHANGED external oracle is already harmless -- the pin matches.
      // (Codex, #124 round 13 `4050405459`; Astra recommended the refusal and
      // the Fable assessor reversed its own stop to it once the false log-line
      // premise I had supplied was corrected.)
      if (flags.oracleChanged != null) {
        throw new Error(
          `--oracle-changed belongs to --kind assess. A discussion tells the other party the plan is exactly what ` +
            `it last saw and that everything it is not asked about keeps its state -- both of which are measured ` +
            `against the pinned oracle, and nothing in the package or the live log would say the boundary moved. ` +
            `A changed boundary belongs in an assessment: run --kind assess --round ${round + 1} --oracle-changed ` +
            `"<what David agreed to change>". An UNCHANGED --oracle file is still fine on a discussion.`,
        );
      }
    } else {
      if (flags.discussion != null) throw new Error("--discussion belongs to --kind discuss");
      if (flags.question != null) throw new Error("--question belongs to --kind discuss");
    }

    // --- plan -------------------------------------------------------------
    //
    // CREATED UNCONDITIONALLY, BEFORE THE KIND CHECK, because the window this
    // closes is between the exchanges rather than inside one: the documented
    // sequence is scope exchange, then draft the plan, then assess -- so tying
    // creation to "an exchange that has a plan" left the draft unignored for
    // exactly as long as it took to write it, and a `git add -A` in that gap
    // published it (Codex and both assessors, #124 round 2). The payload copy
    // is what protects a synced consumer; this covers a repository that has not
    // synced yet, where no committed copy exists at all.
    //
    // `assertIgnored` returns immediately on a null path, so this creates and
    // verifies nothing concrete. The real plan path is verified below, once
    // there is one -- two calls, deliberately, rather than one moved.
    ensurePlansIgnored(root, null, git);

    let planPath = null;
    let planText = null;
    if (kind !== "scope") {
      planPath = path.relative(root, path.resolve(root, flags.plan));
      const abs = path.join(root, planPath);
      if (!fs.existsSync(abs)) throw new Error(`--plan ${flags.plan} does not exist at ${abs}`);
      // After the path is known, so the ignore can be verified against THIS
      // plan rather than against a pattern that looks convincing.
      ensurePlansIgnored(root, planPath, git);
      planText = fs.readFileSync(abs, "utf8");
    }

    // --- slug, and the review directory's own protection -------------------
    //
    // THIS RUNS BEFORE THE ORACLE CHECK, and the order is the whole fix for a
    // first-run blocker: the documented scope recipe writes the oracle to
    // `.agents/reviews/<slug>/oracle-<slug>.md`, and in a fresh consumer
    // `.agents/reviews/.gitignore` does not exist yet -- so checking the oracle
    // first refused every first exchange in every consumer, with a message
    // advising the operator to move the file somewhere it already was.
    // `ensureRoundDir` is what CREATES that protection, and it verifies itself.
    const slug = flags.slug ? assertSlug(flags.slug) : slugFromPlanPath(planPath ?? "");
    const dir = ensureRoundDir(root, slug, git);
    // A DISCUSSION'S PREDECESSOR IS ITS OWN ROUND, so it must not be filtered
    // out. The filter exists for an assessment, where round N cannot be its own
    // prior; on a discussion of round N the round-N assessment is exactly the
    // exchange whose tier has to stay pinned, and excluding it left the pin with
    // no metadata to read on the ordinary first discussion. (Codex and both
    // assessors, #124 round 1.)
    const ran = roundsRun(dir);
    const earlier = kind === "discuss" ? ran : ran.filter((n) => n !== round);

    // --- a scope exchange is the FIRST exchange, and now it has to be --------
    //
    // The scope branch derived its ordering from `--plan` being absent, so it
    // was blind to exchanges that had already run. Started through the
    // supported no-scope path, a mistaken late `--kind scope` was accepted and
    // told the other party "There is no plan file and no earlier exchange"
    // while an accepted assessment sat in the same directory -- substantive
    // work dispatched on a false chronology, ending in a spurious round-0.md
    // that is then immutable (Codex and both assessors, #124 round 7, both
    // reproduced). The complement was already covered: with round-0.md present
    // the immutability refusal fires. This is the other half.
    //
    // ONE CONDITION, deliberately. The alternative -- a separate immutable
    // sequence for scope exchanges -- is the question round 5 declined and put
    // to David as a now/next/never, and it is still with him. This patch is
    // low-regret under either answer: a late scope is an operator error in the
    // current design, and the condition moves with the mechanism if he picks
    // the other one.
    if (kind === "scope") {
      const assessed = ran.filter((n) => n >= 1);
      if (assessed.length) {
        throw new Error(
          `the scope exchange comes before the plan, and assessment(s) ${assessed.join(", ")} have already run for ` +
            `this slug. Asking it now would tell the other party there is no plan and no earlier exchange, which is ` +
            `false, and leave an immutable round-0.md recording an exchange that could not have happened. If the ` +
            `boundary changed, carry the revised oracle into the next assessment with --oracle-changed "<why>"; ` +
            `if this is genuinely new work, start a new slug.`,
        );
      }
    }

    // --- assessment rounds go up by one, and this is what makes that true ---
    //
    // THE INVARIANT WAS ALWAYS RELIED ON AND NEVER STATED. Round numbers are
    // typed by hand, and `Math.max` over them is a proxy for "the most recently
    // run exchange" that holds only while they are assigned monotonically. Run
    // 1, then 3, then 2, and a later round 4 hands the reader exchange 3's
    // snapshot while the most recent exchange was 2 -- a generation stale,
    // silently, in the one paragraph that tells the reader what changed
    // (measured by the Fable assessor, #124 round 4).
    //
    // A REFUSAL RATHER THAN A COMPENSATION. Bounding the predecessor to
    // `n < round` was the reviewer's proposal and it is worse: measured, it
    // picks round 1 for the round-2 case (staler than what it replaces) and
    // leaves the round-4 case untouched. Removing the ambiguity beats reading
    // around it. If this ever blocks a real workflow the fallback is
    // `meta.finishedAt`, which every meta already carries -- never `n < round`.
    //
    // AN ALREADY-ACCEPTED ROUND SKIPS THIS, so it still meets the refusal that
    // is actually about it -- "an accepted assessment is never replaced" names
    // the ledger entry that cites the file, which is the thing at stake there.
    // A sequencing message would be true and less useful. That same clause is
    // what exempts the documented "returning to an existing plan" recipe, which
    // rereads MY copy of an ALREADY-ACCEPTED round and creates no exchange.
    //
    // A CLAUDE PREVIEW IS NOT EXEMPT, and the guard used to say otherwise.
    // `myReread` is `--prompt-only && role === "claude"` -- EVERY preview, not
    // the accepted-round reread the paragraph above describes -- so it waved
    // through a preview of any number at all: with only round 1 accepted,
    // `--round 3 --role claude --prompt-only` composed a package headed "This
    // is assessment 3" while the Astra dispatch of that same number was refused
    // as out of order. The exemption the recipe actually needs is the
    // `ran.includes` clause beside it, which is why removing this one costs
    // that path nothing. A preview of the NEXT round still passes, because it
    // is next. (Codex, #124 round 8 `4045616282`; both assessors concurred, and
    // the Fable assessment supplied the re-seeding of the predecessor test that
    // had staged this very scenario as a success.)
    if (kind === "assess" && !ran.includes(round)) {
      const next = Math.max(0, ...ran) + 1;
      if (round !== next) {
        throw new Error(
          `--round ${round} is not the next assessment: ${ran.length ? `exchange(s) ${ran.join(", ")} have run` : "nothing has run yet"}, ` +
            `so the next one is ${next}. Assessment rounds go up by one, because the loop reads the highest ` +
            `number as the most recent exchange -- a gap filled in later would brief the other party against a ` +
            `stale revision and say nothing. A failed or drifted exchange leaves no round-${round}.md, so re-running ` +
            `it keeps its own number.`,
        );
      }
    }

    // --- oracle -----------------------------------------------------------
    let oraclePath = null;
    if (flags.oracle) {
      oraclePath = path.relative(root, path.resolve(root, flags.oracle));
      assertIgnored(root, oraclePath, git, "oracle");
    }
    const oracleText = flags.oracle ? fs.readFileSync(path.join(root, oraclePath), "utf8") : null;
    const oracle = oracleFrom({ oracleText, planText });
    const pin = pinOracle(dir, oracle, { changedReason: flags.oracleChanged ?? null });

    // --- tier -------------------------------------------------------------
    let tier = null;
    if (kind !== "scope") {
      if (!flags.tier) {
        throw new Error(
          `--tier is required except for the scope exchange (${TIERS.join(" | ")}). The planning loop takes the ` +
            `tier of what it plans, and the tier names who bears the consequence.`,
        );
      }
      if (!TIERS.includes(flags.tier)) throw new Error(`--tier must be one of ${TIERS.join(", ")}`);
      assertTierPinned(dir, earlier, flags.tier);
      tier = flags.tier;
    }

    // --- the concern ledger -----------------------------------------------
    //
    // DEFAULTED INSIDE THE PROTECTED DIRECTORY, so the common case needs no flag
    // and cannot be exposed. A caller who points it elsewhere gets the same
    // publication check every other input gets: the ledger carries every
    // concern's full reasoning, which is the plan's most sensitive material in
    // a file that looks like bookkeeping.
    const ledgerPath = flags.ledger
      ? path.relative(root, path.resolve(root, flags.ledger))
      : path.relative(root, path.join(dir, "concerns.json"));
    if (flags.ledger && flags.noLedger) throw new Error("--ledger and --no-ledger contradict each other");
    if (flags.ledger) assertIgnored(root, ledgerPath, git, "ledger");
    const ledgerAbs = path.join(root, ledgerPath);

    let concerns = [];
    if (fs.existsSync(ledgerAbs)) {
      concerns = normalizeLedger(JSON.parse(fs.readFileSync(ledgerAbs, "utf8")));
    } else if (flags.ledger) {
      // AN EXPLICIT --ledger IS AN ASSERTION THAT THE FILE EXISTS. The
      // interface already distinguishes all three states -- the default path,
      // an explicit path, and --no-ledger for "there are genuinely none" -- so
      // a non-existent explicit path is the one combination it has no reading
      // for. It used to be read as an empty ledger on a first exchange, which
      // is indistinguishable from a legitimate clean start: an operator who
      // typed --ledger BECAUSE they had concerns to carry in, and mistyped it,
      // got a package reporting zero and no way to notice (Codex and both
      // assessors, #124 round 7; the reviewer and the Fable assessor each
      // reproduced it).
      throw new Error(
        `--ledger ${flags.ledger} does not exist at ${path.join(root, ledgerPath)}. An explicit --ledger says ` +
          `the file is there; omit it to use ${path.relative(root, path.join(dir, "concerns.json"))}, or pass ` +
          `--no-ledger when the earlier exchanges genuinely raised nothing.`,
      );
    } else if ((earlier.length || kind === "discuss") && !flags.noLedger) {
      // A ledger that is absent after an exchange has run is the failure this
      // loop most needs to refuse: continuity lives here now, so a missing file
      // is not "no concerns yet", it is every concern forgotten at once.
      throw new Error(
        `no concern ledger at ${ledgerPath}, and ${kind === "discuss" ? "a discussion always has concerns to argue about" : `exchange(s) ${earlier.join(", ")} already ran for this plan`}. ` +
          `Continuity lives in that file: a JSON array of {id, title, state, source, concern, proposed?, evidence?, ` +
          `response?, david?} with state one of ${CONCERN_STATES.join(" | ")}. Pass --no-ledger only when the ` +
          `earlier exchanges genuinely raised nothing.`,
      );
    }

    const selected = kind === "discuss" ? flags.concerns.split(",").map((s) => s.trim()).filter(Boolean) : [];
    if (kind === "discuss") {
      const known = new Set(concerns.map((c) => c.id));
      const missing = selected.filter((id) => !known.has(id));
      if (missing.length) {
        throw new Error(
          `--concerns names ${missing.join(", ")}, which the ledger does not carry. A discussion renders the named ` +
            `concerns in full so the other party can argue about the actual reasoning; an id with nothing behind it ` +
            `asks it to argue about a label.`,
        );
      }
    }

    // --- a discussion revisits the LATEST assessment, never an older one ----
    //
    // Two valid targets for one operation. The sequential rule above is gated
    // on `kind === "assess"`, so the discuss path checked only that
    // `round-N.md` existed and that `plan-round-N.md` matched the live plan --
    // and identical plan bytes do NOT establish current reasoning, because two
    // assessments of the same plan can reach different conclusions. So
    // `--round <older>` briefed the cold peer from the older assessment while
    // the newer one, which by construction saw the same plan and more history,
    // was silently omitted; the reply then landed as
    // `round-<older>.discussion-M.md` and the ledger was updated from it.
    //
    // A REFUSAL, NOT A DERIVATION, and that is David's call (2026-09-18):
    // "Please stop trying to derive round numbers. You always know what the
    // round number is. Simply tell whatever consumer needs it what the round
    // number is." Astra had recommended deriving this from the highest accepted
    // round and dropping the flag. The evidence against it is in the recipe:
    // `<N>` appears FOUR times there -- the question file, the marker, the log
    // and this flag -- and the three shell paths are the operator's own, keyed
    // by round deliberately (a marker named by `<M>` alone collides across
    // rounds, #124 round 2). Deriving would remove one of the four uses and
    // leave three unchecked on the very value that goes stale. Checking what
    // the operator typed covers all four.
    //
    // Nothing is lost. An older concern is reopened by naming it in
    // `--concerns` on the latest round, where `renderLedger` shows it in full
    // whatever its state -- that is what the ledger's "settled is not closed"
    // design is for. (Codex, #124 round 9 `4049773985`; the Fable assessor
    // chose the refusal and David settled the shape.)
    if (kind === "discuss") {
      // `roundsRun` counts `round-0.md`, the scope exchange, which is not an
      // assessment and can never be the target of a discussion.
      const assessed = ran.filter((n) => n >= 1);
      const latest = Math.max(0, ...assessed);
      if (latest > 0 && round !== latest) {
        throw new Error(
          `--round ${round} is not the latest assessment: ${latest} has since run, so a discussion of ${round} ` +
            `would brief the other party from superseded reasoning while ${latest} -- which saw this same plan and ` +
            `more history -- is left out, and the ledger would then be updated from the older answer. Discuss ` +
            `round ${latest}. To reopen something raised earlier, name its concern id in --concerns: the ledger ` +
            `renders a selected concern in full whatever state it is in, which is what carries the older reasoning ` +
            `forward.`,
        );
      }
    }

    // --- the prior assessment a discussion revisits ------------------------
    let priorAssessment = null;
    if (kind === "discuss") {
      const priorFile = assessmentPath(dir, round, discussion - 1);
      const prior = readAssessment(priorFile);
      if (prior.failed) {
        throw new Error(
          `a discussion quotes back the assessment it revisits, and ${path.relative(root, priorFile)} ${prior.reason}. ` +
            `The process answering it starts cold and remembers nothing, so without that text it would be ` +
            `reconsidering a position it cannot read.`,
        );
      }
      priorAssessment = prior.markdown;
    }

    // --- a discussion says the plan has not moved, so check that it has not --
    //
    // The discussion package tells the other party "the plan is exactly what you
    // last saw". The drift check below establishes only that the plan did not
    // change DURING this process, so an ordinary edit between the assessment and
    // the discussion made that sentence false. Worse, the snapshot that would
    // reveal it was itself rewritten by every exchange including a discussion --
    // found by the Fable assessor on #124 round 1, which is why the snapshot
    // write below is now conditional. A revised plan belongs in an assessment,
    // so this refuses rather than describing the difference.
    if (kind === "discuss") {
      const snapshot = path.join(dir, `plan-round-${round}.md`);
      if (!fs.existsSync(snapshot)) {
        throw new Error(
          `no plan snapshot at ${path.relative(root, snapshot)}, so this discussion cannot establish that the plan ` +
            `is the one round ${round} assessed. Re-run the assessment, or discuss a round whose snapshot exists.`,
        );
      }
      const assessed = fs.readFileSync(snapshot, "utf8");
      if (assessed !== planText) {
        throw new Error(
          `${planPath} has changed since round ${round} assessed it (${sha256(assessed)} -> ${sha256(planText)}). A ` +
            `discussion tells the other party the plan is exactly what it last saw, and that would be false. A ` +
            `revised plan belongs in an assessment, not a discussion: run --kind assess --round ${round + 1}.`,
        );
      }
    }

    // --- the rest ---------------------------------------------------------
    const lens = flags.lens ? flags.lens.trim().replace(/\s+/g, " ").slice(0, MAX_LENS_CHARS) : null;
    const inventory = planText ? extractFenced(planText, "affected-files") : null;
    const contract = readVerbatim(CONTRACT_PATH, root);
    const judgment = readVerbatim(JUDGMENT_PATH, root);

    // The reviewer's identity is a settled decision, so departing from it is an
    // explicit, recorded act rather than a flag nobody notices. Left open, a
    // "normal" invocation could quietly substitute a weaker model, or hand it
    // write access to the live checkout -- defeating two things this design is
    // FOR.
    const overrides = ["model", "effort", "sandbox"].filter((k) => flags[k] != null);
    const settled = defaultReviewer();
    if (overrides.length && !flags.unpinned) {
      throw new Error(
        `--${overrides.join(", --")} would depart from the settled reviewer (${settled.id}, ${settled.effort}, ` +
          `${DEFAULT_SANDBOX}). Pass --unpinned "<why>" to do it deliberately; the reason is stamped on the ` +
          `exchange, so a loop run against a weaker peer says so.`,
      );
    }
    const model = flags.model ?? settled.id;
    const effort = flags.effort ?? settled.effort;
    const sandbox = flags.sandbox ?? DEFAULT_SANDBOX;
    if (!SANDBOXES.includes(sandbox)) throw new Error(`--sandbox must be one of ${SANDBOXES.join(", ")}`);
    if (sandbox === "danger-full-access") {
      throw new Error(
        `--sandbox danger-full-access is refused, with or without --unpinned. Astra reads; nothing it does needs ` +
          `to escape a sandbox. If it must run the suite, that is workspace-write on a scratch checkout.`,
      );
    }
    const timeoutMs = Number(flags.timeout ?? 2700) * 1000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`--timeout must be a positive number of seconds`);

    const outFile = assessmentPath(dir, round, discussion);
    // THE READER WRITES HERE; THE SCRIPT PROMOTES. `round-N.md` means "an
    // exchange that happened", and three consumers depend on that: `roundsRun`
    // counts it, a discussion reads it as the prior assessment, and a ledger
    // entry cites it as the durable source of a concern's reasoning. Until this
    // existed, `--output-last-message` wrote straight to the canonical path and
    // the drift and failure branches returned without touching it -- so an
    // exchange the log said did not happen left a file that all three consumers
    // treated as one. (Codex, #124 round 1; both assessors called it one
    // mechanism rather than three fixes.)
    const attemptFile = outFile.replace(/\.md$/, ".attempt.md");
    if (fs.existsSync(outFile) && !myReread) {
      // NO --force. It was removed rather than guarded: with promotion in place
      // its only remaining job is re-running an exchange that WAS accepted, and
      // its only remaining effect is deleting the file a ledger entry cites as
      // its source. The message below is already the right answer. (Fable
      // assessor's recommendation, #124 round 1; Claude chose removal over the
      // refuse-when-cited alternative, because removing a mechanism beats adding
      // a check around it.)
      // THE REMEDY SENTENCE BRANCHES ON KIND, and it has to. One refusal is
      // shared by all three kinds; its advice was written for one of them. A
      // scope exchange is fixed at round 0 and the parser refuses a --round on
      // it, so "use the next number" named an action this same program rejects
      // -- leaving deleting round-0.md as the only visible way out, which is
      // the exact loss this refusal exists to prevent (Codex and both
      // assessors, #124 round 5). A message that invites a destructive
      // workaround is worse than one that names nothing.
      throw new Error(
        `${path.relative(root, outFile)} already exists, and an accepted assessment is never replaced — a ledger ` +
          `entry may cite it as the source of a concern's reasoning. ` +
          (kind === "scope"
            ? `DO NOT DELETE IT. A scope exchange is fixed at round 0, so there is no next number to use: if David ` +
              `revised the boundary, carry the revised oracle into the first assessment with --oracle-changed ` +
              `"<why>", which records the change and shows Astra the new intent. A second scope exchange under this ` +
              `slug is not supported; if you genuinely need one, start a new slug.`
            : `Use the next number.`),
      );
    }

    // --- what a later assessment is asked to compare against ---------------
    //
    // The round > 1 instruction says "the changes since you last saw it", and
    // nothing in the package supplied a previous version -- so the reader was
    // asked to judge a diff it had never been given, and would either re-derive
    // the whole plan cold or assert something about a revision it never saw
    // (Codex and both assessors, #124 round 2). The files exist; what was
    // missing was naming them. Paths rather than inlined text, so the reader's
    // evidence stays its own and the cached prefix stays stable.
    //
    // THE HIGHEST EARLIER ACCEPTED ROUND, not `round - 1`. Since the promotion
    // fix a rejected exchange leaves no `round-N.md`, and `roundsRun` lists
    // accepted rounds only -- so `Math.max(...earlier)` is the only source that
    // cannot name an exchange that did not happen.
    //
    // DEGRADES TO SILENCE. The scope exchange writes `round-0.md` but no plan
    // snapshot (there is no plan yet), so a first assessment finds no complete
    // predecessor and the package names nothing and softens the instruction to
    // match. Naming a file that is not there would be one more instance of the
    // class this fix belongs to. Scope conclusions are not lost by that: they
    // reach a later exchange through the ledger, which is the designed carrier.
    //
    // BOUNDED BELOW THE REQUESTED ROUND, which the sequential refusal above
    // makes redundant for a real run and which is load-bearing for the exempt
    // `--prompt-only` reread: rereading round 1 after round 3 must not name
    // round 3 as what round 1 was assessed against.
    let predecessor = null;
    const before = earlier.filter((n) => n < round);
    if (kind === "assess" && before.length) {
      const prev = Math.max(...before);
      const prevPlan = path.join(dir, `plan-round-${prev}.md`);
      const prevAssessment = assessmentPath(dir, prev);
      if (fs.existsSync(prevPlan) && fs.existsSync(prevAssessment)) {
        predecessor = {
          round: prev,
          plan: path.relative(root, prevPlan),
          assessment: path.relative(root, prevAssessment),
        };
      }
    }

    const packageParts = {
      role, kind, round, discussion, lens, concerns, selected,
      question: flags.question ?? null, priorAssessment, predecessor, inventory,
      reviewDir: path.relative(root, dir),
      ledgerPath,
      oracle, planPath, tier,
      contract: contract.text, judgment: judgment.text,
    };
    const prompt = assemblePackage(packageParts);

    // THE PACKAGE RECORD IS PER ROLE. Named by round alone, a `--role claude
    // --prompt-only` run overwrote `round-N.prompt.md` -- the record of what
    // Astra was actually sent -- with Claude's variant, while the meta's
    // `packageDigest` still described Astra's. (Fable assessor, #124 round 1,
    // offered as adjacent to the recipe fix and taken because the recipe is
    // being edited anyway.)
    const stem = path.basename(outFile, ".md") + (role === "claude" ? ".claude" : "");
    const promptFile = path.join(dir, `${stem}.prompt.md`);
    const metaFile = path.join(dir, `${path.basename(outFile, ".md")}.meta.json`);

    // `--prompt-only` writes the package the other party gets, so both
    // demonstrably receive the same words rather than two compositions that
    // happen to look alike.
    //
    // IT CLEARS THE DESTINATION FIRST, for the reason the code loop already
    // recorded: otherwise a retried dispatch whose reader dies before writing
    // leaves the previous attempt's file in place, and a read accepts any
    // non-empty file there. The worst instance is not a retry of the same
    // package but a re-dispatch with a CORRECTED one, after which the stale
    // file is read under a header naming the right exchange.
    if (flags.promptOnly) {
      // Reachable for astra only while no accepted assessment exists at this
      // round -- the refusal above now stops the case where this write would
      // have replaced the record of a dispatch that happened.
      fs.writeFileSync(promptFile, `${prompt}\n`);
      // IT CLEARS THE ATTEMPT PATH, NEVER THE ACCEPTED ASSESSMENT. This used to
      // delete `outFile`, which is the same continuity failure `--force` had --
      // reached through prompt generation, where nobody was looking for it.
      // Astra named it while assessing the --force finding: "Prompt generation
      // should not destroy accepted reasoning." (#124 round 1.)
      if (role === "astra") fs.rmSync(attemptFile, { force: true });
      process.stdout.write(`${prompt}\n`);
      return 0;
    }

    fs.writeFileSync(promptFile, `${prompt}\n`);

    if (flags.dryRun) {
      log(
        `planning: dry run — nothing spawned.\n` +
          `  kind      ${kind}${kind === "discuss" ? ` (round ${round}, discussion ${discussion})` : kind === "assess" ? ` ${round}` : ""}\n` +
          `  package   ${path.relative(root, promptFile)} (${prompt.length} chars)\n` +
          `  contract  ${contract.path}\n` +
          `  oracle    ${oracle.length} chars${pin.firstPin ? " (pinned now)" : pin.changed ? " (CHANGED, recorded)" : " (matches the pin)"}\n` +
          `  concerns  ${concerns.length}${selected.length ? `, ${selected.length} selected in full` : ""}\n` +
          (tier ? `  tier      ${tier}\n` : ""),
      );
      pin.commit();
      return 0;
    }

    // --- sign-in ----------------------------------------------------------
    const status = signInStatus({ run });
    if (!status.signedIn) {
      log(
        status.missingBinary
          ? `planning: no \`codex\` binary (set CODEX_BIN, or npm install @openai/codex).\n\n${SIGN_IN_INSTRUCTIONS}`
          : `planning: ${SIGN_IN_INSTRUCTIONS}\n\n  codex login status said: ${status.detail}`,
      );
      return 2;
    }

    // --- the exchange -----------------------------------------------------
    //
    // ONE ATTEMPT. The old file re-asked once, because a schema-invalid answer
    // was a shape problem worth one correction. There is no schema now: the
    // answer is prose, there is nothing for it to violate, and re-asking a
    // reader that crashed spends another full timeout telling it to fix output
    // that does not exist.
    fs.rmSync(attemptFile, { force: true });
    log(`planning: ${kind} ${kind === "discuss" ? `${round}.${discussion}` : round} on ${model} (${effort}, ${sandbox})…`);
    const outcome = runCodex({ prompt, outFile: attemptFile, model, effort, sandbox, cwd: root, timeoutMs, run });

    // --- the plan must not have moved under the reader --------------------
    //
    // An exchange runs ~9-10 minutes DETACHED, and the working tree stays
    // editable for every second of it. The reader opens the plan by its LIVE
    // PATH, so what it actually read is whatever the file said while it was
    // reading -- while `planSha256` below is computed from the bytes captured
    // before `codex exec` started.
    //
    // That digest is not decoration. With no commit and no PR page holding the
    // approved revision, it is the ONLY thing pinning which text David approved
    // once it reaches an implementation PR's `private-plan` block. If the file
    // moved, the digest names a document the assessment does not describe.
    //
    // So a moved plan REFUSES the exchange rather than reconciling it. Nothing
    // here can know which half of a mid-flight edit was read.
    let planDrift = null;
    if (planText !== null) {
      const abs = path.join(root, planPath);
      const after = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
      if (after === null) planDrift = { before: sha256(planText), after: null, gone: true };
      else if (after !== planText) planDrift = { before: sha256(planText), after: sha256(after), gone: false };
    }

    const read = outcome.error || outcome.status !== 0
      ? {
          failed: true,
          reason:
            `the reader exited ${outcome.status ?? "(no status)"}${outcome.signal ? ` on signal ${outcome.signal}` : ""}` +
            `${outcome.error ? `: ${outcome.error.message}` : ""}`,
        }
      : readAssessment(attemptFile);

    const meta = {
      slug, kind, round, discussion, role, model, effort, sandbox, lens,
      plan: planPath,
      planDrift,
      // `planText !== null`, never truthiness: an empty plan file is still a
      // plan, and the snapshot below is written on exactly that condition.
      planDigest: planText !== null ? sha256(planText) : null,
      // The FULL digest of the plan THIS EXCHANGE ASSESSED. It is NOT the
      // provenance pin: the redesign lets agreed edits reach David without
      // another assessment, so the last exchange's digest can predate the plan
      // he approves. The skill takes the provenance digest from the plan file at
      // the moment of approval. (Codex, #124 round 1; both assessors agreed the
      // correction belongs in the instruction, not here.)
      planSha256: planText !== null ? sha256Full(planText) : null,
      planSnapshot: planText !== null ? `plan-round-${round}.md` : null,
      oracleDigest: sha256(oracle),
      contract: contract.path,
      contractDigest: sha256(contract.text),
      judgmentDigest: sha256(judgment.text),
      packageDigest: sha256(prompt),
      concerns: concerns.map((c) => ({ id: c.id, state: c.state })),
      selected,
      tier,
      oraclePin: { pinned: pin.pinned, changed: pin.changed, firstPin: pin.firstPin, changedReason: pin.changedReason ?? null },
      // Present only when the exchange departed from the settled reviewer, so
      // its absence is the ordinary case and its presence is loud.
      unpinned: flags.unpinned ?? null,
      seconds: outcome.seconds,
      finishedAt: new Date().toISOString(),
      accepted: !read.failed && planDrift === null,
      failure: read.failed ? read.reason : null,
    };
    // THE PLAN, SNAPSHOTTED BESIDE THE ASSESSMENT: the exact bytes that were
    // read, so a later reader of this directory is not left with a digest and
    // no document.
    // NOT ON A DISCUSSION. The snapshot belongs to the assessment: it is the
    // baseline the discussion check above compares against, so an exchange that
    // rewrote it destroyed the only record that would reveal a mismatch.
    if (planText !== null && kind !== "discuss") {
      fs.writeFileSync(path.join(dir, `plan-round-${round}.md`), planText);
    }
    fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);

    if (planDrift) {
      log(
        `planning: ${planPath} ${planDrift.gone ? "was deleted" : "changed"} while this exchange was running ` +
          `(${planDrift.before} -> ${planDrift.after ?? "gone"}). The plan was read live, so this assessment ` +
          `describes bytes that no longer exist and the digest that would pin it names a different document. ` +
          `This exchange did not happen — do not count it and do not relay it to David. Re-run it against the ` +
          `plan as it now stands. The record is at ${path.relative(root, metaFile)}, and what the reader returned ` +
          `is at ${path.relative(root, attemptFile)} — deliberately NOT at the canonical path, so nothing ` +
          `downstream mistakes it for an exchange that happened.`,
      );
      return 1;
    }

    if (read.failed) {
      log(
        `planning: the ${kind} exchange produced no assessment — ${read.reason}. This is a FAILED dispatch, not a ` +
          `quiet exchange: do not relay it to David as "nothing to report", and do not proceed on the strength of ` +
          `it. The record is at ${path.relative(root, metaFile)}. Nothing was promoted to the canonical path, so ` +
          `this exchange can simply be re-run.`,
      );
      return 1;
    }

    // PROMOTED ONLY NOW, after the drift and read checks have both passed.
    // Everything downstream keys on the canonical path meaning "accepted".
    fs.renameSync(attemptFile, outFile);
    pin.commit();
    log(
      `planning: ${path.relative(root, outFile)}\n` +
        `  kind      ${kind}${kind === "discuss" ? ` (round ${round}, discussion ${discussion})` : kind === "assess" ? ` ${round}` : ""}\n` +
        `  concerns  ${concerns.length} on the ledger${selected.length ? `, ${selected.length} in full` : ""}\n` +
        `  seconds   ${Math.round(outcome.seconds)}\n` +
        (tier ? `  tier      ${tier}\n` : "") +
        `  Nothing here decides what happens next. Read it, and state the action.\n`,
    );
    process.stdout.write(`${path.relative(root, outFile)}\n`);
    return 0;
  } catch (err) {
    log(`planning: ${err.message}`);
    return 1;
  }
}

// `pathToFileURL`, never a hand-built `file://` string: the two differ whenever
// the checkout path needs escaping, and a script that never runs exits 0.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());

export { codexBin, signInStatus, spawnSyncDefault, SIGN_IN_INSTRUCTIONS, runCodex };
