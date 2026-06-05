# Prompt debug breakdown + token gate — user acceptance testing (in-app)

You're the admin here. You'd been looking at the final compiled visual prompt
(e.g. fact #36, "Superman in David pajamas") and flagged three things: you
couldn't see the **parts** the prompt was built from, a raw `{NAME}` token was
leaking into the prompt, and the preview vanished on reload. This closes all
three. (It also gives you the per-component view you'll want to judge the
"is the goal/approach repeating the prose?" question — see the note at the end.)

The engineering/automated side is in
[`PROMPT_DEBUG_BREAKDOWN_TEST_RUN.md`](./PROMPT_DEBUG_BREAKDOWN_TEST_RUN.md)
(owned by Replit) — you don't need to read it.

If anything fails, note the section + step, what you saw vs. expected, and a
screenshot. Bug template at the bottom.

---

## 1. See the components the prompt was built from

Open **Facts** (admin) → pick a fact with a clear archetype (fact #36 is the
one you were looking at) → expand **Runtime Compiled Prompt Preview** → pick
render assumptions (e.g. human i2i) → **Generate runtime prompt preview**.

Under the compiled prompt, expand **Prompt components (N)**.

Expect:

- A list of the building blocks the compiler concatenated, **in order**:
  *Mode preamble*, *Required mode clauses*, **Visual goal**, **Visual
  approach**, *Semantic referents*, *Cultural references*, *Supporting-text
  rule*, *LLM prose*, *Key visual elements*, *Composition*, *Modifier
  directives*, *Style suffix*.
- Each component shows a **priority** chip (required / high / medium) and a
  **status** chip:
  - **included** — folded into the final prompt as-is.
  - **compressed** — trimmed to fit the engine's length budget.
  - **deduped (already present)** — every sentence was already covered by an
    earlier component, so it added nothing (shown struck-through for context).
  - **dropped (over budget)** — left out because the prompt got too long.
  - **empty** — nothing for this render (e.g. no style selected → *Style
    suffix* is empty).
- Reading the **included**/**compressed** components top to bottom should match
  the compiled prompt above them.

This is the visibility you asked for: the final prompt isn't a black box — you
can see each taxonomy-derived part and the LLM prose as separate pieces.

## 2. The `{NAME}` token no longer leaks

On fact #36 (and any fact whose enrichment treats `{NAME}` as a semantic
entity), look at the **Semantic referents** component and the compiled prompt.

Expect:
- It reads `"David" means …` — the brand-protagonist name — **never**
  `"{NAME}" means …`.
- Search the whole compiled prompt: there is **no** `{NAME}`, `{SUBJ}`, or any
  `{…}` identity token anywhere.

(In a real user's render this resolves to *their* name/pronouns, not "David" —
"David" is just the admin-preview protagonist.)

## 3. The preview survives a page reload

1. Generate a preview. Note the compiled prompt + your control selections
   (render mode, aspect ratio, style, etc.).
2. **Reload the page.**
3. Re-open the **Runtime Compiled Prompt Preview** panel.

Expect:
- Your control selections are restored, and the **last result is still there**
  — the compiled prompt, components, input summary, visual-plan debug — without
  pressing Generate again. No recompute, no spinner.
- Switching to a **different fact** and back shows each fact's own last preview
  (it's stored per fact). A fact you've never previewed opens clean (defaults,
  no stale result from another fact).

---

## 4. The prompt no longer carries competing identity / policy language

On fact #36 (human i2i), after generating, look at the compiled prompt and the
new **Prompt guard removed N planner-prose clause(s)** block below it.

Expect:
- Face/identity language appears **once**, from the compiler's own line
  ("Preserve the reference person's recognizable face"). You should **not** also
  see the LLM's "Ensure Superman's recognizable face is preserved" — that
  competing clause is stripped and listed in the removed-clauses block with the
  reason "identity preservation (compiler owns this)".
- If the LLM prose mentioned the uploaded/reference image, a token, or
  text/logo policy, those are stripped too and listed with their reasons.
- The **concrete scene** sentences (Superman in David pajamas, city skyline,
  lighting, pose) are untouched.

This is the "two competing identity anchors" risk you'd expect on a
character-costume fact, now prevented deterministically.

## 5. Goal + approach are one compact line, not two mini-prompts

In the compiled prompt, the abstract intent now reads as a single
**Strategic intent** component: `Intent: … Stage it as: …` — instead of two
separate large goal and approach blocks ahead of the scene. The raw goal and
approach are still visible individually under **Visual plan debug**.

## 6. Tone mismatches are flagged (not silently changed)

If a fact's approach is serious/cinematic while the prose is playful/humorous
(the "grounded vs playful" tension you spotted on #36), an amber **warning**
appears above the components asking you to confirm the intended tone hierarchy.
It does **not** rewrite the prompt — the wording is left as the generator
produced it. (See the known limitation below about where the real fix lives.)

## Regression smoke

| Area | Expect |
|---|---|
| Generate for a fact with **no** cultural refs / semantic entities | Compiles fine; those components show as **empty** |
| A fact where the LLM prose has **no** identity/policy language | Removed-clauses block is absent (nothing to strip) |
| t2i fallback (no upload) | Works; *Mode preamble* reflects t2i; fallback gender baked in |
| Non-human subject i2i | "Do not replace the subject with a human" present once; subject preserved |
| Select a look style | *Style suffix* component is **included** with the suffix; appears in the prompt |
| Copy button on the compiled prompt | Still copies the full prompt text |
| Visual plan debug toggle | Still expands the raw JSON |

## Known non-bug limitations

- The preview protagonist is always **"David"**; real renders use the
  requesting user's name/pronouns.
- The reload-survival is per-browser (it's stored locally). Open the same fact
  in a different browser/incognito and you'll start clean — expected.
- **Strategic intent** (goal + approach) and the **LLM prose** can still overlap
  in wording — they describe the same idea at different altitudes (abstract
  intent vs. the concrete scene). We compacted the intent and strip
  compiler-owned clauses, but we deliberately do **not** fuzzy-de-dupe the
  remaining conceptual overlap.
- **Tone mismatches are flagged, not auto-fixed.** The real fix for a
  serious-vs-playful split lives at the prompt generator (teaching the LLM to
  state the tone hierarchy), which is a separate, still-settling change. For now
  the warning just tells you to eyeball it.

---

## Bug report template

```
Section/step:
What I did:
What I expected:
What I saw:
Fact ID / screenshot:
```
