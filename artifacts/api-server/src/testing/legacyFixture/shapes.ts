/**
 * The stored jsonb shapes the legacy fixture exports, each with the schema it
 * is walked against, the path rules that override the walker's defaults, and
 * the validator its output must still satisfy (plan D4's table).
 *
 * Where the product has a runtime validator it is used directly. Where a shape
 * exists only as a TypeScript interface, a fixture-local projection schema
 * below mirrors that interface field for field, with its source cited; it is
 * used for walking and checking only and never parses a value into the output.
 */
import { z, type ZodTypeAny } from "zod";
import {
  OVERRIDABLE_PATHS,
  factEnrichmentBase,
  imagePromptPlanWireSchema,
  isOverridablePath,
  manualOverrideSchema,
  processingSignatureSchema,
  validateEnrichment,
  visualConceptCandidatesBlobSchema,
  visualPromptStrategyOverrideSchema,
  visualRenderApprovalWaiverSchema,
} from "@workspace/api-zod";

import { ImageSourceSchema, TextOptionsSchema } from "../../lib/validators/memeBuilder";
import { ShapeStop, rerootRules, structuralDeep, walk, type PathRules, type WalkContext } from "./walker";

export type ShapeName =
  | "config"
  | "processingSignature"
  | "factEnrichment"
  | "enrichmentOverrides"
  | "overrideValue"
  | "visualStrategyOverride"
  | "visualConceptCandidatesBlob"
  | "aiScenePrompts"
  | "aiMemeImages"
  | "factPexelsImages"
  | "visualPlan"
  | "compiledPrompt"
  | "renderControls"
  | "identityPolicy"
  | "sourceImageAnalysis"
  | "subjectFactCompatibility"
  | "visualRenderApprovalWaiver"
  | "imageSource"
  | "textOptions"
  | "framingTransform"
  | "reviewHashtags";

/** Extra row-level inputs a shape may need beyond the walk context. */
export interface ShapeRow {
  /** The enrichment_override_history row's `path`, for `overrideValue`. */
  overridePath?: string;
}

export interface ShapeDef {
  /** Walk the stored value and return the transformed value. */
  transform(value: unknown, ctx: WalkContext, row: ShapeRow): unknown;
  /**
   * The validator the output must satisfy, as an error string or null. A shape
   * whose SOURCE value fails its validator must fail it on the output too and
   * vice versa — the exporter compares the two outcomes, so a legacy row that
   * never validated is not "fixed" and a valid one is not broken.
   */
  validate?(value: unknown, row: ShapeRow): string | null;
}

const issues = (r: { success: boolean; error?: { issues: Array<{ path: (string | number)[]; message: string }> } }) =>
  r.success ? null : r.error!.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

// ─── factEnrichment (taxonomy.ts:504-577) ──────────────────────────────────

/**
 * The enrichment blob's overrides of the walker's defaults. Enum fields need
 * no rule: the walker keeps an enum leaf. Strings listed `keep` are version
 * stamps, identifiers and timestamps; everything else that is a plain string
 * becomes prose.
 */
const VSO = "visualPromptStrategyOverride";
export const FACT_ENRICHMENT_RULES: PathRules = {
  "modifiers[*]": "keep", // render-modifier identifiers from a fixed vocabulary
  suggestedHashtags: "hashtags",
  aiGenerationId: "keep",
  taxonomyVersion: "keep",
  classificationPromptVersion: "keep",
  enrichedAt: "keep",
  enrichedBy: "keep", // "openai" | "admin" (factEnrichment.ts:143; taxonomyHealth/index.ts:350)
  "classificationPromptDiagnostics.hash": "keep",
  "classificationPromptDiagnostics.codeDefaultHash": "keep",
  "culturalReferences[*].researchedAt": "keep",
  "culturalReferences[*].researchSources[*].url": "fixture-url",
  // Stale preview keys old blobs still carry; "simply dropped on the next validate/save" (taxonomy.ts:494-503).
  visualPromptPreview: "prose-deep",
  previewStatus: "keep",
  [`${VSO}.updatedBy`]: "admin-label", // a display name or email (enrichmentOverrideLayers.ts:64-75)
  // The retired enable toggle older blobs still carry: "the enable toggle was retired" (moderationStaging.ts:233-235).
  [`${VSO}.enabled`]: "keep",
  [`${VSO}.updatedAt`]: "keep",
  [`${VSO}.roleBindings[*].entity`]: "subject-or-prose", // "subject" is the canonical binding (visualStrategyOverride.ts:342-359)
  [`${VSO}.bubbles[*].entity`]: "subject-or-prose",
};

