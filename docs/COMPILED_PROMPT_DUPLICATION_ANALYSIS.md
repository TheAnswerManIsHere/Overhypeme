# Compiled visual prompt — duplication analysis & options

**Status:** investigation / second-opinion brief. Nothing in the prompt
assembly has been changed as a result of this analysis — the only shipped
changes are *visibility* (the component breakdown), the `{NAME}` token gate,
and `localStorage` persistence (PR #101). This doc exists so the question
"is the Visual goal / Visual approach / LLM-prose overlap actually a problem,
and if so how should we fix it?" can be handed to another reviewer (ChatGPT)
with full context.

Audience: someone who has **not** read this codebase. Everything needed to
reason about the question is inlined below.

---

## 1. What we're looking at

The product (Overhype.me) turns a "fact" about a user into a cinematic meme
image. For each render we build a single text prompt that goes to an image
engine (Google's "Nano Banana 2", an image model, via fal.ai). There are two
variants: **i2i** (image-to-image — a user's uploaded photo is the identity
source) and **t2i** (text-to-image — no photo).

The example that triggered this review is **fact #36**, rendered for the
brand-preview protagonist "David". The final compiled prompt was:

> Image-to-image edit using the reference image as the person's facial
> identity source. Preserve the reference person's recognizable face.
> **Highlight the intrinsic legendary trait of Superman through the
> juxtaposition of his iconic superhero identity with the mundane element of
> pajamas.** **Create a grounded cinematic scene that emphasizes Superman's
> heroic aura while he wears David pajamas, making the legendary attribute feel
> intrinsic to his character.** Interpret these terms exactly: "{NAME}" means
> user's name. Keep all surfaces free of readable text, captions, watermarks,
> logos, and brand marks. **Create an image of Superman wearing David pajamas,
> standing heroically in a vibrant city skyline. Emphasize his legendary status
> with a playful aura, capturing the humorous contrast between his superhero
> identity and the mundane pajamas. Ensure Superman's recognizable face is
> preserved and he appears confident with a smile.** The scene should be clear
> and engaging, with dynamic lighting that enhances the visual impact. Ensure
> these elements are clearly visible: Superman in David pajamas; Heroic pose;
> Contrasting colors. Composition: Centered; dynamic angle.

The three **bold** spans are the ones under suspicion. Note the `{NAME}` token
in there too — that leak is a **separate, already-fixed** issue (see §6); it is
not the duplication question.

---

## 2. How the prompt is built (the pipeline)

Two stages: an **LLM planner**, then a **deterministic compiler**.

### Stage A — LLM planner (`generateImagePromptPlan`)

We send the rendered fact text + the fixed taxonomy + an authored
per-archetype visual strategy to an LLM (OpenAI, structured JSON output). It
returns a `visualPlan` (engine-neutral, structured) **and** a free-text
`compiledPrompt.prompt` (a ready-to-read scene description — we call this "the
prose" below). Relevant fields of `visualPlan`:

- `visualGoal` — one sentence: *what the image must accomplish.*
- `visualApproach` — one sentence: *how to stage it.*
- `keyVisualElements[]` — 3–12 concrete things that must be visible.
- `composition` — framing, camera, negative-space side.
- `semanticEntitiesUsed[]`, `culturalReferencesUsed[]` — locked meanings of
  capitalized terms / cultural references, echoed from enrichment.
- `supportingTextPolicy` — whether any in-image text is allowed.

The key design decision (made during a prior rewrite): **the LLM's prose is
NOT the source of truth.** It is *one high-value input*. The actual engine
prompt is **assembled deterministically** from the structured plan so that the
critical, taxonomy-derived pieces are guaranteed present regardless of how the
LLM phrased the prose.

### Stage B — deterministic compiler (`compileForSubjectRenderMode`)

File: `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts`.

It builds an ordered list of **sections**, then concatenates them under a
4000-char budget, de-duplicating as it goes. Sections, in order, with priority:

| # | Section | Priority | Source |
|---|---|---|---|
| 1 | Mode preamble | required | constant per render mode (the "Image-to-image edit…" lead) |
| 2 | Required mode clauses | required | e.g. t2i fallback gender |
| 3 | **Visual goal** | required | `visualPlan.visualGoal` |
| 4 | **Visual approach** | required | `visualPlan.visualApproach` |
| 5 | Semantic referents | required | `visualPlan.semanticEntitiesUsed` |
| 6 | Cultural references | required | `visualPlan.culturalReferencesUsed` |
| 7 | Supporting-text rule | required | `visualPlan.supportingTextPolicy` |
| 8 | **LLM prose** | high (compressible) | `compiledPrompt.prompt` |
| 9 | Key visual elements (gap-fill) | high (compressible) | `visualPlan.keyVisualElements` minus anything already said |
| 10 | Composition | high | `visualPlan.composition` |
| 11 | Modifier directives | medium (compressible) | taxonomy modifiers |
| 12 | Style suffix | medium (compressible) | selected look-style |

Assembly rules (`assembleSections`):

- **required** sections always survive (even over budget; a final hard-truncate
  is the only backstop).
- **high/medium** are included while budget allows; *compressible* ones are
  trimmed to fit before being dropped.
- **De-dupe is sentence-level and EXACT** (after lowercasing, whitespace
  collapse, trailing-punctuation strip). A section's sentence is dropped only
  if an *identical normalized sentence* already appears earlier.
- The directive composers (key elements, composition) also do a
  **substring/word-boundary** "is this concept already present?" check against
  the prose before adding — but that only suppresses the *directive*, it does
  not touch the prose or the goal/approach.

Mapping the fact-#36 prompt back to sections:

- §1 preamble → "Image-to-image edit… Preserve the reference person's
  recognizable face."
- §3 **Visual goal** → "Highlight the intrinsic legendary trait of Superman
  through the juxtaposition…"
- §4 **Visual approach** → "Create a grounded cinematic scene that emphasizes
  Superman's heroic aura…"
- §5 semantic referents → "Interpret these terms exactly: …" (the `{NAME}`
  leak — now fixed)
- §7 supporting-text → "Keep all surfaces free of readable text…"
- §8 **LLM prose** → "Create an image of Superman wearing David pajamas,
  standing heroically… humorous contrast… recognizable face is preserved…"
- §9 key elements → "Ensure these elements are clearly visible: Superman in
  David pajamas; Heroic pose; Contrasting colors."
- §10 composition → "Composition: Centered; dynamic angle."

So the three suspicious spans are sections **3, 4, and 8**.

---

## 3. The concern, precisely

Sections 3 (goal), 4 (approach), and 8 (prose) all express **the same core
joke**: *Superman, a legendary hero, juxtaposed with mundane "David pajamas".*
They are not byte-identical, so the exact-sentence de-duper leaves all three
in. Concretely:

- **Goal (3):** legendary trait of Superman ↔ juxtaposition with mundane pajamas.
- **Approach (4):** grounded cinematic scene, heroic aura, wearing David pajamas,
  legendary attribute intrinsic.
- **Prose (8):** Superman in David pajamas, standing heroically, legendary
  status, humorous contrast of superhero identity vs mundane pajamas, face
  preserved, confident smile.

Two distinct sub-issues:

1. **Redundancy.** The same concept is stated three times at different
   altitudes (abstract intent → staging intent → concrete scene). For a human
   this reads repetitive. For the image model it's mostly harmless reinforcement
   but spends tokens/attention and *can* dilute the concrete instructions.

2. **A subtle tonal mismatch (the "slightly misaligned" you flagged).** The
   *approach* asks for a "**grounded** cinematic scene" with a "**heroic**
   aura"; the *prose* asks for a "**playful** aura" and "**humorous** contrast."
   Grounded/heroic vs playful/humorous is a mild tonal pull. Because goal,
   approach, and prose are generated as **independent fields by the LLM in one
   pass**, nothing forces them to agree on register, only on subject matter.

---

## 4. Why it happens (root cause, by design)

- **Goal & approach are `required` sections placed *ahead* of the prose.** That
  was deliberate: the rewrite's whole point was that the taxonomy-derived intent
  must reach the engine even if the prose is weak or gets truncated under
  budget. The cost of that guarantee is that when the prose *is* strong and
  already covers the intent, you get overlap.
- **De-dupe is exact-sentence, not semantic.** It catches "Preserve the
  reference person's recognizable face." appearing twice verbatim; it cannot
  catch "Highlight the legendary trait… juxtaposition with pajamas" vs "capturing
  the humorous contrast between his superhero identity and the mundane pajamas."
- **Goal/approach/prose are separate LLM output fields.** They're coherent on
  *subject* (the model is describing one fact) but not constrained to be
  *complementary* (one abstract, one concrete, non-overlapping) or
  *tonally identical*.

This is not a bug in the sense of "code doing the wrong thing"; it's a
consequence of three design choices interacting. Whether the resulting prompt
is *worse* for the image model is an empirical question we have not measured.

---

## 5. Is it actually a problem? (honest uncertainty)

Arguments it's **fine / leave it**:

- Modern image models tolerate — sometimes benefit from — restating the core
  concept; repetition acts as emphasis/weighting.
- The redundant spans are short relative to the 4000-char budget; we are
  nowhere near truncation on a normal fact, so nothing useful is being crowded
  out.
- The concrete instructions (key elements, composition, face preservation) are
  all still present and unambiguous.

Arguments it's **worth fixing**:

- The tonal mismatch (grounded/heroic vs playful/humorous) is a *real* conflict,
  not just repetition. An image model getting both "grounded" and "playful" may
  split the difference unpredictably.
- Three abstract restatements before the concrete scene may down-weight the
  concrete, scene-defining details by sheer volume of near-synonymous text.
- It reads unprofessional to a human inspecting prompts (you), which lowers
  trust in the pipeline even if output quality is unaffected.

**We have not A/B'd image output with vs. without the overlap.** Any claim that
it changes the rendered image is currently a hypothesis. The cheapest next step
is empirical: render the same fact a few times with the current prompt and with
a hand-trimmed prompt (goal/approach removed or merged) and compare.

---

## 6. Out of scope here (already fixed in PR #101)

- **`{NAME}` leak.** The `Interpret these terms exactly: "{NAME}" means user's
  name` clause came from a *semantic entity* in the fact's enrichment whose
  `surfaceText` is literally `{NAME}` (the enrichment was computed on the
  tokenized template). The fact text itself was already personalized to "David",
  but that echoed entity was not. Fixed by a final identity gate in the compiler
  that renders any residual `{NAME}`/`{SUBJ}`/… tokens with the same identity
  used for the fact text, just before the prompt leaves the compiler. This is
  independent of the duplication question.

---

## 7. Options for fixing the duplication (if we decide to)

Ordered roughly by blast radius. Trade-offs are the important part.

### Option A — Leave as-is (current decision)
Ship only the visibility (breakdown) so it can be judged per-fact; revisit if
output quality is actually affected.
- **Pro:** zero risk; no chance of dropping intent the prose phrased uniquely.
- **Con:** the repetition and tonal mismatch remain in every prompt.

### Option B — Demote goal/approach to a fallback
Keep goal+approach as `required` only when the prose is *thin*; when the prose
already covers them, drop or compress them. Practically: detect overlap between
goal/approach and prose; if high, omit goal/approach.
- **Pro:** removes the redundancy in the common case while preserving the
  "intent always survives" guarantee for weak-prose facts.
- **Con:** needs an overlap heuristic (semantic similarity or keyword overlap);
  a bad heuristic could drop a goal/approach that actually added something the
  prose missed. Adds a tuning knob.

### Option C — Fuzzy (near-duplicate) de-dupe across all sections
Replace exact-sentence de-dupe with similarity-based de-dupe so heavily
overlapping sentences collapse regardless of section.
- **Pro:** general; helps any future overlap, not just goal/approach/prose.
- **Con:** broadest behavior change; highest chance of trimming something we
  wanted; similarity threshold is fiddly; de-dupe order now matters a lot (what
  survives depends on which section is processed first).

### Option D — Fix at the generator (LLM contract)
Change the planner's instructions so `visualGoal`/`visualApproach` are written
**terse and explicitly non-overlapping** with the prose (e.g. "goal = one
clause naming the payoff; do not restate the scene"), and require tonal
consistency between approach and prose.
- **Pro:** fixes the *source* (including the tonal-mismatch root cause), not the
  symptom; keeps the compiler simple and deterministic.
- **Con:** prompt-engineering change with its own iteration/eval loop; harder to
  guarantee than deterministic code; affects every render so needs care.

### Recommendation
If we act at all, **D (generator) addresses the real root cause** — including
the tonal mismatch, which B and C do **not** fix (they only remove repetition,
not disagreement). **B is the safest mechanical fix** for the redundancy alone.
But the right first move is **A + measure**: use the new breakdown to eyeball a
handful of facts, and do one cheap A/B render comparison, before changing what
reaches the engine. We should only pay the risk of B/C/D once we've confirmed
the overlap actually degrades output.

---

## 8. Where the code lives (for a reviewer who wants to dig)

- Compiler / assembly / de-dupe: `artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts`
  - `assembleSections` — budget + de-dupe + status tracking
  - `compile` — builds the ordered section list (goal/approach split out here)
  - `dedupeSentences`, `normalizeSentence` — the exact-sentence de-dupe
  - `composeKeyElementsDirective`, `composeCompositionDirective` — the
    substring "already present?" suppression
- LLM planner + its instructions: `artifacts/api-server/src/lib/imagePrompt/generator.ts`
  (`buildImagePromptUserMessage` is where goal/approach/prose are requested)
- Admin preview route (feeds the debug UI): `artifacts/api-server/src/routes/adminImagePrompt.ts`
- Live render path: `artifacts/api-server/src/lib/imagePromptJobs.ts`
- Debug UI (the breakdown you now see): `artifacts/overhype-me/src/components/admin/RuntimePromptPreview.tsx`

---

## 9. A good question to ask ChatGPT

> For a modern text-conditioned image model (Google "Nano Banana 2"-class),
> given a single prompt that states the core concept three times — once as an
> abstract goal, once as a staging "approach", and once as a concrete scene —
> and where the "approach" says "grounded, heroic" while the concrete scene says
> "playful, humorous": (a) does this redundancy measurably help, hurt, or wash
> out vs. a single concrete scene description? (b) how does the model resolve a
> grounded-vs-playful tonal conflict in one prompt? (c) is it better to
> de-duplicate after generation or to constrain the generator to emit
> non-overlapping, tonally-consistent fields?
