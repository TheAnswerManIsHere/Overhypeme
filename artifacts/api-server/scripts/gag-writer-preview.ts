/**
 * The gag-writer preview (plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, 1C):
 * runs the gag writer on chosen facts exactly as the product would for a new
 * submission at the Gags step — the fact, its approved humor note, the limits,
 * no existing gags and no draft — and writes the ideas to a sheet for David to
 * judge. With --system-prompt it sends a candidate prompt in place of the
 * locked one, so a revision is judged before David relocks it; the product is
 * untouched. It replaced the two-arm blind check (1A) once that had passed.
 *
 * The note: the fact's approved humor note; for a fact that has none, the
 * read of the joke its stored ideas were written with (older idea sets kept
 * one), which is what a moderator would have approved; else no note. The
 * sheet says which.
 *
 * The sheet shows each idea in the gag writer's own words, from its reply. The
 * product's second model, which converts the stand-in name to tokens, is not
 * called: a plain swap stands in for it, so no idea can be lost or reworded
 * between the writer and the judge, and the gag writer is the only model a run
 * calls. Its validation and corrective retry run as in the product.
 *
 * It writes, under the output directory, sheet.md (the ideas) and run.json
 * (the requests, the prompt's sha256, token counts, cost and any failure). It
 * never writes to the database. Each model call is a paid AI run.
 *
 * Usage (on the Repl, where the database and the OpenAI key are):
 *   pnpm --filter @workspace/api-server run preview:gag-writer -- --facts 32,34746,56 --dry-run
 *   pnpm --filter @workspace/api-server run preview:gag-writer -- --facts 32,34746,56 --system-prompt <a candidate prompt file>
 *   options: --out <dir> (default <repository root>/.local/gag-preview/<timestamp>)
 *
 * --dry-run builds and prints the request per fact and calls no model.
 */

import { installStdioGuard } from "../src/lib/stdioGuard";
installStdioGuard();

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { inArray } from "drizzle-orm";
import { candidateConceptsWireSchema, isCandidateConceptPickable, resolveRenderPolicy } from "@workspace/api-zod";
import { OPENAI_PRICES } from "../src/lib/aiDouble/recorder";
import {
  STAND_IN_NAME,
  buildVisualConceptsUserMessage,
  generateVisualConceptsWithModel,
  makeOpenAIConceptsCaller,
  resolveVisualConceptsLLMSettings,
  withStandIn,
  type GenerateVisualConceptsInput,
  type TokenizeFn,
  type VisualConceptsUsage,
} from "../src/lib/visualConcepts/generator";

/** Facts run at once. */
const CONCURRENCY = 4;

const POSSESSIVE = new RegExp(`\\b${STAND_IN_NAME}'s\\b`, "g");
const NAME = new RegExp(`\\b${STAND_IN_NAME}\\b`, "g");

/** A plain swap for the name conversion, so no second model can fail or alter an idea. */
const standInTokenize: TokenizeFn = async (text) => ({
  template: text.replace(POSSESSIVE, "{NAME_POSSESSIVE}").replace(NAME, "{NAME}"),
});

interface WriterIdea {
  title: string;
  scene: string;
  bubbles: Array<{ type: string; entity: string; text: string }>;
}

/** The ideas exactly as the gag writer wrote them in a reply; null when the reply cannot be read. */
function writerIdeas(raw: string | null): WriterIdea[] | null {
  if (raw === null) return null;
  try {
    const parsed = candidateConceptsWireSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.data.concepts.map((c) => ({
      title: c.title,
      scene: c.sceneDescription,
      bubbles: c.bubbles.map((b) => ({ type: b.type, entity: b.entity, text: b.text })),
    }));
  } catch {
    return null;
  }
}

function ideaLines(idea: WriterIdea, n: number): string[] {
  const lines = [`**Idea ${n}: ${idea.title.trim()}.** ${idea.scene.trim()}`];
  for (const b of idea.bubbles) {
    if (!b.text.trim()) continue;
    lines.push(`- ${b.type} bubble, ${b.entity === "subject" ? STAND_IN_NAME : b.entity}: "${b.text.trim()}"`);
  }
  return lines;
}

type NoteSource = "humor_note" | "stored_read" | "none";

interface FactPlan {
  factId: number;
  factText: string;
  noteSource: NoteSource;
  input: GenerateVisualConceptsInput;
}

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

/** The read of the joke an older stored idea set carries (the field left the schema at 1.2d). */
function storedRead(blob: unknown): string {
  const read = blob && typeof blob === "object" ? (blob as { jokeRead?: unknown }).jokeRead : undefined;
  return typeof read === "string" ? read.trim() : "";
}

async function loadPlans(ids: number[]): Promise<{ plans: FactPlan[]; skipped: string[] }> {
  const rows = await db
    .select({ id: factsTable.id, text: factsTable.text, humorNote: factsTable.humorNote, candidates: factsTable.visualConceptCandidates })
    .from(factsTable)
    .where(inArray(factsTable.id, ids));
  const plans: FactPlan[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (!row) { skipped.push(`#${id}: no such fact`); continue; }
    const approved = row.humorNote?.trim() ?? "";
    const read = storedRead(row.candidates);
    const note = approved || read;
    plans.push({
      factId: id,
      factText: row.text,
      noteSource: approved ? "humor_note" : read ? "stored_read" : "none",
      input: { factText: row.text, renderPolicy: resolveRenderPolicy(null), humorNote: note || null, existingGags: [], draft: null },
    });
  }
  return { plans, skipped };
}

