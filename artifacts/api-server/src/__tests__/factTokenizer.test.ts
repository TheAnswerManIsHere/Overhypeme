import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  postProcessTokenizedTemplate,
  stripUnknownTokens,
  TOKENIZER_MODEL,
  TOKENIZER_REASONING_EFFORT,
  TOKENIZER_ALLOWED_MODELS,
  collapseNameSubjectConjugationPairs,
  TOKENIZE_SYSTEM_PROMPT,
  tokenizePlainTextToTemplate,
  isAlreadyTokenizedNoPlainName,
  hasNoLikelySubjectReference,
} from "../lib/factTokenizer.js";
import type { callUtilityLLM } from "../lib/utilityLLM.js";
import {
  validateTemplate,
  collapseIdenticalConjugationBranches,
  applyDeterministicGrammar,
} from "../lib/templateGrammar.js";

describe("factTokenizer — tokenizer model policy", () => {
  it("defaults to gpt-5.4-mini with low reasoning", () => {
    assert.equal(TOKENIZER_MODEL, "gpt-5.4-mini");
    assert.equal(TOKENIZER_REASONING_EFFORT, "low");
  });

  it("keeps the default model in the code-owned allowlist", () => {
    assert.ok(TOKENIZER_ALLOWED_MODELS.has(TOKENIZER_MODEL));
    // gpt-5.5 stays available as the documented escalation.
    assert.ok(TOKENIZER_ALLOWED_MODELS.has("gpt-5.5"));
  });
});

describe("factTokenizer — stripUnknownTokens", () => {
  it("strips braces from hallucinated non-tokens", () => {
    assert.equal(stripUnknownTokens("{When} {NAME} laughs"), "When {NAME} laughs");
  });

  it("preserves valid simple tokens — including {NAME_POSSESSIVE} (no allowlist drift)", () => {
    const t = "{NAME_POSSESSIVE} legend keeps growing.";
    assert.equal(stripUnknownTokens(t), t);
  });

  it("preserves conjugation pairs", () => {
    assert.equal(stripUnknownTokens("{Subj} {keeps|keep} it"), "{Subj} {keeps|keep} it");
  });
});

