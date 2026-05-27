# Utility Engine Consolidation — User acceptance testing (in-app)

You're the end user (admin) here. This UAT validates **PR #76**, which
routes **every** OpenAI text call the app makes — fact tokenizing,
duplicate detection, pronoun guessing, comment moderation, image scene
prompts, video motion prompts, and fact taxonomy enrichment — through
**one configurable "General Intelligence" engine** on `/admin/engines`.

The point: instead of the model + sampling being hardcoded (or scattered
across a dozen `admin_config` keys), you now pick the model and its
defaults **once**, on one engine row, and every feature uses it.

**This should NOT change how anything looks or behaves at the default
model.** The default is still `gpt-4o-mini`. You're verifying that (a) the
new control exists and works, (b) the old per-feature model/sampling
controls are gone, and (c) all the features that call OpenAI still work
through the new central engine.

The automated/engineering side is in
[`UTILITY_ENGINE_TEST_RUN.md`](./UTILITY_ENGINE_TEST_RUN.md), owned by
Replit AI — runs in parallel, you don't need to read it.

If anything fails, note the section + step, what you saw vs. expected, and
a screenshot if it's visual. Bug template at the bottom.

---

## Setup

1. Pull PR #76's branch (`claude/elegant-einstein-5IxR4`).
2. Boot the dev app. The session-start hook brings up the test DB; the
   three new `engines` columns sync via `drizzle-kit push` (no manual SQL),
   and on boot the engine catalogue reconciles — creating the new
   **OpenAI — General Intelligence** engine row.
3. You need an **admin** login (the engines + config screens are
   admin-gated) and any **logged-in** user to submit a fact.
4. **OpenAI must be provisioned** for the consuming features to actually
   run: `AI_INTEGRATIONS_OPENAI_API_KEY` + `AI_INTEGRATIONS_OPENAI_BASE_URL`.
   Without them the *editing* of the engine (Part One) still works fully,
   but the *consuming* features (Part Three) will fail the same way they
   did before this PR — that's expected, not a regression.

**What's new / what to look for:**

- A new engine **OpenAI — General Intelligence** on `/admin/engines`,
  with a **model dropdown** + temperature / max-tokens / reasoning-effort
  fields, and **no** fal-style fields and **no** "Test" bench.
- The `/admin/config` **AI Style Prompt Configuration** panel now shows
  **only the two editable system prompts** — the model / temperature /
  max-tokens / reasoning-effort controls that used to be there are gone
  (they moved to the engine).

---

# PART ONE — The General Intelligence engine

Log in as **admin**, go to **/admin → Engines**.

## Section A — The engine exists and is shaped right

### A1. Find it

There should be a new group/row: **OpenAI — General Intelligence**
(`openai-general`), marked **Active** and **Default**. Its endpoint line
reads `gpt-4o-mini`.

### A2. The editor is LLM-shaped, not fal-shaped

Expand it. In the **Admin-editable** column you should see:

- A **Model (general intelligence)** dropdown listing GPT-4o / 4.1 options
  **and** GPT-5 reasoning options.
- **Default temperature** (0.7), **Default max tokens** (512), and
  **Default reasoning effort** (low) fields.

You should **NOT** see (these are for fal media engines):
- ❌ Default duration / resolution / aspect ratio / mode.
- ❌ `$ per call` / `$ per second`.
- ❌ A **Test** button on the engine card (the synthetic fal bench doesn't
  apply to an LLM).

If you see any of the fal-only controls on this engine, **flag it**.

### A3. Change the model + sampling and save

Set the model to **GPT-4o**, temperature to `0.5`, max tokens to `700`,
leave reasoning effort. Click **Save changes** → "Saved!". Collapse and
re-expand (or refresh) and confirm the values stuck.

> Optional SQL confirmation (admin):
> ```bash
> PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
>   "SELECT endpoint_id, default_temperature, default_max_tokens, default_reasoning_effort
>    FROM engines WHERE id='openai-general';"
> ```
> Expect `gpt-4o | 0.50 | 700 | low`.

**Set it back to `gpt-4o-mini` / 0.7 / 512 before Part Three** so you're
testing the production default.

### A4. (Optional) Reasoning model swap

Set the model to a **GPT-5** option, reasoning effort **medium**, Save.
Nothing should error. (If OpenAI is configured, you can later confirm in
Part Three that features still return sensible output — reasoning models
are slower and pricier, which is why `low` is the default.) Set it back to
`gpt-4o-mini` afterwards.

### A5. The model is locked to OpenAI engines

