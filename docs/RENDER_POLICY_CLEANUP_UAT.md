# Render-policy cleanup (Phase 1) — user acceptance testing

Paired with **`docs/RENDER_POLICY_CLEANUP_TEST_RUN.md`** (the automated
checklist). This is the click-through test for David.

## What you're verifying

The image compiler used to **secretly fight two things** that are often part of
the joke:

1. It pasted *"Keep all surfaces free of readable text, captions, watermarks,
   logos, and brand marks"* onto **every** prompt — so signs, TV titles,
   scoreboards, and document text got suppressed even when the fact needed them.
2. It had **no policy for violence** — nothing said action-hero violence /
   visible death is allowed when a fact ("threw a grenade and killed 50 people")
   requires it.

Phase 1 replaces both with an explicit **render policy**:

- **In-world readable text is now allowed** by default — and the compiler stays
  *quiet* about it (it won't nag the model to add text where none is needed).
- **The meme caption / hashtags / watermarks / logos are still kept out** of the
  generated image (those are composited separately) — that's a *narrow* exclusion,
  not a blanket text ban.
- **Violence is allowed when the fact requires it**, signalled by a short line
  that only appears on violent facts, with gratuitous gore still discouraged.

**Nothing to switch on** — it's live by default. There is **no new screen**; you
verify it in the existing prompt preview.

## Where to look

Open the **Runtime Compiled Prompt Preview** panel (admin **Facts** page per
fact, or the **Moderation** page per review). Pick controls, click **Generate**,
and read the **compiled prompt**, specifically the **STRICT CONSTRAINTS** section
at the end.

## 1. Readable text is no longer banned (the Shark-Week case)

1. Open **"Sharks have a David Franklin Week"** (enriched), open the preview,
   choose **image-to-image (human)**, Generate.
2. In **STRICT CONSTRAINTS**, expect:
   - A **narrow overlay exclusion**: *"Do not bake overlay or caption text into
     the image: no full meme captions, full fact text, hashtags, watermarks, real
     logos, brand marks, long explanatory paragraphs."*
3. **Expect NOT to see:** the old blanket *"Keep all surfaces free of readable
   text…"* line. In-world text (a TV title, a sign) is now allowed.
4. If the plan itself chose in-scene text (e.g. a scoreboard reading "999"),
   expect *"Render this in-scene text clearly: …"* — and **no** contradicting
   "keep all other surfaces free of text" line after it.

## 2. A wholesome fact stays clean (no text nagging, no violence line)

1. Open a non-violent fact like **"David is so smart he solved an unsolvable
   equation"**, Generate.
2. Expect the narrow overlay exclusion **only** — no instruction to add readable
   text, and **no** violence permission line.
3. **Expect NOT to see:** any "depict violence / show bodies" language on a
   wholesome fact.

## 3. A violent fact is allowed, not sanitized (the grenade case)

1. Open **"David threw a grenade and killed 50 people, then it exploded"**,
   Generate.
2. In **STRICT CONSTRAINTS**, expect the short self-conditioned line:
   *"When the fact explicitly requires violence, death, weapons, or destruction,
   depict the action and consequences clearly without gratuitous gore."*
3. The scene (bodies on the ground, the explosion, the action) should **survive**
   into the compiled prompt — not be softened into a harmless picture.
4. **Expect NOT to see:** PG-13 / family-friendly softening forced onto it.

## 4. A moderator can still soften a specific fact

1. On a violent fact, in the enrichment editor add the **`avoid_gore`** modifier
   (or `non_graphic_action`), save, re-Generate the preview.
2. Expect the existing softening directive (*"keep the scene clean and
   non-graphic — no gore or blood"*).
3. **Expect NOT to see:** the violence-permission line **and** the softening line
   at the same time — the per-fact softening wins, so the prompt never says
   "show bodies" and "keep it non-graphic" together.

## Regression smoke table

| Surface | Action | Expect |
|---|---|---|
| Facts → preview (i2i human) | Shark-Week fact | narrow overlay exclusion; no blanket readable-text ban |
| Facts → preview | plan with scoreboard text | "Render this in-scene text" line; no contradicting suffix |
| Facts → preview | wholesome fact | no text nag, no violence line |
| Facts → preview | grenade / violent fact | self-conditioned violence line; scene not sanitized |
| Facts → preview | violent fact + `avoid_gore` | softening line only; permission line gone |
| Facts → preview | any fact | meme caption / hashtags / watermarks still excluded |

## Known non-bugs / deferred

- **No per-fact text/violence override controls yet.** A moderator can still use
  the existing modifiers (`avoid_gore`, etc.) to soften, but the dedicated
  per-fact **override fields + UI are Phase 2** (`supportingTextPolicyOverride`,
  `violencePolicyOverride`).
- **No global toggle.** The defaults (text allowed, violence allowed at "strong")
  live in code. Future **child-safe** (soften) and **adult/NSFW** (graphic) modes
  are *future* policy layers — the structure supports them but none is wired now.
- The violence line is **self-conditioned** — it says "when the fact requires
  violence…", so it's harmless if it ever appears on a borderline fact.
- The compiler decides "is this fact violent?" from the fact text + plan +
  modifiers (a keyword/modifier signal). A very obliquely-worded violent fact
  might not trip it; add a softening/relevant modifier or moderator guidance if
  needed.

## Bug report template

```
Fact: <text>
Mode: <i2i human / i2i nonhuman / t2i>
What I expected (per this doc): …
What the compiled prompt showed: …
STRICT CONSTRAINTS lines (paste): …
Modifiers on the fact: …
```