describe("factTokenizer — postProcessTokenizedTemplate", () => {
  it("collapses a name-subject conjugation pair, flags nameCollapsed, and touches no other flag", () => {
    const { template, nameCollapsed, conjugated, collapsed } = postProcessTokenizedTemplate(
      "When {NAME} {gives|give} you the finger, {Subj} {is|are} telling you how many seconds you have left to live.",
    );
    assert.equal(
      template,
      "When {NAME} gives you the finger, {Subj} {is|are} telling you how many seconds you have left to live.",
    );
    assert.equal(nameCollapsed, true);
    assert.equal(conjugated, false);
    assert.equal(collapsed, false);
    assert.deepEqual(validateTemplate(template), { valid: true });
  });

  it("reports nameCollapsed=false when no name-subject pair exists", () => {
    const { nameCollapsed } = postProcessTokenizedTemplate("{Subj} {keeps|keep} it");
    assert.equal(nameCollapsed, false);
  });

  it("conjugates a missed person-subject verb and flags it", () => {
    const { template, conjugated } = postProcessTokenizedTemplate(
      "{NAME} caught the Corona virus. {Subj} keeps it locked up in {POSS} back yard.",
    );
    assert.equal(
      template,
      "{NAME} caught the Corona virus. {Subj} {keeps|keep} it locked up in {POSS} back yard.",
    );
    assert.equal(conjugated, true);
    assert.deepEqual(validateTemplate(template), { valid: true });
  });

  it("preserves {NAME_POSSESSIVE} and does not conjugate when no subject token precedes the verb", () => {
    const { template, conjugated } = postProcessTokenizedTemplate("{NAME_POSSESSIVE} legend keeps growing.");
    assert.equal(template, "{NAME_POSSESSIVE} legend keeps growing.");
    assert.equal(conjugated, false);
    assert.deepEqual(validateTemplate(template), { valid: true });
  });

  it("reports conjugated=false when the template is already correct", () => {
    const { template, conjugated } = postProcessTokenizedTemplate("{Subj} {keeps|keep} it");
    assert.equal(template, "{Subj} {keeps|keep} it");
    assert.equal(conjugated, false);
  });

  it("collapses an identical conjugation branch and flags it WITHOUT touching `conjugated`", () => {
    const { template, conjugated, collapsed } = postProcessTokenizedTemplate(
      "{Subj} {can|can} fill up an electric car at a gas station.",
    );
    assert.equal(template, "{Subj} can fill up an electric car at a gas station.");
    // The collapse is its own pass — the auto-conjugation net did nothing here.
    assert.equal(conjugated, false);
    assert.equal(collapsed, true);
    assert.deepEqual(validateTemplate(template), { valid: true });
  });

  it("leaves a legitimate conjugation pair untouched (collapsed=false)", () => {
    const { template, collapsed } = postProcessTokenizedTemplate("{Subj} {is|are} unstoppable");
    assert.equal(template, "{Subj} {is|are} unstoppable");
    assert.equal(collapsed, false);
  });

  it("expands a subject-pronoun contraction and flags contractionExpanded, without touching other flags", () => {
    const { template, nameCollapsed, contractionExpanded, conjugated, collapsed } =
      postProcessTokenizedTemplate("{Subj}'s unstoppable");
    assert.equal(template, "{Subj} {is|are} unstoppable");
    assert.equal(contractionExpanded, true);
    assert.equal(nameCollapsed, false);
    assert.equal(conjugated, false);
    assert.equal(collapsed, false);
    assert.deepEqual(validateTemplate(template), { valid: true });
  });

  it("reports contractionExpanded=false when there is no subject contraction", () => {
    const { contractionExpanded } = postProcessTokenizedTemplate("{Subj} keeps it");
    assert.equal(contractionExpanded, false);
  });

  it("parity: postProcessTokenizedTemplate matches applyDeterministicGrammar(stripUnknownTokens(raw))", () => {
    const cases = [
      "When {NAME} {gives|give} you the finger, {Subj} {is|are} telling you how many seconds you have left to live.",
      "{NAME} caught the Corona virus. {Subj} keeps it locked up in {POSS} back yard.",
      "{Subj} {can|can} fill up an electric car at a gas station.",
      "{Subj}'s unstoppable and {NAME} {gives|give} you the finger.",
      "{When} {NAME} laughs",
    ];
    for (const raw of cases) {
      const { template } = postProcessTokenizedTemplate(raw);
      assert.equal(template, applyDeterministicGrammar(stripUnknownTokens(raw)));
    }
  });
});

describe("factTokenizer — TOKENIZE_SYSTEM_PROMPT policy", () => {
  it("instructs the model to never leave a bare subject-pronoun 's contraction", () => {
    assert.match(TOKENIZE_SYSTEM_PROMPT, /never valid English/i);
    assert.match(TOKENIZE_SYSTEM_PROMPT, /\{SUBJ\}\s*\{is\|are\}/);
    assert.match(TOKENIZE_SYSTEM_PROMPT, /\{SUBJ\}\s*\{has\|have\}/);
  });

  it("includes a coordinated shared-subject example and a new-subject contrast", () => {
    assert.match(TOKENIZE_SYSTEM_PROMPT, /\{runs\|run\}\s+and\s+\{hides\|hide\}/);
    assert.match(TOKENIZE_SYSTEM_PROMPT, /\{runs\|run\}\s+and\s+dogs\s+bark/);
  });
});

