# Phase 3 — User acceptance testing

You're the end user here. This document walks you through every visible
change Phase 3 introduces so you can sign off (or send back) the work
before Phase 4 builds on top of it.

The automated test run is in
[`PHASE_3_TEST_RUN.md`](./PHASE_3_TEST_RUN.md). That covers correctness;
this document covers feel.

---

## Context — what shipped vs. what didn't

**Shipped this phase:**
- A new universal meme builder component and its full data model.
- Lineage columns on the database so future PuLID stylings are remembered
  per (user, fact, source photo, params) and never re-billed.
- The Pexels prefetch cap dropped from 80 → 10 images per gender, per fact.
- A new optional filter on `GET /users/me/uploads` so the new picker can
  separate raw uploads from AI stylings, scoped per fact.
- A dev-only `MatrixHarness` component that lets you preview every
  permutation of the new builder side-by-side with no code changes.

**Not yet wired into production:** the new builder does NOT appear in the
real fact detail / library / cold-permalink / remix entry points yet.
That migration is **Phase 5**. Phase-3 sign-off here means "the new code
behaves correctly when invoked" — production users still see the legacy
builder until Phase 5 flips the switch.

So most of this UAT is exercised through the harness, not through the
normal app flow.

---

## Setup

1. Open Replit and start the dev environment.
2. Confirm the API server and the frontend are both running.
3. Migration `0048_meme_builder_lineage` should already be applied. To
   double-check, run this in psql against your dev DB:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'upload_image_metadata'
  AND column_name IN ('transform','source_object_path','fact_id','transform_params_hash')
ORDER BY column_name;
```

You should see all four rows. If none come back, run the migration:

```bash
pnpm --filter @workspace/db migrate
```

---

## Section A — verify the data model

### A1. Migration applied

The query above should return four rows. **Pass / Fail:** ____.

### A2. Pexels cap reduced

Pick any active fact in the admin and trigger an image refresh, OR
inspect a recently-approved fact's `pexels_images` jsonb column:

```sql
SELECT jsonb_array_length((pexels_images->>'male')::jsonb) AS male_count,
       jsonb_array_length((pexels_images->>'female')::jsonb) AS female_count,
       jsonb_array_length((pexels_images->>'neutral')::jsonb) AS neutral_count
FROM facts
WHERE pexels_images IS NOT NULL
ORDER BY id DESC
LIMIT 5;
```

Expectation:
- Recently approved facts (post-Phase-3-deploy): each gender ≤ 10.
- Older facts: still up to 80 — they were prefetched before the cap
  changed and aren't re-fetched automatically. **This is intentional.**

**Pass / Fail:** ____. **Note any older facts you want re-fetched
manually:** ____.

### A3. The new uploads filter

Hit your dev API while logged in as any registered user. Expected
endpoints:

```bash
# default — only raw uploads (backwards-compatible)
curl -b cookies.txt "$DEV_URL/api/users/me/uploads"

# AI stylings only (will be empty until Phase-4 stylize endpoint ships)
curl -b cookies.txt "$DEV_URL/api/users/me/uploads?transform=ai"

# scoped to one fact's PuLID stylings
curl -b cookies.txt "$DEV_URL/api/users/me/uploads?transform=pulid&factId=42"

