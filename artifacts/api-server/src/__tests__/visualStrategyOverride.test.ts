/**
 * Phase 2 — unit tests for the moderator visual-strategy override schema +
 * render-policy resolution. Pure (no DB, no network).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  visualPromptStrategyOverrideSchema,
  canonicalizeNameToken,
  firstOverrideTokenError,
  hasRenderableVisualStrategyOverrideContent,
  resolveRenderPolicy,
  DEFAULT_RENDER_POLICY,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";

function makeOverride(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    enabled: true,
    requiredVisualDetails: [],
    forbiddenVisualDetails: [],
    roleBindings: [],
    compositionGuidance: [],
    styleAgnosticPromptAdditions: [],
    negativePromptAdditions: [],
    ...partial,
  };
}

describe("visualPromptStrategyOverrideSchema", () => {
  it("parses a valid override and defaults the lists", () => {
    const res = visualPromptStrategyOverrideSchema.safeParse({ version: 1, enabled: false });
    assert.equal(res.success, true);
    if (res.success) assert.deepEqual(res.data.requiredVisualDetails, []);
  });

  it("rejects an unknown subject-realization mode (hard enum failure)", () => {
    const res = visualPromptStrategyOverrideSchema.safeParse(
      makeOverride({ subjectRealizationOverride: { mode: "teleport", description: "x" } }),
    );
    assert.equal(res.success, false);
  });

  it("rejects a wrong version", () => {
    assert.equal(visualPromptStrategyOverrideSchema.safeParse(makeOverride({ version: 2 })).success, false);
  });

  it("rejects an invalid violence intensity", () => {
    const res = visualPromptStrategyOverrideSchema.safeParse(
      makeOverride({ violencePolicyOverride: { mode: "allow", intensity: "extreme" } }),
    );
    assert.equal(res.success, false);
  });

  it("canonicalizes {name}/{Name} → {NAME} on parse", () => {
    const res = visualPromptStrategyOverrideSchema.safeParse(
      makeOverride({ requiredVisualDetails: ["{name}'s face", "{Name} smiling"] }),
    );
    assert.equal(res.success, true);
    if (res.success) {
      assert.deepEqual(res.data.requiredVisualDetails, ["{NAME}'s face", "{NAME} smiling"]);
    }
  });

  it("rejects an unknown personalization token with a clear message", () => {
    const res = visualPromptStrategyOverrideSchema.safeParse(
      makeOverride({ forbiddenVisualDetails: ["a separate {BOGUS}"] }),
    );
    assert.equal(res.success, false);
    if (!res.success) assert.match(res.error.issues.map((i) => i.message).join(" "), /token/i);
  });

  it("accepts the known pronoun tokens", () => {
    const res = visualPromptStrategyOverrideSchema.safeParse(
      makeOverride({ requiredVisualDetails: ["{NAME} raises {POSS} fist"] }),
    );
    assert.equal(res.success, true);
  });

  it("accepts {NAME_POSSESSIVE} across the token-capable field categories", () => {
    const res = visualPromptStrategyOverrideSchema.safeParse(
      makeOverride({
        requiredVisualDetails: ["{NAME_POSSESSIVE} face on a TV"],
        subjectRealizationOverride: { mode: "normal_human", description: "{NAME_POSSESSIVE} likeness" },
        roleBindings: [{ entity: "{NAME_POSSESSIVE} dog", visualRole: "loyal companion" }],
        supportingTextPolicyOverride: { mode: "require", guidance: 'a title reading "{NAME_POSSESSIVE} Week"' },
      }),
    );
    assert.equal(res.success, true);
  });

  it("canonicalizes {name_possessive}/{Name_Possessive} → {NAME_POSSESSIVE} on parse", () => {
    const res = visualPromptStrategyOverrideSchema.safeParse(
      makeOverride({ requiredVisualDetails: ["{name_possessive} Week", "{Name_Possessive} crown"] }),
    );
    assert.equal(res.success, true);
    if (res.success) {
      assert.deepEqual(res.data.requiredVisualDetails, ["{NAME_POSSESSIVE} Week", "{NAME_POSSESSIVE} crown"]);
    }
  });

  it("coreSceneOverride is optional and canonicalizes name tokens on parse", () => {
    const absent = visualPromptStrategyOverrideSchema.safeParse(makeOverride());
    assert.equal(absent.success, true);
    if (absent.success) assert.equal(absent.data.coreSceneOverride, undefined);

    const res = visualPromptStrategyOverrideSchema.safeParse(
      makeOverride({ coreSceneOverride: "{name} rides a T-Rex through {name_possessive} office" }),
    );
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.coreSceneOverride, "{NAME} rides a T-Rex through {NAME_POSSESSIVE} office");
    }
  });

  it("rejects an unknown token inside coreSceneOverride", () => {
    const res = visualPromptStrategyOverrideSchema.safeParse(
      makeOverride({ coreSceneOverride: "a scene starring {BOGUS}" }),
    );
    assert.equal(res.success, false);
    if (!res.success) assert.match(res.error.issues.map((i) => i.message).join(" "), /token/i);
  });

  it("rejects a coreSceneOverride over the 1500-char cap", () => {
    const res = visualPromptStrategyOverrideSchema.safeParse(
      makeOverride({ coreSceneOverride: "x".repeat(1501) }),
    );
    assert.equal(res.success, false);
  });

  it("canonicalizes name-token aliases in roleBindings.entity (rendered + validated field)", () => {
    const res = visualPromptStrategyOverrideSchema.safeParse(
      makeOverride({ roleBindings: [{ entity: "{name_possessive} mother", visualRole: "{name} as a baby" }] }),
    );
    assert.equal(res.success, true);
    if (res.success) {
      assert.deepEqual(res.data.roleBindings, [{ entity: "{NAME_POSSESSIVE} mother", visualRole: "{NAME} as a baby" }]);
    }
  });
});

describe("token helpers", () => {
  it("canonicalizeNameToken only touches name-case variants", () => {
    assert.equal(canonicalizeNameToken("{name} {Name} {NAME} {POSS}"), "{NAME} {NAME} {NAME} {POSS}");
  });

  it("canonicalizeNameToken normalizes possessive aliases without disturbing pronoun tokens", () => {
    assert.equal(
      canonicalizeNameToken("{name_possessive} {Name_Possessive} {NAME_POSSESSIVE} {POSS}"),
      "{NAME_POSSESSIVE} {NAME_POSSESSIVE} {NAME_POSSESSIVE} {POSS}",
    );
  });

  it("canonicalizeNameToken folds all-lowercase pronoun tokens to their ALL-CAPS form", () => {
    assert.equal(
      canonicalizeNameToken("{poss} {subj} {obj} {poss_pro} {refl}"),
      "{POSS} {SUBJ} {OBJ} {POSS_PRO} {REFL}",
    );
  });

  it("canonicalizeNameToken leaves Title-case (capitalized-output) and ALL-CAPS pronoun tokens untouched", () => {
    assert.equal(canonicalizeNameToken("{Poss} {POSS} {Subj} {Poss_Pro}"), "{Poss} {POSS} {Subj} {Poss_Pro}");
  });

  it("firstOverrideTokenError skips empty entries and flags unknown tokens", () => {
    const ok = makeOverride({ requiredVisualDetails: ["", "  ", "plain text", "{NAME} ok"] }) as unknown as VisualPromptStrategyOverride;
    assert.equal(firstOverrideTokenError(ok), null);
    const bad = makeOverride({ compositionGuidance: ["{NOPE}"] }) as unknown as VisualPromptStrategyOverride;
    assert.ok(firstOverrideTokenError(bad));
  });
});

describe("hasRenderableVisualStrategyOverrideContent", () => {
  const asOv = (partial: Record<string, unknown>) => makeOverride(partial) as unknown as VisualPromptStrategyOverride;

  it("counts coreSceneOverride as renderable content", () => {
    assert.equal(hasRenderableVisualStrategyOverrideContent(asOv({})), false);
    assert.equal(hasRenderableVisualStrategyOverrideContent(asOv({ coreSceneOverride: "  " })), false);
    assert.equal(hasRenderableVisualStrategyOverrideContent(asOv({ coreSceneOverride: "{NAME} on a throne" })), true);
  });

  it("ignores admin-only fields (moderatorIntent, notesForModerator)", () => {
    assert.equal(
      hasRenderableVisualStrategyOverrideContent(asOv({ moderatorIntent: "why I overrode", notesForModerator: "note" })),
      false,
    );
  });

  it("counts policy overrides and non-default subject realization", () => {
    assert.equal(
      hasRenderableVisualStrategyOverrideContent(asOv({ violencePolicyOverride: { mode: "soften", intensity: "mild" } })),
      true,
    );
    assert.equal(
      hasRenderableVisualStrategyOverrideContent(asOv({ subjectRealizationOverride: { mode: "use_ai_plan", description: "" } })),
      false,
    );
    assert.equal(
      hasRenderableVisualStrategyOverrideContent(asOv({ subjectRealizationOverride: { mode: "subject_as_object", description: "" } })),
      true,
    );
  });
});

describe("resolveRenderPolicy", () => {
  it("returns the default when there is no override or it is disabled", () => {
    assert.deepEqual(resolveRenderPolicy(null), DEFAULT_RENDER_POLICY);
    assert.deepEqual(resolveRenderPolicy({}), DEFAULT_RENDER_POLICY);
    const disabled = makeOverride({ enabled: false }) as unknown as VisualPromptStrategyOverride;
    assert.deepEqual(resolveRenderPolicy({ visualPromptStrategyOverride: disabled }), DEFAULT_RENDER_POLICY);
  });

  it("applies the moderator text + violence overrides when enabled", () => {
    const ov = makeOverride({
      supportingTextPolicyOverride: { mode: "require", guidance: "show the title" },
      violencePolicyOverride: { mode: "allow", intensity: "strong", guidance: "visible aftermath" },
    }) as unknown as VisualPromptStrategyOverride;
    const policy = resolveRenderPolicy({ visualPromptStrategyOverride: ov });
    assert.deepEqual(policy.supportingText, { mode: "require", guidance: "show the title" });
    assert.deepEqual(policy.violence, { mode: "allow", intensity: "strong", guidance: "visible aftermath" });
  });

  it("falls back to default per-axis when only one override axis is set", () => {
    const ov = makeOverride({ supportingTextPolicyOverride: { mode: "forbid" } }) as unknown as VisualPromptStrategyOverride;
    const policy = resolveRenderPolicy({ visualPromptStrategyOverride: ov });
    assert.equal(policy.supportingText.mode, "forbid");
    assert.deepEqual(policy.violence, DEFAULT_RENDER_POLICY.violence);
  });
});