describe("factTokenizer — collapseNameSubjectConjugationPairs", () => {
  it("keeps the singular branch for verbs directly following {NAME}", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("When {NAME} {gives|give} you the finger"),
      "When {NAME} gives you the finger",
    );
  });

  it("handles a skippable adverb between {NAME} and the pair", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME} always {runs|run} toward danger"),
      "{NAME} always runs toward danger",
    );
  });

  it("leaves pronoun-subject pairs untouched", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("{Subj} {gives|give} you the finger"),
      "{Subj} {gives|give} you the finger",
    );
  });

  // Coordination: every verb sharing the {NAME} subject must collapse, whether
  // the first verb was wrapped or already plain.
  it("collapses coordinated pairs sharing the {NAME} subject", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME} {runs|run} and {hides|hide}"),
      "{NAME} runs and hides",
    );
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME} never {sleeps|sleep} and never {eats|eat}"),
      "{NAME} never sleeps and never eats",
    );
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME} runs and {hides|hide}"),
      "{NAME} runs and hides",
    );
  });

  it("stops the coordination chain at a pronoun subject token", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME} {runs|run} or {SUBJ} {hides|hide}"),
      "{NAME} runs or {SUBJ} {hides|hide}",
    );
  });

  // The object-separated collapse pass reaches a pair after an intervening
  // object, as long as the pair sits directly after the coordinating
  // conjunction (+ adverbs) — see templateGrammar.test.ts for the full
  // positive/negative/punctuation-boundary coverage of this pass.
  it("reaches a pair separated from {NAME} by an object, when it sits directly after the conjunction", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME} eats cake and {drinks|drink} soda"),
      "{NAME} eats cake and drinks soda",
    );
  });

  it("does not reach a pair when a noun sits between the conjunction and the pair", () => {
    const input = "{NAME} eats and dogs {barks|bark}";
    assert.equal(collapseNameSubjectConjugationPairs(input), input);
  });

  // Name possessives are not {NAME}-subject positions.
  it("never fires after possessive forms of the name", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME_POSSESSIVE} dog {barks|bark}"),
      "{NAME_POSSESSIVE} dog {barks|bark}",
    );
    assert.equal(
      collapseNameSubjectConjugationPairs("{NAME}'s dog {barks|bark}"),
      "{NAME}'s dog {barks|bark}",
    );
  });

  it("leaves non-person subjects alone", () => {
    assert.equal(
      collapseNameSubjectConjugationPairs("Sharks have a {NAME} Week."),
      "Sharks have a {NAME} Week.",
    );
  });

  it("is idempotent (running twice equals running once)", () => {
    const inputs = [
      "When {NAME} {gives|give} you the finger",
      "{NAME} {runs|run} and {hides|hide}",
      "{NAME} runs and {hides|hide}",
      "{NAME} {runs|run} or {SUBJ} {hides|hide}",
    ];
    for (const input of inputs) {
      const once = collapseNameSubjectConjugationPairs(input);
      assert.equal(collapseNameSubjectConjugationPairs(once), once);
    }
  });
});

describe("templateGrammar — collapseIdenticalConjugationBranches", () => {
  it("collapses identical branches to plain text", () => {
    assert.equal(collapseIdenticalConjugationBranches("{NAME} {can|can} fly"), "{NAME} can fly");
    assert.equal(collapseIdenticalConjugationBranches("{Subj} {won't|won't} stop"), "{Subj} won't stop");
  });

  it("collapses multiple duplicates in one template", () => {
    assert.equal(
      collapseIdenticalConjugationBranches("{NAME} {can|can} and {will|will} win"),
      "{NAME} can and will win",
    );
  });

  it("leaves legitimate (non-identical) pairs untouched", () => {
    for (const t of ["{Subj} {is|are} here", "{Subj} {has|have} it", "{NAME} {keeps|keep} going"]) {
      assert.equal(collapseIdenticalConjugationBranches(t), t);
    }
  });

  it("is idempotent and a no-op on empty/plain input", () => {
    const once = collapseIdenticalConjugationBranches("{NAME} {can|can} fly");
    assert.equal(collapseIdenticalConjugationBranches(once), once);
    assert.equal(collapseIdenticalConjugationBranches(""), "");
    assert.equal(collapseIdenticalConjugationBranches("plain text only"), "plain text only");
  });
});

function modelReturning(content: string): typeof callUtilityLLM {
  return (async () => ({ choices: [{ message: { content } }] })) as unknown as typeof callUtilityLLM;
}

