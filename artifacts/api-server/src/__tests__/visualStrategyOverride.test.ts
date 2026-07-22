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
  collectRenderedTextEntries,
  isVisualStrategyRenderedTextPath,
  getVisualStrategyRenderedTextKind,
  setRenderedTextAtPath,
  normalizeRoleEntity,
  serializeLiteralPromptString,
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
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
        roleBindings: [{ entity: "dog", visualRole: "{NAME_POSSESSIVE} loyal companion" }],
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

  it("canonicalizes name-token aliases in roleBindings.visualRole (rendered + validated field)", () => {
    const res = visualPromptStrategyOverrideSchema.safeParse(
      makeOverride({ roleBindings: [{ entity: "mother", visualRole: "{name} as a baby" }] }),
    );
    assert.equal(res.success, true);
    if (res.success) {
      assert.deepEqual(res.data.roleBindings, [{ entity: "mother", visualRole: "{NAME} as a baby" }]);
    }
  });

  it("rejects a personalization token in roleBindings.entity with a path-specific, machine-recognizable issue", () => {
    const res = visualPromptStrategyOverrideSchema.safeParse(
      makeOverride({ roleBindings: [{ entity: "{name_possessive} mother", visualRole: "the mother" }] }),
    );
    assert.equal(res.success, false);
    if (!res.success) {
      const issue = res.error.issues.find(
        (i) => i.path.join(".") === "roleBindings.0.entity",
      );
      assert.ok(issue, "expected a roleBindings.0.entity issue");
      assert.match(issue!.message, /personalization tokens are not allowed/);
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

function fullOverride(): VisualPromptStrategyOverride {
  return {
    ...EMPTY_VISUAL_STRATEGY_OVERRIDE,
    coreSceneOverride: "core scene",
    subjectRealizationOverride: { mode: "normal_human", description: "realization desc" },
    requiredVisualDetails: ["req0", "req1"],
    forbiddenVisualDetails: ["forbid0"],
    roleBindings: [{ entity: "mother", visualRole: "role0" }, { entity: "subject", visualRole: "role1" }],
    compositionGuidance: ["comp0"],
    styleAgnosticPromptAdditions: ["style0"],
    negativePromptAdditions: ["neg0"],
    supportingTextPolicyOverride: { mode: "require", guidance: "support guidance" },
    violencePolicyOverride: { mode: "allow", intensity: "mild", guidance: "violence guidance" },
  };
}

describe("collectRenderedTextEntries", () => {
  it("collects every rendered-text path with the right kind, in a stable order", () => {
    const entries = collectRenderedTextEntries(fullOverride());
    assert.deepEqual(
      entries.map((e) => [e.path, e.kind]),
      [
        ["coreSceneOverride", "prose"],
        ["subjectRealizationOverride.description", "prose"],
        ["requiredVisualDetails[0]", "prose"],
        ["requiredVisualDetails[1]", "prose"],
        ["forbiddenVisualDetails[0]", "prose"],
        ["roleBindings[0].entity", "entity"],
        ["roleBindings[0].visualRole", "prose"],
        ["roleBindings[1].entity", "entity"],
        ["roleBindings[1].visualRole", "prose"],
        ["compositionGuidance[0]", "prose"],
        ["styleAgnosticPromptAdditions[0]", "prose"],
        ["negativePromptAdditions[0]", "prose"],
        ["supportingTextPolicyOverride.guidance", "prose"],
        ["violencePolicyOverride.guidance", "prose"],
      ],
    );
    const entry = entries.find((e) => e.path === "roleBindings[1].entity");
    assert.equal(entry?.value, "subject");
  });

  it("omits absent optional fields entirely", () => {
    const entries = collectRenderedTextEntries(EMPTY_VISUAL_STRATEGY_OVERRIDE);
    assert.deepEqual(entries, []);
  });

  it("never emits moderatorIntent or notesForModerator (admin-only)", () => {
    const ov: VisualPromptStrategyOverride = {
      ...EMPTY_VISUAL_STRATEGY_OVERRIDE,
      moderatorIntent: "secret admin note",
      notesForModerator: "another secret note",
    };
    const entries = collectRenderedTextEntries(ov);
    assert.deepEqual(entries, []);
  });
});

describe("isVisualStrategyRenderedTextPath / getVisualStrategyRenderedTextKind", () => {
  it("accepts every path collectRenderedTextEntries can produce", () => {
    for (const { path, kind } of collectRenderedTextEntries(fullOverride())) {
      assert.equal(isVisualStrategyRenderedTextPath(path), true, path);
      assert.equal(getVisualStrategyRenderedTextKind(path), kind, path);
    }
  });

  it("rejects an unknown or forged path", () => {
    for (const bad of ["moderatorIntent", "notesForModerator", "roleBindings[0].nickname", "__proto__", ""]) {
      assert.equal(isVisualStrategyRenderedTextPath(bad), false, bad);
      assert.equal(getVisualStrategyRenderedTextKind(bad), null, bad);
    }
  });

  it("maps roleBindings[i].entity to 'entity' and everything else to 'prose'", () => {
    assert.equal(getVisualStrategyRenderedTextKind("roleBindings[3].entity"), "entity");
    assert.equal(getVisualStrategyRenderedTextKind("roleBindings[3].visualRole"), "prose");
    assert.equal(getVisualStrategyRenderedTextKind("coreSceneOverride"), "prose");
  });
});

describe("setRenderedTextAtPath", () => {
  it("updates only the target path, leaving every other field untouched", () => {
    const ov = fullOverride();
    const next = setRenderedTextAtPath(ov, "requiredVisualDetails[1]", "updated req1");
    assert.equal(next.requiredVisualDetails[1], "updated req1");
    assert.equal(next.requiredVisualDetails[0], "req0");
    assert.equal(next.coreSceneOverride, ov.coreSceneOverride);
    assert.notEqual(next, ov); // new object
  });

  it("updates a role-binding entity/visualRole independently", () => {
    const ov = fullOverride();
    const next = setRenderedTextAtPath(ov, "roleBindings[0].entity", "subject");
    assert.equal(next.roleBindings[0].entity, "subject");
    assert.equal(next.roleBindings[0].visualRole, "role0");
    assert.equal(next.roleBindings[1].entity, "subject");
  });

  it("updates the optional single-field paths when present", () => {
    const ov = fullOverride();
    assert.equal(setRenderedTextAtPath(ov, "coreSceneOverride", "new scene").coreSceneOverride, "new scene");
    assert.equal(
      setRenderedTextAtPath(ov, "subjectRealizationOverride.description", "new desc")
        .subjectRealizationOverride?.description,
      "new desc",
    );
    assert.equal(
      setRenderedTextAtPath(ov, "supportingTextPolicyOverride.guidance", "new guidance")
        .supportingTextPolicyOverride?.guidance,
      "new guidance",
    );
    assert.equal(
      setRenderedTextAtPath(ov, "violencePolicyOverride.guidance", "new guidance")
        .violencePolicyOverride?.guidance,
      "new guidance",
    );
  });

  it("is a no-op (returns ov unchanged) on an out-of-range array index", () => {
    const ov = fullOverride();
    const next = setRenderedTextAtPath(ov, "requiredVisualDetails[99]", "ghost");
    assert.equal(next, ov);
  });

  it("is a no-op on a role-binding index that isn't present", () => {
    const ov = fullOverride();
    const next = setRenderedTextAtPath(ov, "roleBindings[5].entity", "ghost");
    assert.equal(next, ov);
  });

  it("is a no-op on a single-field path whose parent object is absent", () => {
    const ov = EMPTY_VISUAL_STRATEGY_OVERRIDE;
    assert.equal(setRenderedTextAtPath(ov, "coreSceneOverride", "x"), ov);
    assert.equal(setRenderedTextAtPath(ov, "subjectRealizationOverride.description", "x"), ov);
    assert.equal(setRenderedTextAtPath(ov, "supportingTextPolicyOverride.guidance", "x"), ov);
    assert.equal(setRenderedTextAtPath(ov, "violencePolicyOverride.guidance", "x"), ov);
  });

  it("is a no-op on an unrecognized path", () => {
    const ov = fullOverride();
    assert.equal(setRenderedTextAtPath(ov, "notAField", "x"), ov);
  });
});

describe("normalizeRoleEntity", () => {
  it("passes through a plain role label unchanged", () => {
    assert.deepEqual(normalizeRoleEntity("mother", ["David Franklin"]), { value: "mother" });
  });

  it("collapses 'subject' case-insensitively to the canonical lowercase form", () => {
    assert.deepEqual(normalizeRoleEntity("SUBJECT", []), { value: "subject" });
    assert.deepEqual(normalizeRoleEntity("Subject", []), { value: "subject" });
  });

  it("collapses a typed subject name (case/whitespace-insensitive) to 'subject'", () => {
    assert.deepEqual(normalizeRoleEntity("Alex Franklin", ["Alex Franklin"]), { value: "subject" });
    assert.deepEqual(normalizeRoleEntity("  alex franklin  ", ["Alex Franklin"]), { value: "subject" });
  });

  it("rejects a personalization token with a context-free error", () => {
    const result = normalizeRoleEntity("{NAME}", ["Alex Franklin"]);
    assert.equal(result.value, "{NAME}");
    assert.match(result.error!, /personalization tokens are not allowed/);
  });

  it("does not collapse a name that isn't in subjectNames", () => {
    assert.deepEqual(normalizeRoleEntity("Alex Franklin", ["David Franklin"]), { value: "Alex Franklin" });
  });
});

// ─── Speech & thought bubbles (schema + token plumbing) ─────────────────────

describe("bubbles — schema + token plumbing", () => {
  const bubble = (partial: Record<string, unknown> = {}) => ({
    type: "speech",
    entity: "subject",
    text: "You're the man of the house now.",
    ...partial,
  });

  it("old stored blob without bubbles parses to []", () => {
    const res = visualPromptStrategyOverrideSchema.safeParse(makeOverride());
    assert.equal(res.success, true);
    if (res.success) assert.deepEqual(res.data.bubbles, []);
  });

  it("accepts up to four bubbles and rejects a fifth", () => {
    const four = visualPromptStrategyOverrideSchema.safeParse(
      makeOverride({ bubbles: [bubble(), bubble({ type: "thought" }), bubble(), bubble()] }),
    );
    assert.equal(four.success, true);
    const five = visualPromptStrategyOverrideSchema.safeParse(
      makeOverride({ bubbles: Array.from({ length: 5 }, () => bubble()) }),
    );
    assert.equal(five.success, false);
  });

  it("rejects over-cap text (81) and entity (61)", () => {
    const longText = visualPromptStrategyOverrideSchema.safeParse(
      makeOverride({ bubbles: [bubble({ text: "x".repeat(81) })] }),
    );
    assert.equal(longText.success, false);
    const longEntity = visualPromptStrategyOverrideSchema.safeParse(
      makeOverride({ bubbles: [bubble({ entity: "e".repeat(61) })] }),
    );
    assert.equal(longEntity.success, false);
  });

  it("collector yields entity + prose kinds for bubble paths, and the path→kind map agrees", () => {
    const parsed = visualPromptStrategyOverrideSchema.parse(
      makeOverride({ bubbles: [bubble(), bubble({ type: "thought", entity: "the bartender", text: "Not again." })] }),
    );
    const entries = collectRenderedTextEntries(parsed);
    const entity0 = entries.find((e) => e.path === "bubbles[0].entity");
    const text1 = entries.find((e) => e.path === "bubbles[1].text");
    assert.equal(entity0?.kind, "entity");
    assert.equal(text1?.kind, "prose");
    assert.equal(getVisualStrategyRenderedTextKind("bubbles[0].entity"), "entity");
    assert.equal(getVisualStrategyRenderedTextKind("bubbles[1].text"), "prose");
    assert.equal(isVisualStrategyRenderedTextPath("bubbles[3].text"), true);
    assert.equal(isVisualStrategyRenderedTextPath("bubbles[0].type"), false);
  });

  it("setRenderedTextAtPath writes back bubble fields and no-ops on stale indices", () => {
    const parsed = visualPromptStrategyOverrideSchema.parse(makeOverride({ bubbles: [bubble()] }));
    const updated = setRenderedTextAtPath(parsed, "bubbles[0].text", "Short.");
    assert.equal(updated.bubbles[0]?.text, "Short.");
    const stale = setRenderedTextAtPath(parsed, "bubbles[7].text", "nope");
    assert.equal(stale, parsed);
  });

  it("canonicalizes tokens and normalizes whitespace in bubble text on save", () => {
    const parsed = visualPromptStrategyOverrideSchema.parse(
      makeOverride({ bubbles: [bubble({ text: "  {name}   said\n\tthis  " })] }),
    );
    assert.equal(parsed.bubbles[0]?.text, "{NAME} said this");
  });

  it("rejects a personalization token in a bubble entity with the exact machine-recognizable issue", () => {
    const res = visualPromptStrategyOverrideSchema.safeParse(
      makeOverride({ bubbles: [bubble({ entity: "{NAME}" })] }),
    );
    assert.equal(res.success, false);
    if (!res.success) {
      const issue = res.error.issues.find(
        (i) => JSON.stringify(i.path) === JSON.stringify(["bubbles", 0, "entity"]),
      );
      assert.ok(issue, "issue must be at bubbles[0].entity");
      assert.match(issue!.message, /personalization tokens are not allowed here/);
    }
  });

  it("counts bubbles as renderable content", () => {
    const parsed = visualPromptStrategyOverrideSchema.parse(makeOverride({ bubbles: [bubble()] }));
    assert.equal(hasRenderableVisualStrategyOverrideContent(parsed), true);
  });

  it("round-trips a bubble-bearing override through the schema unchanged", () => {
    const parsed = visualPromptStrategyOverrideSchema.parse(
      makeOverride({ bubbles: [bubble({ type: "thought", entity: "the bartender", text: "Not again." })] }),
    );
    const again = visualPromptStrategyOverrideSchema.parse(parsed);
    assert.deepEqual(again.bubbles, parsed.bubbles);
  });
});

describe("serializeLiteralPromptString", () => {
  it("wraps in double quotes and escapes embedded straight quotes + backslashes", () => {
    assert.equal(serializeLiteralPromptString('He said, "now."'), '"He said, \\"now.\\""');
    assert.equal(serializeLiteralPromptString("a\\b"), '"a\\\\b"');
  });

  it("preserves apostrophes, curly quotes, and Unicode untouched", () => {
    const input = "You're the “man” now — ¿sí?";
    assert.equal(serializeLiteralPromptString(input), `"${input}"`);
  });

  it("collapses whitespace runs and trims", () => {
    assert.equal(serializeLiteralPromptString("  a \n b\t c  "), '"a b c"');
  });
});
