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

## Regression smoke

| Area | Expect |
|---|---|
| Generate for a fact with **no** cultural refs / semantic entities | Compiles fine; those components show as **empty** |
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
- **Visual goal**, **Visual approach**, and the **LLM prose** can still overlap
  in wording — they describe the same idea at different altitudes (abstract
  intent vs. the concrete scene). That's deliberate today; the breakdown just
  makes it visible. See the PR note about whether we should tighten this.

---

## Bug report template

```
Section/step:
What I did:
What I expected:
What I saw:
Fact ID / screenshot:
```