# everything (raw + AI)
curl -b cookies.txt "$DEV_URL/api/users/me/uploads?transform=all"
```

Each row in the response should include four new fields:
`transform`, `sourceObjectPath`, `factId`, `transformParamsHash`.

**Pass / Fail:** ____.

---

## Section B — visual review of the new builder

The dev component `MatrixHarness` renders the new builder against any
(mode, tier, entryFlow) combination you pick. To use it, mount it
temporarily in dev:

```tsx
// somewhere in your dev routing
import { MatrixHarness } from "@/components/meme-builder/__demo__/MatrixHarness";
// ...
<Route path="/dev/builder-matrix" component={MatrixHarness} />
```

Or, if you'd rather not edit routing yet, ask the engineer to do this
once and ship it behind an `import.meta.env.DEV` guard.

Once it's mounted, navigate to `/dev/builder-matrix` and walk through
each row of the table below. For each row:

- Set the three pickers at the top (mode / tier / entryFlow).
- Confirm the cell renders as described.
- Confirm the JSON debug box shows `invalid: false` (or `true` for
  invalid rows).

### Behavior matrix walkthrough

| Mode | Tier | EntryFlow | Expected | Pass? |
|---|---|---|---|---|
| stock | unregistered | cold-permalink | header reads "See this fact with YOUR name". Picker shows ≤10 stock thumbs. Action bar shows **Download** and **Save and share — sign up free**. NO save button. | |
| stock | unregistered | fact-detail | same as above but header reads "Build your meme". | |
| stock | unregistered | remix | header reads "Make this meme your own". | |
| stock | registered | fact-detail | Action bar shows **Download / Save meme / Share**. NO Try AI mode. | |
| stock | registered | cold-permalink | Same actions, header reads "See this fact with YOUR name". | |
| stock | legendary | fact-detail | Action bar plus a **Try AI mode** ghost button on the right. | |
| self-upload | unregistered | (any) | Tier-locked panel: "Sign up free to upload your photo" + Sign up button. NO builder beneath. | |
| self-upload | registered | fact-detail | Picker has tabs: **Primary / My photos / Upload new** (no AI stylings tab). NO stylize toggle. | |
| self-upload | registered | cold-permalink | Header reads "See this fact with YOUR face". | |
| self-upload | legendary | fact-detail | Picker has four tabs including **AI stylings**. **Stylize me with AI** toggle is visible below the picker. | |
| self-upload | legendary | cold-permalink | Header reads "See yourself as the AI subject". | |

Spot-check on top of those:

- Picking an image from "AI stylings" should disable the stylize toggle
  with a helper message. **Pass / Fail:** ____.
- Switching the entryFlow picker without changing mode/tier should not
  reset the rest of the form (name/pronouns persist). **Pass / Fail:** ____.

---

## Section C — input modality (mobile vs. desktop)

The picker layout switches based on input modality, **not** viewport width.

### C1. Desktop with mouse

Open the harness on a laptop with a mouse plugged in. Pick `mode=stock`
and any registered tier. The stock thumbnails should appear in a **grid**
(3–5 columns).

Now resize the browser window all the way down to ~400 px wide. The
layout stays a grid because the input modality didn't change.

**Pass / Fail:** ____.

### C2. Touch device (or DevTools touch emulation)

Open Chrome DevTools → toggle device emulation → pick a touch device.
Reload the harness. The thumbnails should now appear as a **horizontal
scrollable strip** with snap-to-thumbnail behavior. Drag your finger /
mouse horizontally — each card should snap to the start.

**Pass / Fail:** ____.

---

## Section D — name / pronoun input + token substitution

Set `mode=stock`, `tier=registered`, any entryFlow.

| Type | In Name | In Pronouns | Expected preview text |
|---|---|---|---|
| 1 | Quinn | he/him | reads "QUINN PUSHES THE BOULDER UPHILL HIS ENTIRE LIFE." |
| 2 | Quinn | she/her | reads "QUINN PUSHES … HER ENTIRE LIFE." |
| 3 | Quinn | they/them | reads "QUINN **PUSH** THE BOULDER UPHILL **THEIR** ENTIRE LIFE." (note the verb conjugation) |
| 4 | (blank) | they/them | reads with `___` placeholder where the name would be. |

The harness uses a fixture template:
`{NAME} {singular|plural} pushes the boulder uphill {POSS} entire life.`

**Pass / Fail per row:** 1: ____  2: ____  3: ____  4: ____.

---

## Section E — picker scrubbing does not spam the network

Open DevTools → Network tab → filter to `pexels-images`.

In the harness with `mode=stock`, scrub through stock thumbnails as fast
as you can — click a different thumbnail every ~50 ms.

The Network tab should show:
- The initial `GET /api/facts/.../pexels-images` for the fact (one
  request).
- Zero or one debounced render request per ~150 ms while scrubbing.
- No request storm.

**Pass / Fail:** ____.

(Phase 4 adds the actual `/api/render-preview` endpoint that gets
debounced; today the picker is debounced but no render endpoint is hit
yet because the canvas preview is client-side.)

---

## Section F — self-upload error states

Set `mode=self-upload`, `tier=registered`, `entryFlow=fact-detail`. Pick
the **Upload new** tab. Try each of the failure cases:

| Test | What to do | Expected message |
|---|---|---|
| F1 — too large | Drag a > 15 MB image | "That file is too big. Try one under 15 MB." |
| F2 — invalid format | Drag a `.tiff` or `.heic` file | "Use a JPEG, PNG, or WebP image." |
| F3 — moderation rejection | Upload an image that the Phase-1 Arachnid / NSFW classifier rejects (your dev env should have an obvious test fixture for this) | "This image cannot be used. Please try a different one." (NO classifier details exposed.) |
| F4 — network error | Kill the API server, drag a valid image | "Something went wrong. Check your connection and try again." |

After any error you should see a **Try another** button. Clicking it
re-opens the file picker.

**Pass / Fail per row:** F1: ____  F2: ____  F3: ____  F4: ____.

---

## Section G — signup interruption

Set `mode=stock`, `tier=unregistered`, any entryFlow.

1. Type your name. Pick pronouns. Pick a stock image.
2. Click **Save and share — sign up free**.
3. The harness's onComplete callback should fire with
   `{ kind: 'signup-required', pendingState }` — open DevTools console;
   the harness logs every onComplete call.
4. The pendingState's name, pronouns, and stockImageId should match
   what you entered.
5. Open DevTools → Application → Session Storage. There should be a key
   `pending_meme_builder_v1::42` containing the same shape.
6. Reload the page. Re-mount the harness with `tier=registered`
   (simulating completed signup). Without changing anything else, the
   builder should re-appear with the same name, pronouns, and stock
   selection. (For now you'll have to manually pass `initialPendingState`
   — Phase 5 wires this through routing.)
7. After the simulated signup, the sessionStorage key should clear once
   you successfully save.

**Pass / Fail per step:** 1: ____  2: ____  3: ____  4: ____  5: ____  6: ____  7: ____.

---

## Section H — legendary stylize flow (smoke-only)

Set `mode=self-upload`, `tier=legendary`, any entryFlow.

1. Pick or upload a photo.
2. Toggle **Stylize me with AI** on.
3. Click **Save meme**.
4. The blocking PuLID overlay should appear with a progress bar.

Note: until Phase 4 ships the dedicated stylize endpoint with dedup +
no-face fallback, the underlying call may fail (the legacy AI generate
route returns 422 + `noFaceDetected: true` instead of falling through).
That's expected. What you're verifying here is:

- The toggle is only visible on legendary. **Pass / Fail:** ____.
- The toggle hides itself when you pick an existing AI styling from the
  AI stylings tab. **Pass / Fail:** ____.
- The progress overlay renders, blocks interaction, and has a working
  Cancel button. **Pass / Fail:** ____.

---

## Section I — full-page sign-off

After A–H, give a single overall sign-off:

| | OK | Concerns |
|---|---|---|
| Data model is correct and reversible | | |
| Behavior matrix matches what we agreed | | |
| Picker modality detection feels right | | |
| Self-upload errors don't leak classifier details | | |
| Signup interruption preserves state | | |
| Stylize toggle gating is correct | | |

**Sign-off:** ____  **Date:** ____

---

## Reporting issues

If anything in this UAT fails, please file the failure with:

1. Which section / row failed.
2. What you saw.
3. What you expected.
4. A screenshot if visual.
5. The relevant DevTools network request / sessionStorage shape if data.

The Phase-3 branch is `claude/setup-overhype-project-GDzfb`.
