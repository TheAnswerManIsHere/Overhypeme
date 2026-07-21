# PR224 — NB2 prompt hardening · UAT (click-through)

What this PR changes, in product terms: the image-render pipeline now **fails
loudly and specifically instead of quietly degrading**, and moderator visual
editing has a **real budget** so an over-long Visual Concept can't silently push
the safety guardrails out of the prompt. Plus a cosmetic cleanup: the built-in
style descriptions are trimmed to tighter, cleaner copy.

Most of this is backend correctness. The two things you can directly see:
(1) saving an over-long Visual Concept now gives a clear error, and (2) a render
that deterministically can't succeed now shows a specific failure instead of
spinning or silently producing a degraded image.

## Where to go

1. Admin → the **enrichment / Visual Concept editor** for a fact (and the same
   editor on a **review candidate**).
2. Admin → generate/render a meme to watch render status.
3. (Cosmetic) Admin → the **style picker** — the built-in style descriptions.

## The happy path

- **Normal Visual Concepts save fine.** A typical Concept (a few sentences) and
  normal visual guidance (a handful of role bindings / required details) save
  with no change from before.
- **Renders still work end-to-end.** A valid fact renders as before; the trimmed
  style copy produces the same style looks (cinematic still looks cinematic,
  anime still looks anime — the descriptions are just shorter and cleaner).

## What you can see change

- **Over-long Visual Concept → a clear save error.** Paste a very long Visual
  Concept (more than ~1500 characters), or one stuffed with many `{NAME}` tokens,
  and Save. You get a specific rejection explaining it's over the prompt budget
  (raw length, or "expands to up to N characters once names are filled in"),
  instead of it saving and then quietly breaking the render. Trim it and it
  saves.
- **Too much visual guidance → a clear save error.** If your role bindings +
  required details + composition + additions together get very large, Save
  reports the combined guidance is over budget. Individual normal entries are
  fine; it's the *aggregate* that's capped.
- **Deterministic render failures are specific, not silent.** If a render can't
  succeed for a fixed reason (corrupt frozen data, a leaked personalization
  token, or content that can't fit the prompt), the render now fails **fast**
  with a specific reason instead of retrying forever or shipping a degraded
  image. Transient hiccups (a model timeout) still retry as before.

## The safety guarantee (why this PR matters)

Before, if a prompt got too long, the compiler chopped the end off — and the
safety guardrails (the "don't bake in caption text / keep violence non-graphic"
constraints) live at the end, so they were the first thing silently dropped.
Now the compiler never drops them: either the content fits, or the render fails
loudly. Combined with the save-time budget, a moderator can't accidentally
author a Concept that pushes the guardrails out.

## Regression smoke table

| Action | Expect |
| --- | --- |
| Save a normal Visual Concept | Saves fine |
| Save a Concept > ~1500 chars | Clear "over budget" rejection |
| Save a Concept with many `{NAME}` tokens (short raw, huge rendered) | Clear "expands to…" rejection |
| Pile on role bindings + details + additions | Clear aggregate "over budget" rejection |
| Render a valid fact (any style) | Renders as before; style look unchanged |
| A deterministically-broken render | Fails fast with a specific reason (not endless spin) |
| Built-in style descriptions | Shorter, cleaner copy; same visual result |

## What should NOT happen

- A normal-length Concept should **not** be rejected.
- A render should **not** silently drop the "no caption text / non-graphic
  violence" guardrails to fit — it fails loudly instead.
- A transient model/network hiccup should **not** be treated as a permanent
  failure — it still retries.
- Selecting a built-in style should **not** change the style's look (only the
  description text is shorter).

## Known non-bugs (out of scope)

- **No in-editor character counter yet.** The budget is enforced on Save (with a
  clear message); a live "N / max" counter in the editor is a follow-up.
- **The §21 numbers** (the exact Concept / additions size limits) are set from a
  measurement and were approved before merge (engine ceiling raised to 6000
  chars — NB2's real context window is ~131K tokens, so the original 4000 was
  editorial discipline, not a capacity limit) — if a limit feels too tight or
  loose in practice, it's a one-line tuning change.
- **Look-style copy is not admin-editable** (it ships via migration), so there's
  no style-copy save form to test.

## Bug report template

```
Where (Visual Concept save / render failure / style picker):
Fact or review id:
What I entered / did:
What I expected:
What happened (screenshot of the error or render status):
```

See the engineering checklist + the §21 numbers table in
[`PR224_NB2_PROMPT_HARDENING_TEST_RUN.md`](PR224_NB2_PROMPT_HARDENING_TEST_RUN.md).