const factEnrichment: ShapeDef = {
  transform: (value, ctx) => walk(value, factEnrichmentBase, FACT_ENRICHMENT_RULES, ctx),
  validate: (value) => {
    const r = validateEnrichment(value);
    return r.ok ? null : r.error;
  },
};

// ─── visual-strategy override on its own (fact_enrichment_versions.visual_override) ──

const VSO_RULES = rerootRules(FACT_ENRICHMENT_RULES, VSO);
const visualStrategyOverride: ShapeDef = {
  transform: (value, ctx) => walk(value, visualPromptStrategyOverrideSchema, VSO_RULES, ctx),
  validate: (value) => issues(visualPromptStrategyOverrideSchema.safeParse(value)),
};

// ─── manual overrides (enrichmentOverrides.ts:30-57, OVERRIDABLE_PATHS) ────

function overrideValueFor(path: string, value: unknown, ctx: WalkContext, at: string): unknown {
  if (!isOverridablePath(path)) throw new ShapeStop(ctx.where, at, "an override keyed by a path OVERRIDABLE_PATHS does not name");
  const def = OVERRIDABLE_PATHS[path];
  // Each value is transformed by its path's own schema, with the enrichment rules re-rooted at that field.
  return walk(value, def.schema as ZodTypeAny, rerootRules(FACT_ENRICHMENT_RULES, def.field as string), ctx);
}

const MANUAL_OVERRIDE_RULES = (key: string): PathRules => ({
  value: { custom: (v, ctx, p) => overrideValueFor(key, v, ctx, p) },
  overriddenFrom: { custom: (v, ctx, p) => overrideValueFor(key, v, ctx, p) },
  overriddenFromHash: "rekey",
  aiGenerationId: "keep",
  createdAt: "keep",
  createdBy: "map-user", // an admin id (enrichmentOverrideLayers.ts:261)
  updatedAt: "keep",
  updatedBy: "map-user",
  reason: "prose",
  autoLinked: "keep",
});

const enrichmentOverrides: ShapeDef = {
  transform: (value, ctx) => {
    if (value === null || value === undefined) return value;
    if (typeof value !== "object" || Array.isArray(value)) throw new ShapeStop(ctx.where, "", "overrides that are not a record");
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!isOverridablePath(key)) throw new ShapeStop(ctx.where, `{${key.replace(/[^/A-Za-z]/g, "")}}`, "an override keyed by a path OVERRIDABLE_PATHS does not name");
      out[key] = walk(entry, manualOverrideSchema, MANUAL_OVERRIDE_RULES(key), ctx);
    }
    return out;
  },
  validate: (value) => {
    if (value === null || value === undefined) return null;
    const r = z.record(z.string(), manualOverrideSchema).safeParse(value);
    return issues(r);
  },
};

const overrideValue: ShapeDef = {
  transform: (value, ctx, row) => {
    if (value === null || value === undefined) return value;
    if (!row.overridePath) throw new ShapeStop(ctx.where, "", "an override-history value with no path");
    return overrideValueFor(row.overridePath, value, ctx, "");
  },
  validate: (value, row) => {
    if (value === null || value === undefined || !row.overridePath || !isOverridablePath(row.overridePath)) return null;
    return issues(OVERRIDABLE_PATHS[row.overridePath].schema.safeParse(value));
  },
};

// ─── visual concept candidates (visualConcepts.ts:196-326) ─────────────────

const visualConceptCandidatesBlob: ShapeDef = {
  transform: (value, ctx) =>
    walk(value, visualConceptCandidatesBlobSchema, {
      "candidates[*].bubbles[*].entity": "subject-or-prose",
      "candidates[*].tokenError": "prose",
      generatedAt: "keep",
      "provenance.engineId": "keep",
      "provenance.model": "keep",
      "provenance.reasoningEffort": "keep",
      "provenance.fallbackReason": "prose",
      // Restored by the loader so the freshness reader answers as on the source (predicates.ts).
      inputHash: "predicate-hash",
    }, ctx),
  validate: (value) => issues(visualConceptCandidatesBlobSchema.safeParse(value)),
};