const NOTE_LABEL: Record<NoteSource, string> = {
  humor_note: "the approved humor note",
  stored_read: "no approved note; the read of the joke stored with its older ideas",
  none: "no note",
};

async function main(): Promise<void> {
  const ids = (argValue("--facts") ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) {
    console.error("Give the facts to run: --facts 12,34,56");
    process.exit(2);
  }
  const dryRun = process.argv.includes("--dry-run");
  const promptFile = argValue("--system-prompt");
  const systemPrompt = promptFile ? readFileSync(promptFile, "utf8") : undefined;
  if (systemPrompt !== undefined && !systemPrompt.trim()) { console.error(`The candidate prompt ${promptFile} is empty.`); process.exit(2); }
  const promptSha = systemPrompt === undefined ? null : createHash("sha256").update(systemPrompt).digest("hex");
  console.log(systemPrompt === undefined ? "Prompt: the locked gag-writer prompt." : `Prompt: candidate ${promptFile}, sha256 ${promptSha}.`);
  // The repository root's .local is ignored by git; the package directory's is not.
  const outDir = resolve(argValue("--out") ?? join(import.meta.dirname, "..", "..", "..", ".local", "gag-preview", new Date().toISOString().replace(/[:.]/g, "-")));

  const { plans, skipped } = await loadPlans(ids);
  for (const s of skipped) console.log(`SKIPPED ${s}`);
  if (plans.length === 0) { console.error("No fact can be run."); process.exit(1); }

  if (dryRun) {
    for (const p of plans) console.log(`\n===== #${p.factId} (${NOTE_LABEL[p.noteSource]}) =====\n${buildVisualConceptsUserMessage(p.input)}`);
    console.log(`\nDry run: ${plans.length} gag-writer call(s) would be made. Nothing was called.`);
    return;
  }

  // Resolved once: an unusable engine or an unpriced model stops the run before any call.
  const settings = await resolveVisualConceptsLLMSettings();
  if (settings.unusableReason || !settings.model) {
    console.error(`The gag writer engine cannot be used (${settings.unusableReason ?? "no model"}). Nothing was called.`);
    process.exit(1);
  }
  const price = OPENAI_PRICES[settings.model];
  if (!price) {
    console.error(`No price is recorded for ${settings.model} (OPENAI_PRICES in aiDouble/recorder.ts), so its cost could not be reported. Nothing was called.`);
    process.exit(1);
  }
  const costOf = (usage: VisualConceptsUsage[]) =>
    usage.reduce((sum, u) => sum + (u.promptTokens * price.input + u.completionTokens * price.output) / 1_000_000, 0);

  const results: Array<Record<string, unknown> & { costUsd: number }> = new Array(plans.length);
  const sheets: string[][] = new Array(plans.length);
  let next = 0;
  const lane = async () => {
    while (next < plans.length) {
      const i = next++;
      const p = plans[i]!;
      const request = buildVisualConceptsUserMessage(p.input);
      const usage: VisualConceptsUsage[] = [];
      const call = makeOpenAIConceptsCaller(settings, (u) => usage.push(u), systemPrompt);
      // The last reply is the one accepted when generation succeeds (a corrective call replaces the first).
      let lastReply: string | null = null;
      const callAndKeep: typeof call = async (msgs) => (lastReply = await call(msgs));
      const lines = [`## Fact #${p.factId}`, "", `> ${withStandIn(p.factText)}`, "", `_Note sent: ${NOTE_LABEL[p.noteSource]}._`, ""];
      if (p.input.humorNote) lines.push(`> Note: ${p.input.humorNote.replace(/\n/g, " ")}`, "");
      let error: string | null = null;
      let unusable = 0;
      try {
        const out = await generateVisualConceptsWithModel(p.input, callAndKeep, standInTokenize);
        unusable = out.candidates.filter((c) => !isCandidateConceptPickable(c)).length;
        const ideas = writerIdeas(lastReply);
        if (!ideas) error = "the accepted reply could not be read back";
        else ideas.forEach((idea, n) => lines.push(...ideaLines(idea, n + 1), ""));
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      if (error) lines.push(`_No ideas: ${error}_`, "");
      const costUsd = costOf(usage);
      console.log(`#${p.factId}: ${error ? `FAILED (${error})` : unusable ? `ok, ${unusable} idea(s) the product could not use` : "ok"}; $${costUsd.toFixed(2)}`);
      sheets[i] = lines;
      results[i] = { factId: p.factId, noteSource: p.noteSource, request, usage, costUsd, unusable, error };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, plans.length) }, lane));

  const total = results.reduce((s, r) => s + r.costUsd, 0);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "sheet.md"), ["# Gag writer preview", "", systemPrompt === undefined ? "Prompt: the locked one." : `Prompt: ${promptFile} (sha256 ${promptSha}).`, "", ...sheets.flat()].join("\n"));
  writeFileSync(join(outDir, "run.json"), JSON.stringify({ totalCostUsd: Number(total.toFixed(4)), prompt: promptFile ? { file: promptFile, sha256: promptSha } : "locked", skipped, facts: results }, null, 2));
  console.log(`\nWrote ${join(outDir, "sheet.md")} and run.json. Total cost $${total.toFixed(2)}; the gag writer is the only model the run called.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename ?? "")) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => process.exit());
}
