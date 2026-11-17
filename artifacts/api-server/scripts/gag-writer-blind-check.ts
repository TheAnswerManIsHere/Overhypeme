/**
 * The blind check of plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md (1A):
 * does the gag writer write ideas as good when it is given the fact and the
 * approved humor note only, with the reference meanings carried in the note,
 * as when it is also given the classification's meanings and joke-mechanism
 * line (today's request)?
 *
 * For each fact it runs the gag writer twice, with today's locked prompt in
 * both arms, so the only difference is the request:
 *   - "today":   the request exactly as the product sends it now;
 *   - "reduced": the classification blocks left out, and the reference
 *                meanings appended to the humor note.
 * Both arms start with no existing gags and no draft, like a new submission.
 *
 * It writes, under the output directory:
 *   - sheet.md   the judging sheet: per fact, "Set 1" and "Set 2" in an order
 *                drawn at random, with no word of which arm is which;
 *   - key.json   which set is which arm, the requests, token counts, cost and
 *                any failure. Not shown to the judge.
 * It never writes to the database. Each model call is a paid AI run.
 *
 * Usage (on the Repl, where the database and the OpenAI key are):
 *   pnpm --filter @workspace/api-server run blind-check:gag-writer -- --facts 12,34,56 --dry-run
 *   pnpm --filter @workspace/api-server run blind-check:gag-writer -- --facts 12,34,56
 *   options: --out <dir> (default <repository root>/.local/blind-check/<timestamp>)
 *
 * --dry-run builds and prints both requests per fact and calls no model.
 */

import { installStdioGuard } from "../src/lib/stdioGuard";
installStdioGuard();

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomInt } from "node:crypto";
import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { inArray } from "drizzle-orm";
import { validateEnrichment, visualConceptCandidatesBlobSchema, type StoredCandidateConcept } from "@workspace/api-zod";
import { OPENAI_PRICES } from "../src/lib/aiDouble/recorder";
import { armInputs, type Arm } from "../src/lib/visualConcepts/blindCheck";
import {
  buildVisualConceptsUserMessage,
  generateVisualConceptsWithModel,
  makeOpenAIConceptsCaller,
  resolveVisualConceptsLLMSettings,
  STAND_IN_NAME,
  withStandIn,
  type GenerateVisualConceptsInput,
  type VisualConceptsLLMSettings,
  type VisualConceptsUsage,
} from "../src/lib/visualConcepts/generator";

/** Facts run at once; each fact runs its two arms together, so twice as many calls are in flight. */
const FACT_CONCURRENCY = 4;

type Price = { input: number; output: number };

interface ArmResult {
  arm: Arm;
  request: string;
  jokeRead: string | null;
  candidates: StoredCandidateConcept[];
  usage: VisualConceptsUsage[];
  costUsd: number;
  error: string | null;
}

interface FactPlan {
  factId: number;
  factText: string;
  /** Where both arms' note came from: the approved humor note, or the gag writer's stored joke read when there is none. */
  noteSource: "humor_note" | "joke_read";
  inputs: Record<Arm, GenerateVisualConceptsInput>;
}

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

function costOf(usage: VisualConceptsUsage[], price: Price): number {
  return usage.reduce((sum, u) => sum + (u.promptTokens * price.input + u.completionTokens * price.output) / 1_000_000, 0);
}

/** Run `work` over `items`, at most `limit` at a time; results in input order. */
async function pooled<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

function ideaLines(c: StoredCandidateConcept, n: number): string[] {
  const lines = [`**Idea ${n}.** ${withStandIn(c.sceneDescription ?? "")}`];
  for (const b of c.bubbles ?? []) {
    if (!b.text?.trim()) continue;
    lines.push(`- ${b.type} bubble, ${b.entity === "subject" ? STAND_IN_NAME : b.entity}: "${withStandIn(b.text)}"`);
  }
  return lines;
}

async function loadPlans(ids: number[]): Promise<{ plans: FactPlan[]; skipped: string[] }> {
  const rows = await db
    .select({
      id: factsTable.id,
      text: factsTable.text,
      enrichment: factsTable.enrichment,
      humorNote: factsTable.humorNote,
      candidates: factsTable.visualConceptCandidates,
    })
    .from(factsTable)
    .where(inArray(factsTable.id, ids));
  const plans: FactPlan[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (!row) { skipped.push(`#${id}: no such fact`); continue; }
    // Both arms get the same note, so a fact with no approved note is still a
    // fair comparison when the gag writer's own stored reading stands in.
    const approved = row.humorNote?.trim() ?? "";
    const blob = visualConceptCandidatesBlobSchema.safeParse(row.candidates);
    const read = blob.success ? blob.data.jokeRead?.trim() ?? "" : "";
    const note = approved || read;
    if (!note) { skipped.push(`#${id}: no humor note and no stored joke read, so the reduced arm has nothing to carry the meanings`); continue; }
    const ev = validateEnrichment(row.enrichment);
    if (!ev.ok) { skipped.push(`#${id}: enrichment invalid (${ev.error}), so today's arm cannot be built`); continue; }
    plans.push({ factId: id, factText: row.text, noteSource: approved ? "humor_note" : "joke_read", inputs: armInputs(row.text, ev.data, note) });
  }
  return { plans, skipped };
}