Open any **fal** engine (e.g. a video engine). It should have **no model
dropdown** — its endpoint stays read-only/code-owned. (Behind the scenes
the API rejects an attempt to change a fal engine's endpoint; you just
shouldn't be offered the control.)

---

# PART TWO — The config page no longer owns the model

Go to **/admin → Configuration → AI Style Prompt Configuration**.

## Section B — Only system prompts remain

### B1. Image + video style prompts are system-prompt-only

The panel should show:
- **AI Image Style Prompt** → a single large **system prompt** textarea.
- **AI Video Motion Prompt** → a single large **system prompt** textarea.

You should **NOT** see, in this panel:
- ❌ An "OpenAI Model" dropdown for the image or video prompt.
- ❌ Temperature / Max Tokens / Reasoning Effort fields.

The panel's description should point you to the **General Intelligence
engine (/admin/engines)** for the model + sampling. If the model/sampling
controls are still here, **flag it** (they'd be dead controls now).

### B2. Editing the system prompt still works

Edit the image style prompt slightly, Save, and confirm it persists
(reload). The debug-overlay behavior (if you use it) is unchanged.

---

# PART THREE — Every consuming feature still works

These are the features that now call OpenAI through the engine. With the
engine on `gpt-4o-mini` (A3) and OpenAI provisioned, each should behave
exactly as before this PR.

## Section C — Submission-time text features

### C1. Tokenize a fact

At **/submit**, enter a plain fact (e.g. *"David can slam a revolving
door."*) and let it tokenize. Pass criterion: it produces a token template
(`{NAME} can slam a revolving door.`) like before.

### C2. Pronoun suggestion

Where the submit flow suggests subject/object pronouns from a name,
confirm it still returns a sensible guess.

### C3. Duplicate detection

Submit (or near-submit) a fact very similar to an existing one and confirm
the duplicate check still flags it.

### C4. Fact taxonomy enrichment (the #75 feature)

Submit a fact, then as admin open **Moderation → Fact Reviews** and
confirm the **Visual Taxonomy Enrichment** panel still populates (status
`ok`, archetype/subtype/etc.). This call now goes through the engine too —
it should classify exactly as it did in #75's UAT.

## Section D — Generation-time features

### D1. Image scene prompt

Approve a fact / kick image generation and confirm AI backgrounds still
generate (the scene prompt that drives them is produced via the engine).

### D2. Video motion prompt

Generate a video from a still and confirm it animates — the motion
direction (a **vision** call that looks at the still) still works through
the engine.

### D3. Comment moderation

Post a comment containing obvious spam (a link + promo) and confirm it
still gets flagged by the AI moderator.

---

## Section E — Regression smoke

| #  | Area                     | Check                                                                          |
|----|--------------------------|--------------------------------------------------------------------------------|
| E1 | Fact submission          | Submit → tokenize → lands in Pending, same as before.                          |
| E2 | Image pipeline           | Approving a fact still generates AI backgrounds.                               |
| E3 | Video pipeline           | A video render still produces motion + completes.                              |
| E4 | Enrichment review        | The enrichment panel still pre-fills and is editable/approvable.               |
| E5 | Other engines unaffected | fal image/video engines on `/admin/engines` still edit + Test as before.       |

---

# Bug report template

```
Section: <e.g. A2>
Where: <admin engines / admin config / submit / moderation>

Engine state (if relevant):
  model (endpointId): <value>
  temperature / maxTokens / reasoningEffort: <values>

Expected:
  <what the section says should happen>

Actual:
  <what happened>

Screenshots:
  <attach>

Network panel:
  <any 4xx/5xx, e.g. on PATCH /admin/engines/openai-general, /ai/tokenize-fact>
```

---

# Notes / known limitations (expected, not bugs)

- **No behavior change at the default model.** This is a consolidation;
  with `gpt-4o-mini` selected, output is the same as before.
- **Reasoning models are opt-in and slower/pricier.** The default is a
  chat model; `reasoning_effort` only matters if you pick a GPT-5 /
  o-series model. The video motion prompt needs a **vision-capable** model
  — the GPT-4o / 4.1 family and GPT-5 are; don't expect a text-only model
  to read the still.
- **Without OpenAI keys, the consuming features fail the same way they did
  before** — editing the engine still works, but nothing will actually
  classify/generate. By design, not a regression.
- **One engine for everything.** Changing the model changes it for *all*
  text features at once (that's the point). There's intentionally no
  per-feature model override in the UI anymore — call sites still tune
  temperature/token caps in code where it matters (e.g. enrichment runs at
  temperature 0.2).
