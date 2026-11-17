// One-off: the planned and direct compiled prompts for one fact, as a
// comparison panel would prepare them (lib/comparison/runs.ts,
// preparePanelInFlight + cellPromptText). Writes nothing to the database.
// One paid call: the planner. The direct side uses the gag's stored cast.
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { RENDER_SCENARIO_DESCRIPTORS, validateEnrichment, type FactEnrichment, type IdentityPolicy, type ReferenceIdentityType } from "@workspace/api-zod";
import { defaultScenarioRenderControls, syntheticAnalysisForReference } from "../lib/reviewRenderScenarios";
import { resolveDefaultReferenceUrl } from "../lib/defaultReferenceResolver";
import { resolveRenderReviewInput } from "../lib/imagePrompt/resolveRenderReviewInput";
import { assembleImagePromptForPreview } from "../lib/imagePrompt/preview";
import { withoutLlmRetries } from "../lib/utilityLLM";
import { compileDirect } from "../lib/imagePrompt/compilers/nanoBanana2";
import { gagRenderInput, primaryGag } from "../lib/gags/resolver";

const FACT_ID = Number(process.env.FACT_ID ?? 56);
const SCENARIO = (process.env.SCENARIO ?? "i2i_male_default") as keyof typeof RENDER_SCENARIO_DESCRIPTORS;

const [fact] = await db.select({ text: factsTable.text, enrichment: factsTable.enrichment }).from(factsTable).where(eq(factsTable.id, FACT_ID));
if (!fact) throw new Error(`no fact ${FACT_ID}`);
const pg = await primaryGag(FACT_ID);
if (!pg) throw new Error("the fact has no gag");
const gag = pg.content;
const enrichment = validateEnrichment(fact.enrichment ? gagRenderInput(fact.enrichment as FactEnrichment, gag) : fact.enrichment);
if (!enrichment.ok) throw new Error("enrichment does not validate");
const desc = RENDER_SCENARIO_DESCRIPTORS[SCENARIO];
const ref = desc.referenceIdentityType
  ? await resolveDefaultReferenceUrl(desc.referenceIdentityType as ReferenceIdentityType, { maxEdgePx: 1024 })
  : null;
const resolved = await resolveRenderReviewInput(fact.text, enrichment.data, {
  subjectRenderMode: desc.subjectRenderMode,
  sourceImageAnalysis: desc.referenceIdentityType ? syntheticAnalysisForReference(desc.referenceIdentityType as ReferenceIdentityType) : undefined,
  referenceImageUrl: ref?.url ?? null,
  referenceIdentityType: desc.referenceIdentityType,
  lookStyleId: null,
  renderControls: defaultScenarioRenderControls(),
});

const direct = compileDirect({
  gag: { scene: gag.coreSceneOverride ?? "", bubbles: gag.bubbles ?? [] },
  cast: gag.cast ?? [],
  subjectRenderMode: resolved.subjectRenderMode,
  stylePrompt: resolved.stylePrompt,
  renderControls: resolved.renderControls,
  referenceImageUrl: ref?.url ?? null,
  renderedSubject: resolved.renderedSubject,
});

const assembled = await withoutLlmRetries(() => assembleImagePromptForPreview({
  renderedFactText: resolved.renderedFactText,
  enrichment: enrichment.data,
  sourceImageAnalysis: resolved.analysis,
  subjectRenderMode: resolved.subjectRenderMode,
  userSelectedSubjectRenderMode: resolved.userSelectedSubjectRenderMode,
  identityPolicy: resolved.identityPolicy as IdentityPolicy,
  renderControls: resolved.renderControls,
  stylePrompt: resolved.stylePrompt,
  referenceImageUrl: ref?.url ?? null,
  renderedSubject: resolved.renderedSubject,
  requestId: `grenade-prompt-diff:${Date.now()}`,
}));

const out = {
  factId: FACT_ID,
  scenario: SCENARIO,
  gagId: pg.gag.id,
  renderedFactText: resolved.renderedFactText,
  gagScene: gag.coreSceneOverride ?? "",
  gagBubbles: gag.bubbles ?? [],
  gagCast: gag.cast ?? [],
  planner: { model: assembled.output.plannerProvenance?.model ?? null, fallbackReason: assembled.output.plannerProvenance?.fallbackReason ?? null },
  plannedPrompt: (assembled.compiled as { prompt?: string }).prompt ?? null,
  directPrompt: direct.prompt,
};
const fs = await import("node:fs");
fs.writeFileSync(new URL("./grenade-prompts.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("wrote grenade-prompts.json", out.plannedPrompt?.length, out.directPrompt.length);
process.exit(0);