async function runArm(arm: Arm, input: GenerateVisualConceptsInput, settings: VisualConceptsLLMSettings, price: Price): Promise<ArmResult> {
  const request = buildVisualConceptsUserMessage(input);
  const usage: VisualConceptsUsage[] = [];
  try {
    const out = await generateVisualConceptsWithModel(input, makeOpenAIConceptsCaller(settings, (u) => usage.push(u)));
    return { arm, request, jokeRead: out.jokeRead, candidates: out.candidates, usage, costUsd: costOf(usage, price), error: null };
  } catch (err) {
    return { arm, request, jokeRead: null, candidates: [], usage, costUsd: costOf(usage, price), error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const ids = (argValue("--facts") ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) {
    console.error("Give the facts to check: --facts 12,34,56");
    process.exit(2);
  }
  const dryRun = process.argv.includes("--dry-run");
  // The repository root's .local is ignored by git; the package directory's is not.
  const outDir = resolve(argValue("--out") ?? join(import.meta.dirname, "..", "..", "..", ".local", "blind-check", new Date().toISOString().replace(/[:.]/g, "-")));

  const { plans, skipped } = await loadPlans(ids);
  for (const s of skipped) console.log(`SKIPPED ${s}`);
  if (plans.length === 0) { console.error("No fact can be checked."); process.exit(1); }

  if (dryRun) {
    for (const p of plans) {
      for (const arm of ["today", "reduced"] as const) {
        console.log(`\n===== #${p.factId} — ${arm} =====\n${buildVisualConceptsUserMessage(p.inputs[arm])}`);
      }
    }
    console.log(`\nDry run: ${plans.length} fact(s), ${plans.length * 2} gag-writer calls would be made. Nothing was called.`);
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

  mkdirSync(outDir, { recursive: true });
  const sheet: string[] = ["# Gag writer blind check", "", "For each fact, which set of ideas is better: Set 1, Set 2, or the same?", ""];
  const key: unknown[] = [];
  let total = 0;

  // Both arms of a fact run together, and up to FACT_CONCURRENCY facts at once.
  const results = await pooled(plans, FACT_CONCURRENCY, async (p) => {
    const [today, reduced] = await Promise.all([
      runArm("today", p.inputs.today, settings, price),
      runArm("reduced", p.inputs.reduced, settings, price),
    ]);
    console.log(`#${p.factId}: today ${today.error ? `FAILED (${today.error})` : "ok"}, reduced ${reduced.error ? `FAILED (${reduced.error})` : "ok"}; $${(today.costUsd + reduced.costUsd).toFixed(2)}`);
    return { p, today, reduced };
  });

  for (const { p, today, reduced } of results) {
    total += today.costUsd + reduced.costUsd;
    const todayFirst = randomInt(2) === 0;
    const order = todayFirst ? [today, reduced] : [reduced, today];
    sheet.push(`## Fact #${p.factId}`, "", `> ${withStandIn(p.factText)}`, "");
    order.forEach((r, i) => {
      sheet.push(`### Set ${i + 1}`, "");
      if (r.error) sheet.push(`_This set could not be written: ${r.error}_`, "");
      r.candidates.forEach((c, n) => sheet.push(...ideaLines(c, n + 1), ""));
    });
    key.push({ factId: p.factId, noteSource: p.noteSource, set1: order[0]!.arm, set2: order[1]!.arm, arms: { today, reduced } });
  }

  writeFileSync(join(outDir, "sheet.md"), sheet.join("\n"));
  writeFileSync(join(outDir, "key.json"), JSON.stringify({ totalCostUsd: Number(total.toFixed(4)), skipped, facts: key }, null, 2));
  console.log(`\nWrote ${join(outDir, "sheet.md")} and key.json. Total cost $${total.toFixed(2)} (gag-writer calls only; the tokenizer's calls are not counted).`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename ?? "")) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => process.exit());
}