// ─── fixture-local projections of interface-only shapes ────────────────────

/** `AiScenePrompts` (aiMemePipeline.ts:186-191). */
const aiScenePromptsProjection = z.object({
  fact_type: z.enum(["action", "abstract"]),
  male: z.string(),
  female: z.string(),
  neutral: z.string(),
});

/** `AiMemeImages` (aiMemePipeline.ts:193-197): object paths per gender; "" is a deleted slot (routes/memes.ts:1664). */
const aiMemeImagesProjection = z.object({
  male: z.array(z.string()),
  female: z.array(z.string()),
  neutral: z.array(z.string()),
}).partial();

/** `FactPexelsImages` (factImagePipeline.ts:33-43) over `PexelsPhotoEntry` (pexelsClient.ts:51-57). */
const pexelsPhotoEntryProjection = z.object({
  id: z.number(),
  url: z.string(),
  photographer: z.string().optional(),
  photographer_url: z.string().optional(),
  src: z.record(z.string(), z.string()).optional(),
});
const factPexelsImagesProjection = z.object({
  fact_type: z.enum(["action", "abstract"]),
  male: z.array(pexelsPhotoEntryProjection),
  female: z.array(pexelsPhotoEntryProjection),
  neutral: z.array(pexelsPhotoEntryProjection),
  keywords: z.object({ male: z.string(), female: z.string(), neutral: z.string() }).optional(),
});

/** `CompiledImagePrompt` (imagePrompt/types.ts:163-185) with its sections and diagnostics (types.ts:21-160). */
const compiledPromptProjection = z.object({
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  engineNotes: z.string().optional(),
  imagePrompt: z.string(),
  referenceImageUrl: z.string().optional(),
  promptBreakdown: z.array(z.object({
    id: z.string(),
    label: z.string(),
    priority: z.enum(["required", "high", "medium"]),
    status: z.enum(["included", "compressed", "dropped", "deduped", "empty"]),
    text: z.string(),
    rawText: z.string(),
    moderatorAuthored: z.boolean().optional(),
  })).optional(),
  diagnostics: z.object({
    removedPlannerProseSentences: z.array(z.object({ sentence: z.string(), reason: z.string() })),
    warnings: z.array(z.object({
      code: z.string(),
      message: z.string(),
      severity: z.enum(["info", "warning"]),
      context: z.object({ bubbleIndex: z.number().optional(), entity: z.string().optional() }).optional(),
    })),
    droppedCandidates: z.array(z.object({ source: z.string(), value: z.string(), reason: z.string() })).optional(),
    plannerProvenance: z.object({
      configuredEngineId: z.string(),
      resolvedEngineId: z.string().nullable(),
      model: z.string().nullable(),
      reasoningEffort: z.string().nullable(),
      timeoutMs: z.number(),
      fallbackReason: z.string().nullable(),
    }).optional(),
    requiredBudgetOverflow: z.object({ overBy: z.number(), totalLength: z.number(), budget: z.number() }).optional(),
  }).optional(),
});

/**
 * `RenderControlsWithRefs` (imagePromptAttempts.ts:29-49) plus the two fields
 * the generation routes persist (routes/memes.ts:1534-1537): the frozen
 * `promptIdentity` (`PromptIdentitySnapshot`, imagePrompt/promptIdentity.ts:46-53)
 * and `resolvedRenderStyle`. A key outside this list stops the run.
 */
const renderControlsProjection = z.object({
  aspectRatio: z.string(),
  negativeSpacePreference: z.string().optional(),
  contentMode: z.string(),
  fallbackSubjectGender: z.string().nullable().optional(),
  styleId: z.string().nullable().optional(),
  referenceImageUrl: z.string().nullable().optional(),
  mirrorToLegacyStorage: z.boolean().optional(),
  reviewRenderSubject: z.object({ name: z.string(), pronouns: z.string().nullable() }).optional(),
  reviewAudit: z.object({ reviewId: z.number(), adminUserId: z.string() }).optional(),
  promptIdentity: z.object({
    version: z.number(),
    name: z.string(),
    pronouns: z.string().nullable(),
    source: z.string(),
  }).optional(),
  resolvedRenderStyle: z.unknown().optional(),
});