describe("factTokenizer — tokenizePlainTextToTemplate (core)", () => {
  it("parses the model's template, runs the deterministic net, and validates it", async () => {
    const result = await tokenizePlainTextToTemplate("David laughs and keeps going.", {
      callModel: modelReturning(JSON.stringify({ template: "{NAME} laughs and {SUBJ} keeps going." })),
    });
    assert.equal(result.rawTemplate, "{NAME} laughs and {SUBJ} keeps going.");
    assert.equal(result.template, "{NAME} laughs and {SUBJ} {keeps|keep} going.");
    assert.equal(result.passes.conjugated, true);
    assert.equal(result.usedLlm, true);
    assert.equal(result.grammarError, undefined);
  });

  it("falls back to the raw input when the model returns malformed JSON", async () => {
    const result = await tokenizePlainTextToTemplate("plain text", {
      callModel: modelReturning("not json"),
    });
    assert.equal(result.rawTemplate, "plain text");
    assert.equal(result.template, "plain text");
  });

  it("skipLlm:true never calls the model — deterministic net only", async () => {
    let called = false;
    const callModel = (async () => { called = true; return { choices: [{ message: { content: "{}" } }] }; }) as unknown as typeof callUtilityLLM;
    const result = await tokenizePlainTextToTemplate("{Subj}'s unstoppable", { skipLlm: true, callModel });
    assert.equal(called, false);
    assert.equal(result.usedLlm, false);
    assert.equal(result.template, "{Subj} {is|are} unstoppable");
  });

  it("returns grammarError (not throw) on an invalid template, still returning the template", async () => {
    const result = await tokenizePlainTextToTemplate("x", {
      callModel: modelReturning(JSON.stringify({ template: "{NAME unmatched brace text" })),
    });
    assert.ok(result.grammarError);
    assert.match(result.grammarError!, /Unmatched opening brace/);
    assert.equal(result.template, "{NAME unmatched brace text");
  });

  it("is idempotent when re-run in skipLlm mode on already-tokenized text", async () => {
    const first = await tokenizePlainTextToTemplate("David keeps it in his back yard.", {
      callModel: modelReturning(JSON.stringify({ template: "{NAME} keeps it in {POSS} back yard." })),
    });
    const second = await tokenizePlainTextToTemplate(first.template, { skipLlm: true });
    assert.equal(second.template, first.template);
  });

  it("purpose:visual_strategy with subjectNames prepends a JSON-encoded names hint to the user message, never raw-interpolated", async () => {
    let capturedUserMessage = "";
    const callModel = (async (req: { messages: { role: string; content: string }[] }) => {
      capturedUserMessage = req.messages.find((m) => m.role === "user")?.content ?? "";
      return { choices: [{ message: { content: JSON.stringify({ template: "x" }) } }] };
    }) as unknown as typeof callUtilityLLM;
    await tokenizePlainTextToTemplate("David and his \"friend\" Alex pose together.", {
      purpose: "visual_strategy",
      subjectNames: ["David Franklin", 'Weird "Name'],
      callModel,
    });
    assert.match(capturedUserMessage, /personalized subject may be referred to/);
    assert.equal(
      capturedUserMessage.includes(JSON.stringify(["David Franklin", 'Weird "Name'])),
      true,
    );
  });

  it("caps the names hint at 10 subject names", async () => {
    let capturedUserMessage = "";
    const callModel = (async (req: { messages: { role: string; content: string }[] }) => {
      capturedUserMessage = req.messages.find((m) => m.role === "user")?.content ?? "";
      return { choices: [{ message: { content: JSON.stringify({ template: "x" }) } }] };
    }) as unknown as typeof callUtilityLLM;
    const names = Array.from({ length: 15 }, (_, i) => `Name${i}`);
    await tokenizePlainTextToTemplate("text", { purpose: "visual_strategy", subjectNames: names, callModel });
    assert.equal(capturedUserMessage.includes(JSON.stringify(names.slice(0, 10))), true);
  });

  it("omits the names hint when purpose is not visual_strategy (fact behavior unchanged)", async () => {
    let capturedUserMessage = "";
    const callModel = (async (req: { messages: { role: string; content: string }[] }) => {
      capturedUserMessage = req.messages.find((m) => m.role === "user")?.content ?? "";
      return { choices: [{ message: { content: JSON.stringify({ template: "x" }) } }] };
    }) as unknown as typeof callUtilityLLM;
    await tokenizePlainTextToTemplate("David laughs.", { subjectNames: ["David"], callModel });
    assert.equal(capturedUserMessage, 'Convert this fact to a template:\n\n"David laughs."');
  });
});

