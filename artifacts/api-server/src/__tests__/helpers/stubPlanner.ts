/**
 * A minimal valid fact enrichment and a full planner output, for tests that
 * run the real planner-and-compiler path with the planner call stubbed
 * (`__setPlanGeneratorForTest`). Copied from the engine workbench's tests,
 * which build the same shapes inline.
 */

export const VALID_ENRICHMENT = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: ["single_subject_focus"],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: ["legendary", "strength", "feat"],
  taxonomyConfidence: 0.95,
  adminReviewNotes: "",
  culturalReferences: [],
  semanticEntities: [],
};

export function makeStubPlan(mode: "human_identity_i2i" | "t2i_fallback", promptText: string) {
  const generationMode = mode === "t2i_fallback" ? ("t2i" as const) : ("i2i" as const);
  return {
    visualPlan: {
      sceneConcept: "A superhuman feat",
      visualGoal: "Make the feat legible",
      visualApproach: "Cinematic close-up",
      archetypeApplication: {
        primaryArchetype: "superhuman_physical_feat",
        subtype: "force_scaled_action",
        selectedFrame: "direct_action",
        strategyRationale: "Authored strategy applies.",
      },
      coreScene: "The protagonist performs a superhuman feat in the foreground.",
      subjectDetails: ["confident focused expression", "mid-exertion heroic pose"],
      environment: ["dramatic stage lighting", "blurred arena background"],
      lightingAndStyle: "high-contrast cinematic key light",
      keyVisualElements: ["central subject", "dramatic lighting", "exertion pose"],
      subjectTreatment: {
        roleInScene: "Protagonist",
        subjectRenderMode: mode,
        identityPreservation: mode === "human_identity_i2i" ? "human_face" : "none",
        nonhumanSubjectTreatment: {
          applicable: false,
          subjectKind: "not_applicable",
          preserveTraits: [],
          anthropomorphicTreatment: "none",
          doNotTransformIntoHuman: false,
        },
        fallbackSubjectGender: mode === "t2i_fallback" ? "female" : "not_applicable",
        expressionAndPose: "Confident, focused",
        ageLifeStageTransform: { applies: false, targetState: "" },
      },
      subjectFactCompatibility: { rating: "strong", reason: "Stages well.", recommendedFallback: "none" },
      composition: {
        subjectFraming: "Medium close-up",
        negativeSpace: "top",
        cameraStyle: "Cinematic 35mm",
        sceneReadability: "Subject is the readable element",
      },
      supportingTextPolicy: {
        allowSupportingText: false,
        supportingTextElements: [],
        forbiddenTextTypes: [
          "full meme captions",
          "full fact text",
          "hashtags",
          "watermarks",
          "real logos",
          "brand marks",
          "long explanatory paragraphs",
        ],
      },
      secondaryCharacters: [],
      semanticEntitiesUsed: [],
      culturalReferencesUsed: [],
      styleIntegration: "Apply cinematic style",
      contentNotes: "SFW",
      debugNotes: "Strategy v2",
      targetEngine: "nano_banana_2" as const,
      generationMode,
    },
    compiledPrompt: { prompt: promptText, negativePrompt: "", engineNotes: "" },
    promptVersion: "test-prompt-v1",
    archetypeStrategyVersion: "test-strategy-v1",
    generatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    generatedBy: "openai" as const,
  };
}