/** `IdentityPolicy` (imagePromptGeneration.ts:190-199): render-mode and preservation flags, no names. */
const identityPolicyProjection = z.object({
  subjectRenderMode: z.string(),
  preserveHumanFace: z.boolean(),
  preserveNonhumanSubjectIdentity: z.boolean(),
  preservePhysique: z.boolean(),
  allowBodyExaggeration: z.boolean(),
  allowCostumeTransformation: z.boolean(),
  allowAnthropomorphicTransformation: z.boolean(),
  ageAndLifeStagePolicy: z.enum(["follow_fact", "ignore"]),
});

/** `SourceImageAnalysis` (imagePromptGeneration.ts:172-186) over `SourceImageDetection` (:166-170). */
const sourceImageAnalysisProjection = z.object({
  subjectKind: z.string(),
  confidence: z.string(),
  hasUsableHumanFace: z.boolean(),
  hasUsableSubject: z.boolean(),
  subjectCount: z.number(),
  subjectDescription: z.string().optional(),
  detections: z.array(z.object({
    label: z.string(),
    score: z.number(),
    box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  })).optional(),
  suggestedRenderMode: z.string(),
  warnings: z.array(z.string()),
  classificationMethod: z.string(),
  analyzerVersion: z.string(),
  sourceImageSha256: z.string().optional(),
});

/** `subjectFactCompatibilityWireSchema` (imagePromptGeneration.ts:452-456), whose enums are not exported. */
const subjectFactCompatibilityProjection = z.object({
  rating: z.string(),
  reason: z.string(),
  recommendedFallback: z.string(),
});

const plain = (schema: ZodTypeAny, rules: PathRules, check = true): ShapeDef => ({
  transform: (value, ctx) => walk(value, schema, rules, ctx),
  ...(check ? { validate: (value: unknown) => issues(schema.safeParse(value)) } : {}),
});

// ─── the registry ──────────────────────────────────────────────────────────