describe("factTokenizer — isAlreadyTokenizedNoPlainName", () => {
  it("true for a valid template with no plain subject-name occurrence", () => {
    assert.equal(isAlreadyTokenizedNoPlainName("{NAME} raises {POSS} fist.", ["David Franklin"]), true);
  });

  it("false when there are no braces at all", () => {
    assert.equal(isAlreadyTokenizedNoPlainName("David raises his fist.", ["David Franklin"]), false);
  });

  it("false when the template is grammatically invalid", () => {
    assert.equal(isAlreadyTokenizedNoPlainName("{BOGUS} raises a fist.", ["David Franklin"]), false);
  });

  it("false when a plain subject-name word still appears outside any brace span", () => {
    assert.equal(isAlreadyTokenizedNoPlainName("{NAME} and David pose together.", ["David Franklin"]), false);
  });

  it("does not treat {NAME} as a plain occurrence of a subject literally named 'Name'", () => {
    assert.equal(isAlreadyTokenizedNoPlainName("{NAME} raises {POSS} fist.", ["Name Framework"]), true);
  });

  it("ignores subject-name words under 3 chars (boundary)", () => {
    assert.equal(isAlreadyTokenizedNoPlainName("{NAME} and Al pose together.", ["Al Franklin"]), true);
  });

  it("is word-boundary bounded (does not false-positive on a substring)", () => {
    assert.equal(isAlreadyTokenizedNoPlainName("{NAME} loves Davidson's diner.", ["David"]), true);
  });

  it("REGRESSION (Codex): false for a MIXED template — {NAME} chip-inserted but a plain pronoun left untouched", () => {
    // Without the pronoun check, this would report "already tokenized" and
    // skip the only pass that could ever convert "his" — hardcoding the
    // pronoun forever instead of resolving it per-render.
    assert.equal(isAlreadyTokenizedNoPlainName("{NAME} holds his trophy.", ["David Franklin"]), false);
    assert.equal(isAlreadyTokenizedNoPlainName("{NAME} and her friend celebrate.", []), false);
  });
});

describe("factTokenizer — hasNoLikelySubjectReference", () => {
  it("true for an art-direction fragment with no braces, name, or pronoun", () => {
    assert.equal(hasNoLikelySubjectReference("wide-angle lens, warm golden-hour lighting", ["David Franklin"]), true);
  });

  it("false when braces are present", () => {
    assert.equal(hasNoLikelySubjectReference("{NAME} in warm lighting", ["David Franklin"]), false);
  });

  it("false when a plain subject-name word is present", () => {
    assert.equal(hasNoLikelySubjectReference("David in warm lighting", ["David Franklin"]), false);
  });

  it("false when a subject pronoun is present (he/him/his/she/her/they/them/their/reflexives)", () => {
    for (const text of [
      "he stands in warm light", "watching him from afar", "his silhouette in the doorway",
      "she leans against the wall", "watching her from afar", "her silhouette in the doorway",
      "they stand together", "watching them from afar", "their shadows merge",
      "he catches himself in the mirror", "she catches herself in the mirror",
    ]) {
      assert.equal(hasNoLikelySubjectReference(text, []), false, `expected false for: "${text}"`);
    }
  });

  it("does not treat a pronoun word inside a brace span as a plain pronoun", () => {
    assert.equal(hasNoLikelySubjectReference("{NAME} stands near a hershey bar", []), false); // braces present → false regardless
    assert.equal(hasNoLikelySubjectReference("a hershey bar on the counter", []), true); // "her" is not a whole word here
  });
});
