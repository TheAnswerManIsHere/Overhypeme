# Plan — Phase 7 amendment: making an AI picture becomes its own flow

Workstream: Issue #1331 (parent #1289, grandparent #628). This file amends
`docs/plans/PLAN_PHASE7_IMAGE_OFFERING.md` (approved 2026-11-25, sha256
b25fec82be90223995fd465d929bdc66272ffcc4869e98af5419c5efc3b00615). The parent
plan keeps everything this file does not change, and gains one line pointing
here at approval. Tier: product, standard loop. A new table takes the
migration review.

## Summary for David

**Problem.** Making an AI picture inside the meme builder was cramped (the
increment 2 UAT): the jokes were hard to compare, the style list unclear, the
member was asked what the photo already shows, every picture was portrait,
and a pet's picture kept the member's name in the caption.

**What you get.**
- **Its own screen**, opened from a button in the builder (and from the fact
  page's examples once increment 3 builds them): photo (it recognises you or
  your pet, and asks only a pet's name and pronouns) → **Fact Visualization
  Options** → **Stylize it** → shape → name on the meme → cost → Make it.
- **Fact Visualization Options:** big thumbnails; tapping one opens a large
  view with a one-line description of the joke in your (or your pet's) name,
  plus "Select this visualization option" and Close. A single joke is shown,
  with nothing to choose.
- **Stylize it:** a clear dropdown, with the style's sample where one exists
  (increment 6 makes them).
- **Back in the builder:** the picture, in the shape you picked, with your
  pet's, a friend's or your own name on the caption. A half-made meme you
  left is exactly as you left it.
- A Try again button if the choices fail to load (#1315).

**What it leaves out.** The style list and samples (increment 6), the fact
page's examples (increment 3), admin image details (#875).

**Questions for David.** Answered by David on 2026-11-26: "q14 1. q15 1."
- **Q14 — who writes each joke's description?** Recommendation: 1 (Astra
  agrees).
  1. AI drafts each from the joke's scene; a moderator approves it.
  2. Moderators write them all by hand.
  3. AI drafts go live unreviewed.
- **Q15 — when does an approved description go live?** Recommendation: 1
  (Astra agrees).
  1. At once, if it describes the joke members currently see — a one-line
     exception to publishing a fact's jokes together.
  2. Only with the fact's next "Publish changes", which also waits on any
     unrelated unfinished edits to that fact.

**How you'll check it.** Shape, names, retry and the hand-back are checked
automatically. You judge the screen's clarity, the joke dialog, the
description drafts, and one real landscape picture of your pet.

**Costs and risks that are yours.**
- **Moderator reviews:** done means every pickable joke has an approved
  description (up to three per fact); afterwards each new or changed joke
  needs one before it can publish.
- **A small paid AI text run** to draft the descriptions.
- **Changing the shape in the builder after drawing crops the picture**, and
  the screen says so first. Your note 4 allowed locking instead; locking
  would make a different crop cost another credit.
- Nothing irreversible.

## Problem

Increment 2 (PR #1300, PR #1313) put picture-making in a panel inside the meme
builder's picture step. The UAT accepted it (final record on Issue #1299) and
produced five product notes (Issue #1331). What the notes reflect in the code:
- The panel hard-codes a portrait picture (`AiPicturePanel.tsx` submits
  `aspectRatio: "portrait"`).
- It asks the member to choose "Me" or "My pet", although the server's photo
  check already knows and refuses a mismatch (`memberPictures/command.ts`,
  `photo_subject_mismatch`).
- It shows the jokes as small example strips and the looks as a plain select.
- It hands the builder only the picture, so the caption keeps the member's
  name for a pet picture.
- It cannot retry a failed load of its choices (Issue #1315).

## Direction

`docs/ai-context/product-strategy.md` (approved 2026-11-11) and the parent
plan's product intent, unchanged. This amendment makes picture-making its own
flow (David, Q12: 1), which the parent plan's increments 3 and 6 then build
on.

## Product Intent

- **Its own flow.** Making an AI picture is no longer a panel inside the meme
  builder. It is reached from the fact page (increment 3's examples) and from
  a button in the meme builder.
- **Up front, then hand-off.** It asks for the picture's shape and the name
  the meme is about, draws the picture, and hands the finished picture to the
  meme builder as the background, with that shape and that name.
- **The five UAT notes:**
  - "Fact Visualization Options", with large views and a one-line description
    per gag;
  - "Stylize it", a clear dropdown with a style example;
  - me-or-my-pet decided from the photo;
  - the picture drawn at the meme's ratio, with plain words on how that ratio
    is set;
  - a pet picture's caption able to carry the pet's name.
- **#1315.** It closes Issue #1315.

## Must Not Change

**Carried from the parent plan and increments 1 and 2 as built:**
- everything in the parent plan's *Must not change*;
- one command makes one picture;
- the attempt, spend and first job commit together;
- every paid call passes the budget gate and the cost ledger;
- a failed or refused picture returns its credit, and settlement never
  depends on a callback;
- a member's picture is delivered as theirs or not at all, is listed in My
  content, and is offered as a background only to its owner;
- examples are never backgrounds;
- the output check runs before delivery;
- there is no free regenerate.

**Also:**
- Blind moderation and the gag's draft/publish rules: members see only gag
  text a moderator has approved, about the gag version they are offered.
- A picture already made, or drawing, when this ships stays usable and
  visible exactly as today.
- The builder's own photo-upload path is unchanged.
- Q5: 2: the picture stars the member or their pet; the caption may name a
  friend.

## Settled Decisions

**Carried in:**
- Q12: 1 and Q13: 2 (2026-11-26).
- Q1–Q9 and the watermark rule (Issue #1289).
- 2026-11-14: a picker only where a fact has more than one available gag.
- 2026-11-15: a person or a pet; male, female and pet examples.
- 2026-11-17: deprecated means removed.
- 2026-11-21: published and draft gag sets; only publication changes what
  members receive. Q15 asks David about one bounded exception.
- The engines are settled: GPT Image 2.6 and Nano Banana 2.1.

**Both settled engines already draw all three shapes,** so the shape is a
request input, not new engine work:
- `GPT_IMAGE_2_5_SIZES` (used by `gpt-image-2-6.ts`) lists square, landscape
  and portrait options near 1 MP.
- `nano-banana-2-1.ts` maps `landscape: "16:9", square: "1:1", portrait:
  "9:16"` onto its `aspect_ratio` parameter.

**The shape after the picture is drawn.** David's note 4 offered either
option; this one is chosen on my recommendation.
- The flow asks the shape and draws in it.
- The builder opens in that shape.
- Changing the shape in the builder afterwards crops the picture, as it crops
  an uploaded photo, and the flow says so before drawing.
- Locking the builder's shape was rejected: a member who wanted another shape
  would have to pay a second credit for a crop they can have free.
- Undo: lock the shape toggle while an AI picture is the background.

**A description belongs to the exact gag content it describes.**
- It is stored apart from the gag's drawing content, keyed by the gag and a
  fingerprint of the content (scene and bubbles) it was written for.
- Consequences:
  - It never reaches a prompt or render freshness.
  - Editing it neither changes the content nor clears example picks
    (`saveGagContent` clears picks on a content change, `gagStore.ts`).
  - Publishing content brings along its own description with nothing to
    copy.
  - A description for other content can never be shown.
- No revision-history system is involved: each description simply sits
  under its fingerprint.

**Inventory (affected-surface oracle):**
- Command: `git grep -n "AiPicturePanel\|aspectRatio: \"portrait\""` on
  `9b1fbdb`.
- It finds the panel's one mount (`Step2Image.tsx`), the panel itself, its
  test, and the one hard-coded portrait.
- The producers of draft gag content are `saveGagContent` (`gagStore.ts`) and
  the prefill job (`prefill.ts`), which writes pending content directly.
  Drafting is a sweep over stored state (below), so it covers both, and any
  future producer, by construction.
- Members read gag data through `availableGags` (`resolver.ts`); the
  description joins that one read.

**Now / next / never:**
- **Now:** the flow; the builder button; the hand-off; the five notes;
  #1315; removing the panel; descriptions, their drafting, review and
  publication; the entry contract increment 3 uses.
- **Next:** increment 3's examples block; increment 6's catalogue and
  samples; #875.
- **Never:** free-typed prompts; a picture with no photo; examples as
  backgrounds; asking person-or-pet.

**Ceremony tier:** product, standard loop, plus the migration review.

## Source-of-Truth Analysis

- **Gag text members read:** a reviewed description whose fingerprint equals
  the published content's, read through `availableGags`. The admin editor
  reads the descriptions for both versions' fingerprints. No other copy is
  made.
- **Is the photo a person or a pet:** the existing analysis cached on the
  upload. The flow reads it; the command re-checks it, so the client never
  decides.
- **The picture's shape:** the attempt's stored render controls, as today.
- **The name a picture was made for:** recorded on the member's attempt at
  the command, and read back by the picture's state.
- **The caption in the builder:** the builder's `name`/`pronouns` state. The
  hand-off writes it once; the member's later edits win.

## Proposed Design

### The flow

**A page of its own** for one fact, at `/facts/:id/picture`.
- It takes an optional gag to start on; that is the contract increment 3's
  examples use.
- It also takes the builder's current shape and caption identity when opened
  from the builder.
- Signed-out or unverified visitors get the existing explanation and sign-in
  route, never the form.

**Steps, on one screen, top to bottom:**
1. **Photo** — upload or pick an owned photo, through the existing upload and
   moderation.
2. **Fact Visualization Options.**
3. **Stylize it.**
4. **Shape** — landscape, square or portrait. The default is the builder's
   shape when opened from it, else portrait. One line explains: "Your meme
   uses this shape. You can change it in the builder, but the picture will be
   cropped to fit."
5. **Name on the meme**, with pronouns.
6. **Cost line** — "1 credit" or "your free picture", and the balance after —
   then **Make it**.

**Photo preparation.**
- Choosing a photo runs a preparation request applying the existing
  person-or-pet analysis. It goes through the same ownership and eligibility
  checks and the same budget gate and cost recording, and reuses the upload's
  cached result.
- It spends no credit and queues no picture.
- It answers a person, a pet, unusable (with the existing reason), or
  check-failed. Check-failed covers an analysis that returns
  `classificationMethod: "not_analyzed"` (which `analyzeSourceImage` returns
  rather than throwing); it shows "We couldn't check this photo — try again"
  and offers no subject.
- A result for a photo that is no longer the chosen one is ignored.
- Ordinary uploads are unchanged.

**Pet fields** appear only when the photo is a pet: name (required) and
pronouns.

**Name on the meme.**
- The caption identity (name and pronouns) carries an explicit "chosen" mark.
  It is set by any edit to either field, in the builder or here, and it
  travels with the hand-off in both directions and with the saved draft.
- A chosen identity is never replaced.
- Otherwise it follows the subject: the member's name for a person, the pet's
  name and pronouns for a pet.
- The name and pronouns used to *draw* always come from the subject: the
  member's own, or the pet fields. They never come from this field
  (Q5: 2).

**The picture remembers its caption.**
- The command records the caption name and pronouns on the member's picture
  attempt.
- The picture's state returns them, with the shape.
- Leaving, reloading or making another picture therefore cannot attach the
  wrong name to an earlier result.
- An older attempt has no recorded caption; handing it off leaves the
  builder's caption as it is.

**Fact Visualization Options.**
- Each available gag is a card with large thumbnails of its examples.
- Tapping a card opens a dialog showing:
  - the examples at full size;
  - the gag's description, rendered with the subject's name and pronouns
    (nothing while there is none);
  - "Select this visualization option", and Close.
- With one gag, the card reads "This fact's visualization", and its dialog
  has Close only.
- Several examples of one gag illustrate that one option; they are not
  options themselves.

**Stylize it.**
- A labelled dropdown with a visible chevron. Its first entry is "No style
  (photoreal)".
- Under it, the chosen style's sample (the `previewImagePath` the looks route
  already returns), tappable to enlarge in the same dialog.
- A style without a sample shows none.

**Loading.** The options and looks are read through the app's query layer:
- one automatic retry;
- an error state with "Try again" that keeps every valid selection;
- a refetch after a picture finishes, because the "next one is free" cost
  line changes;
- a retry never submits a picture.

This closes #1315.

**Drawing.**
- Make it sends the existing command, with:
  - the shape;
  - the subject from the photo check;
  - the gag and the look;
  - the caption identity;
  - the same request identity through retries (increment 2's rules,
    unchanged).
- Progress follows `async-ui-status.md`.
- Returning to the page for this fact shows the member's pictures still
  drawing for it.

**Done.**
- "Make a meme with it" opens the builder for the fact with a hand-off: the
  picture, the shape read from the finished picture, and the caption read from
  the picture's state.
- "Make another" stays on the page with the choices kept and re-reads the
  cost.
- Back (or cancel) when opened from the builder returns to the builder with
  its draft exactly as left.

### The builder

**The draft is complete, and it waits for the member.**
- The caption split, today local state in `Step2Image.tsx` (`splitIndex`),
  joins the persisted draft (`PendingWizardState`), as does the caption's
  chosen mark.
- Opening the flow keeps a return snapshot of the draft. Today's draft
  expires after an hour and is deleted when restored (`wizardStorage.ts`);
  the return snapshot is not, while the flow is open. It has its own bounded
  lifetime (a day) and is cleared when the member returns or saves.
- Leaving for the flow and coming back therefore restores everything the
  member had set, even after an interruption.

**The hand-off wins once.**
- On arrival with a hand-off, the builder applies its background, shape and
  caption identity over the restored draft, and nothing else. Today a
  restored draft overrides incoming names (`useWizardState.ts`).
- The hand-off is consumed, so a reload restores the draft as it then stands.

**The picture step.**
- It keeps "Upload a photo" and gains "Make an AI picture", which opens the
  flow with the builder's shape and caption.
- The panel is removed. Its finished-picture selector stays: the member's
  finished pictures of this fact, offered by tap, never auto-applied, with
  old pictures shown as today.
- Pictures still drawing appear there with their state and a link to the
  flow.
- Picking a finished picture from the selector does not change the caption.

### Descriptions

**What a description is.**
- One line, up to 160 characters: plain text with the gag scene's
  personalization tokens, validated the same way.
- It is stored per gag and content fingerprint, with:
  - its origin: drafted by AI, or written or edited by a moderator;
  - whether a moderator has reviewed it, and who.

**Drafting (Q14: 1).**
- A durable sweep finds every gag version — published and draft — that has
  no description for its current fingerprint, and drafts one.
- The draft comes from that content's own scene and bubbles, using the
  existing utility text model. Like the other moderation helpers (cast
  reading, joke ideas), it passes no per-account budget gate and writes no
  cost-ledger row: no member account is behind it. Its spend is bounded by
  construction (at most three tries per gag version, 25 versions a run) and
  every try is counted on the description row (amended by David, Q18: 1,
  2026-11-27, PR #1334 round 4; the parent plan's member-call rule is
  unchanged).
- It runs straight after a gag content write as well as on the schedule
  (David, Q16: 1, 2026-11-26).
- It runs after any gag content write and on a schedule, so the prefill job,
  the editor and the backfill are one path. The backfill is its first run
  over the published catalogue.
- A drafting result is stored only if no description exists for its
  fingerprint when it lands:
  - it never replaces a moderator's text;
  - a result for content that has since changed simply sits under the old
    fingerprint, unused.

**Review.**
- The gag editor shows the description for the published content and the
  one for the draft content, each editable. Editing marks it moderator-written
  and reviewed.
- The description is a field on each gag, beside its scene and bubbles, with
  its drafting state: drafting, drafted, or failed with its reason. There is
  no separate descriptions page (David, 2026-11-27, at the UAT of PR #1334:
  *"We do not need a gag descriptions page. Descriptions belong as an
  additional field on each gag."*).
- When content changes and the old content had a moderator-written
  description, the editor offers that text as a starting point for the new
  content. It is never applied silently.

**Publication.**
- Members see a description only when it is reviewed and its fingerprint
  equals the published content's.
- Publishing a fact's draft makes the draft content's reviewed description
  visible automatically, because the fingerprints now match.
- Q15: 1: reviewing a description of the published content shows it
  immediately; it publishes nothing else.
- With Q15: 2, the review is recorded but stays hidden until the fact's next
  publish.
- With Q15: 2, the reviewed text and the visible text are kept apart, so a
  review of the same content does not show until the publish.
- **Coverage is kept at publication.** The go-live check (`goLive.ts`, used by
  `publishDraft` for both production approval and Publish changes) also
  requires a reviewed description for every gag whose content is new or
  changed in that publish. Without one, the publish is refused, the
  member-visible set stays as it was, and the moderator is shown which
  description needs attention. A gag already published and unchanged is not
  blocked by this, so the backfill never stops a fact's other edits from
  publishing.
- Removing a gag removes its descriptions with it. Discarding a draft leaves
  the draft's descriptions unused under their fingerprints.

### What increments 3 and 6 now do

- **Increment 3:** its examples lead into this flow with the gag preselected.
  Its signed-out invitation is unchanged.
- **Increment 6:** its samples appear in Stylize it without further work. Its
  catalogue trim (#888) and tuning are unchanged.

## Data Model and Migration Impact

**One migration, additive:**
- **A gag descriptions table.** Columns: gag, content fingerprint, text,
  origin, reviewed by, reviewed at, and timestamps. It is unique on gag and
  fingerprint, and cascades on gag delete.
- **A nullable caption column on the member picture attempt.**

**Rollback** is the application's: the table and column stay, and
moderators' text survives.

**The backfill is the sweep's first run, not part of the migration.**
- It is idempotent: one description per gag and fingerprint, enforced by the
  unique key.
- It logs counts: drafted, skipped (a description already exists), failed
  (with the reason), and no-op.
- It publishes nothing: an AI draft is unreviewed.

**The row-state matrix** (old, new, partial, failed, skipped, no-op) is in
the migration review's checklist and is held by tests.

## Admin/User UX Impact

**The flow:**
- loading;
- choices failed to load (Try again);
- photo checking: a person, a pet, unusable (with the reason), or check
  failed (try again);
- no gags available (the existing refusal);
- out of credits (the existing line);
- drawing, done, failed with "your credit was returned".

**Admin:**
- the gag editor's two description fields and their review action;
- the offer of earlier text after a content change.

## Security, Permissions, and Validation

- **The preparation request** is a verified member's, only for an upload they
  own, under the budget gate. It returns only the subject kind or the
  existing reason.
- **The hand-off carries the picture's id.** The background is still checked
  on the server against the caller's live picture rows. A forged hand-off
  naming another member's picture is refused there, and the caption read for
  it comes from the caller's own attempt only.
- **Description writes and reviews** are admin routes under the existing
  gag-editing permission. Members read descriptions only through the
  published read.

## Testing Plan

Each line is an invariant, held by tests with negative cases.

**Preparation:**
- spends no credit and enqueues nothing;
- records each paid check once;
- refuses an unowned upload;
- treats a `not_analyzed` result as check-failed;
- never lets a stale result set the subject for a newer photo.

**Pictures:**
- The shape chosen is the shape requested and recorded, for all three shapes.
- The command still refuses a subject mismatch sent to it directly.

**The journey: builder → picture page → builder,** exercised end to end:
- cancel restores the draft exactly, caption split included, including after
  the old one-hour draft expiry;
- an edited caption whose name equals the member's own (another Alex, other
  pronouns) is never replaced;
- completion changes only background, shape and caption;
- a reload while drawing reattaches the right caption;
- a friend caption on a pet picture survives;
- a pet picture with no chosen name arrives with the pet's name;
- the draw always uses the subject, never the caption.

**#1315's three paths** — first open, after Make another, and on return with
a picture drawing — each reach a working Make it after one failed load. No
disabled form appears without words, and no retry submits a picture.

**One gag:** nothing is offered to select.

**Descriptions:**
- a member sees only a reviewed description of the exact published content;
- published A with draft B: neither version's description shows on the
  other;
- after publish, B's reviewed description shows;
- a late draft for changed content attaches nowhere;
- a moderator's text survives every later sweep;
- under Q15: 1, a review of published content publishes nothing else;
- a publish whose new or changed gag lacks a reviewed description is refused
  and leaves the member-visible set intact; it succeeds once the description
  is reviewed; an unchanged published gag without one blocks nothing;
- editing a description leaves example picks intact;
- no description appears in a render input;
- the sweep covers prefill-written content;
- re-running the backfill is a no-op.

**Old and in-flight pictures** stay selectable without the new caption
record.

Shape, caption, retry and dialog behaviour are machine lanes (assertions, or
a capture where only pixels hold it). Runners: the sharded API suite, the
frontend suite and E2E Smoke, per `docs/tests/TESTING.md`.

**UAT judgement steps:**
- the flow's clarity;
- the thumbnails and the dialog;
- the quality of the description drafts;
- one real pet picture in landscape.

## Implementation Steps

1. **Server PR:**
   - the migration;
   - descriptions: storage, read, review, the sweep and its schedule;
   - the admin field, list and earlier-text offer;
   - the preparation request;
   - the caption on the attempt and in the picture's state.
2. **Screens PR:**
   - the flow page and its pickers;
   - query-layer loading;
   - the complete draft and the hand-off in the builder;
   - the builder button;
   - removing the panel, keeping its selector.

The backfill runs after the server PR merges, at close-out, as a paid run
logged on the fleet ledger. Moderator review follows. The amendment is done
when that review is complete (Definition of Done).

## Risks and Mitigations

- **The review is real moderator work.** It happens on each gag, and a joke
  without a description still works meanwhile; the go-live check refuses a
  publish whose new or changed gag has none.
  - unable to verify: how many published gags exist in production. A count on
    the production database at close-out settles it; the Summary states the
    cost per joke.
- **A long stay in the flow could lose the builder's draft.** The draft is
  persisted in the tab's session, as today. A different tab or device starts
  a fresh draft, also as today.
- **A crop after a shape change could cut off the subject.** The flow says so
  before drawing, and the builder's framing control already moves the crop.

## Questions for David

Answered by David on 2026-11-26: "q14 1. q15 1." Q14: 1 and Q15: 1 are settled decisions from here on.


- **Q14 — who writes each joke's one-line description?**
  - Recommendation: 1, AI drafts from the joke's own scene and a moderator
    approves. Astra agrees.
  - Option 3 would let member-visible text skip review, which the 2026-11-21
    publication rule exists to prevent.
  - Option 2 adds hand-writing every description to the launch path.
- **Q15 — when does an approved description go live?**
  - Recommendation: 1, immediately, but only for the joke members currently
    see.
  - The fact-wide publish exists so that what a member is offered changes all
    at once and consistently. A description that describes exactly the
    published content changes no drawing, no example and no other gag, so
    showing it alone cannot make the fact's set inconsistent.
  - Option 2 ties every catalogue description to unrelated draft work on the
    same fact.
  - Astra raised that this is an exception to the 2026-11-21 rule and
    belongs to David.

## Definition of Done

- **The behaviour can be exercised in the product:** a pet picture in a
  non-portrait shape, made from the builder's button, arrives in the builder
  in that shape with the pet's name on the caption, and Back from the flow
  leaves a half-made meme unchanged.
- **The panel is gone** from the builder, and its finished-picture selector
  remains.
- **Issue #1315 is closed** by the screens PR.
- **Every gag members can pick has a reviewed description** of its published
  content, visible in the dialog. Under Q15: 2, that includes the publishes
  that make them visible.
- **New or changed jokes cannot publish without a reviewed description.**
- **The parent plan carries a line pointing to this amendment.**
- **The Testing Plan's invariants pass on CI.**