export const SHAPES: Record<ShapeName, ShapeDef> = {
  /** Product configuration (engines' jsonb columns): kept verbatim; the exporter's credential scan still reads it. */
  config: { transform: (value) => value },
  /** Version numbers and the engine revision (processingSignature.ts:37-48); nothing derived from content. */
  processingSignature: {
    transform: (value, ctx) => structuralDeep(value, ctx, ""),
    validate: (value) => issues(processingSignatureSchema.safeParse(value)),
  },
  factEnrichment,
  enrichmentOverrides,
  overrideValue,
  visualStrategyOverride,
  visualConceptCandidatesBlob,
  aiScenePrompts: plain(aiScenePromptsProjection, {}),
  aiMemeImages: plain(aiMemeImagesProjection, {
    "male[*]": { media: "fact-gallery" },
    "female[*]": { media: "fact-gallery" },
    "neutral[*]": { media: "fact-gallery" },
  }),
  factPexelsImages: plain(factPexelsImagesProjection, {
    "male[*].url": "fixture-url",
    "female[*].url": "fixture-url",
    "neutral[*].url": "fixture-url",
    "male[*].photographer_url": "fixture-url",
    "female[*].photographer_url": "fixture-url",
    "neutral[*].photographer_url": "fixture-url",
    "male[*].src{key}": "keep",
    "female[*].src{key}": "keep",
    "neutral[*].src{key}": "keep",
    "male[*].src{*}": "stock-data-url",
    "female[*].src{*}": "stock-data-url",
    "neutral[*].src{*}": "stock-data-url",
  }),
  visualPlan: plain(imagePromptPlanWireSchema.shape.visualPlan, {
    "archetypeApplication.subtype": "keep",
    // A planner key stored by plans newer than the wire schema (seen on dev, 2026-10-13): every string becomes prose.
    styleIntegration: "prose-deep",
  }),
  compiledPrompt: plain(compiledPromptProjection, {
    referenceImageUrl: { media: "render-reference" },
    "promptBreakdown[*].id": "keep",
    "diagnostics.removedPlannerProseSentences[*].reason": "keep",
    "diagnostics.warnings[*].code": "keep",
    "diagnostics.droppedCandidates[*].source": "keep",
    "diagnostics.droppedCandidates[*].reason": "keep",
    "diagnostics.plannerProvenance.configuredEngineId": "keep",
    "diagnostics.plannerProvenance.resolvedEngineId": "keep",
    "diagnostics.plannerProvenance.model": "keep",
    "diagnostics.plannerProvenance.reasoningEffort": "keep",
    "diagnostics.plannerProvenance.fallbackReason": "prose",
  }),
  renderControls: plain(renderControlsProjection, {
    aspectRatio: "keep",
    negativeSpacePreference: "keep",
    contentMode: "keep",
    fallbackSubjectGender: "keep",
    styleId: "keep",
    referenceImageUrl: { media: "render-reference" },
    "reviewRenderSubject.name": "keep", // a sampled preset subject, not a user (prepareAttemptInputs.ts)
    "reviewRenderSubject.pronouns": "keep",
    "reviewAudit.adminUserId": "map-user",
    promptIdentity: { custom: (v, ctx, p) => frozenIdentity(v, ctx, p) },
    resolvedRenderStyle: "keep", // a snapshot of the catalogue's look style (look_styles text), not user content
  }),
  identityPolicy: plain(identityPolicyProjection, {
    subjectRenderMode: "keep",
  }),
  sourceImageAnalysis: plain(sourceImageAnalysisProjection, {
    subjectKind: "keep",
    confidence: "keep",
    suggestedRenderMode: "keep",
    classificationMethod: "keep",
    analyzerVersion: "keep",
    sourceImageSha256: "rekey",
  }),
  subjectFactCompatibility: plain(subjectFactCompatibilityProjection, {
    rating: "keep",
    recommendedFallback: "keep",
  }),
  visualRenderApprovalWaiver: plain(visualRenderApprovalWaiverSchema, {
    waivedAt: "keep",
    waivedByAdminUserId: "map-user",
    requiredScenarioPolicyVersion: "keep",
  }),
  imageSource: plain(ImageSourceSchema, {
    templateId: "keep",
    uploadKey: { media: "meme-upload-source" },
    photoUrl: "stock-data-url",
    photographerName: "prose",
  }),
  textOptions: plain(TextOptionsSchema, {
    color: "keep",
    outlineColor: "keep",
    fontFamily: "keep",
  }),
  framingTransform: { transform: (value, ctx) => structuralDeep(value, ctx, "") },
  reviewHashtags: { transform: (value, ctx) => (value == null ? value : ctx.keptText ? value : [...ctx.placeholderHashtags]) },
};

/**
 * The frozen prompt identity (`PromptIdentitySnapshot`, promptIdentity.ts:46-53).
 * Its sources are "user" (the attempt's own user — a real name), or a sampled
 * or canonical preset ("review_sample", "eval_sample", "workbench",
 * "canonical_fallback"). Only a "user" name is replaced, by the attempt user's
 * synthetic name; the snapshot's structure and presence are kept, so the
 * worker's frozen-versus-legacy precedence (imagePromptJobs.ts:464-466) holds.
 */
function frozenIdentity(value: unknown, ctx: WalkContext, path: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object" || Array.isArray(value)) throw new ShapeStop(ctx.where, path, "a frozen identity that is not an object");
  const v = value as Record<string, unknown>;
  for (const k of Object.keys(v)) {
    if (!["version", "name", "pronouns", "source"].includes(k)) throw new ShapeStop(ctx.where, `${path}.${k}`, "a key the frozen identity does not describe");
  }
  if (v.source === "user" && typeof v.name === "string" && v.name.trim()) return { ...v, name: ctx.syntheticName };
  if (typeof v.source !== "string" || !["user", "review_sample", "eval_sample", "workbench", "canonical_fallback"].includes(v.source)) {
    throw new ShapeStop(ctx.where, `${path}.source`, "a frozen identity source the fixture does not know");
  }
  return v;
}
