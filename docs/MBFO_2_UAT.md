# MBFO-2 — User acceptance testing (in-app)

You're the end user here. MBFO-2 is the **first user-visible session**
of the Meme Builder Flow Overhaul: it ships a real Step 1 of the
wizard (image / video card picker) and the cross-app upgrade modal.
Everything is still gated behind `VITE_MBFO_WIZARD=1`, so this UAT
splits into two halves:

1. **Flag-OFF half (production path):** prove the production meme-build
   flow is exactly as it was after MBFO-1. This is the regression
   check.
2. **Flag-ON half (preview path):** prove the new Step 1 renders, the
   tier × budget matrix behaves correctly, the upgrade modal works,
   the hero examples render (placeholder or real), navigation
   round-trips correctly, and state persists across reloads.

The automated test side is in
[`MBFO_2_TEST_RUN.md`](./MBFO_2_TEST_RUN.md) and is owned by Replit
AI; that runs in parallel and you don't need to read it.

If anything in this UAT fails, write down which section + row, what
you saw vs. what you expected, and a screenshot if it's visual. I'll
handle the rest. There's a bug-report template at the bottom.

---

## What MBFO-2 explicitly does NOT ship

These are deferred to MBFO-3/4/5 and are NOT expected to work yet. If
you hit them, that's expected — not a failure:

- **Step 2 content.** Step 2 today is still the MBFO-1 placeholder
  panel. There is no source picker, name/pronoun field, live preview,
  framing drag, or text-split slider yet. The "Make my meme" button
  on Step 2 is non-functional. **Do not flag Step 2 as broken** — it
  lands in MBFO-3.
- **The "Budget reached — resets {date}" overlay** on the video card.
  The component exists but the client-side budget endpoint that
  triggers it is deferred to MBFO-4. Every Legendary account will see
  the video card as fully tappable in MBFO-2, even one that has spent
  past its monthly limit. (The server-side gate still blocks at video
  generation time — but that's MBFO-4's territory.)
- **Stripe Embedded Checkout** inside the upgrade modal. The CTA
  currently does a full-page redirect to `/pricing`. MBFO-5 swaps
  that for an in-modal Stripe checkout.
- **Curated hero example assets.** The `hero_examples` table ships
  empty. Each card will show a brand-orange placeholder with
  "Example coming soon" microcopy unless you've manually seeded rows
  (see Section H).
- **Generation.** No PuLID, Grok Imagine, or auto-subtitle is invoked
  by the wizard. Those wire up in MBFO-3 / MBFO-4.

Anything outside that list — anything that exists on `main` today —
should still work exactly as it did before MBFO-2. The flag-OFF half
of this UAT exists to confirm that.

---

## Setup

1. Pull the latest of `main` (MBFO-2 was merged via PR #45).
2. Boot the dev app in Replit. The session-start hook applies
   migrations automatically; if you opened the DB before the latest
   pull, force a re-apply with `pnpm --filter @workspace/db run
   migrate`. (MBFO-2 adds one migration:
   `0054_hero_examples.sql` — one new table, one index, one CHECK
   constraint.)
3. You'll need three viewer states for this session. Easiest: have
   one Legendary account whose tier you can flip via the admin
   surface, plus a private window for unregistered.
   - **Unregistered** — just visit logged out.
   - **Registered (free)** — any free-tier account.
   - **Legendary** — a paid-tier account.
4. You'll need at least one fact on hand — any fact in the facts list
   with a meme-build entry point on its detail page.
5. Devices to have on hand if at all possible:
   - A **real mobile phone** (iOS or Android). MBFO-2 is mobile-first.
     The hero video on the video card needs `playsInline` autoplay,
     which is the kind of thing only a real device proves.
   - Desktop browser (Chrome preferred for the DevTools accessibility
     tree).

---

# PART ONE — flag OFF (production regression)

These rows run against the **default** dev build, no env var set.
They exist to prove the Phase-3 builder still works.

## Section A — production path is unchanged

### A1. The fact detail page renders normally

Open a fact's detail page. The variant card, vote buttons, comments,
and any inline meme grid render exactly as they did on `main` before
MBFO-2.

**Pass / Fail:** ____.

### A2. The meme-build button opens the Phase-3 studio (not the wizard)

Click whatever button currently launches meme creation on the fact
detail page. You should see the **existing Phase-3 MemeStudio** with
its source picker. You should **NOT** see a full-screen takeover with
an "Image / Video" selector.

**Pass / Fail:** ____.

### A3. The studio works end-to-end as before

Pick the simplest path you know works on production (typically Stock).
Make a quick test meme and save it. The save should succeed; the meme
detail page should open.

**Pass / Fail:** ____.

### A4. `/api/hero-examples` is independent of the flag

Even with the flag off, the endpoint should respond:

```bash
curl -s http://localhost:<api-port>/api/hero-examples
```

Expect `{"image":[],"video":[]}` (or whatever rows you've seeded).
This proves the new endpoint is safe to ship even before the wizard
flag flips on for prod.

**Pass / Fail:** ____.

---

# PART TWO — flag ON (the wizard)

Set `VITE_MBFO_WIZARD=1` and restart the dev server. Re-open the same
fact detail page. The meme-build entry point should now open the
**wizard takeover**, not the Phase-3 studio.

If it doesn't, stop here — the rest of the UAT depends on the wizard
mounting. Confirm the env var is set and the dev server actually
restarted.

## Section B — Step 1 layout & visuals (no clicks)

### B1. Wizard takeover

Full-screen overlay, dark background, no rest-of-app chrome visible
(no navbar, no sidebar, no footer). The whole viewport is the wizard.

**Pass / Fail:** ____.

### B2. Top bar

- Thin orange progress bar at roughly half-width (Step 1 of 2)
- Back arrow **hidden** on Step 1 (it should not be visible)
- Close (X) visible top-right

**Pass / Fail:** ____.

### B3. Headline

`What kind of meme?` centered, Bebas Neue display font, all caps.

**Pass / Fail:** ____.

### B4. Two stacked cards, no Continue button

Image card on top, video card below. They share roughly equal height
(each ~35-40% of viewport). There is **no Continue button** anywhere
on Step 1 — tapping a card is the action.

**Pass / Fail:** ____.

### B5. Video card chrome (always on)

Regardless of viewer tier, the video card has:

- A gold-to-orange gradient ring (`#ffb347 → #ff6b35 → #c2410c`)
  around the entire card edge
- A crown badge in the top-right corner of the card

The image card has neither.

**Pass / Fail:** ____.

### B6. Card captions

- Image: eyebrow `IMAGE MEME` + body `Classic format. Share anywhere.`
- Video: eyebrow `VIDEO MEME` + body `See yourself. AI-generated. Made for socials.`

Eyebrow is monospace, brand-orange. Body is white.

**Pass / Fail:** ____.

### B7. Hero asset rendering

If you've seeded assets (Section H below), each card shows the
seeded asset (image still on the image card; muted looping MP4 on
the video card).

If you haven't seeded, each card shows the brand-orange gradient
placeholder with `Example coming soon` microcopy. **Both states are
acceptable** — the placeholder is the launch default.

**Pass / Fail:** ____.

---

## Section C — tier × video-card state matrix

This is the headline UAT for MBFO-2. Repeat the wizard entry for each
viewer state and verify the video card.

### C1. Unregistered (logged out)

The video card shows:

- Inner content (hero video / placeholder) dimmed to ~50%
- Crown + gradient ring at full strength (NOT dimmed)
- Lock icon overlaid in the center
- Label: `Go Legendary to unlock` (monospace, gold)

**Pass / Fail:** ____.

### C2. Registered (free)

Same as C1 — identical visual state.

**Pass / Fail:** ____.

### C3. Legendary

The video card has:

- No dim
- No lock icon
- No "Budget reached" overlay
- Hero asset (or placeholder) visible at full opacity

**Pass / Fail:** ____.

### C4. Legendary over budget

**Skip this row in MBFO-2.** The component (`CardBudgetReached`)
exists but is not wired to a budget snapshot until MBFO-4. To
preview the visual in isolation, see Section J ("Forcing the
budget-reached visual").

---

## Section D — click handling

### D1. Image card → Step 2 (any tier)

For each of the three tiers, open the wizard, click the image card.
The wizard should slide left into Step 2 (the MBFO-1 placeholder is
fine here — you're testing the navigation, not the destination).

**Pass / Fail:** ____.

### D2. Unregistered: video card → upgrade modal

While logged out, click the video card. The upgrade modal opens and
the wizard does NOT advance to Step 2.

The modal contains:

- A crown icon + `LEGENDARY` chip
- Headline: `Go Legendary to make videos.`
- Subheadline: `Where legends are made up.`
- A four-item value-prop list (AI-stylized images, video memes,
  higher monthly budget, first access to new engines/styles)
- A primary `Go Legendary` CTA
- A `Not now` ghost button

**Pass / Fail:** ____.

### D3. Registered: video card → upgrade modal

Same as D2 — same modal, same headline. Tier doesn't change the copy.

**Pass / Fail:** ____.

### D4. Legendary: video card → Step 2

While logged in as Legendary, click the video card. The wizard
slides left into Step 2.

**Pass / Fail:** ____.

### D5. Upgrade modal CTA navigates to `/pricing`

In the open upgrade modal (from D2 or D3), click `Go Legendary`. The
browser navigates to `/pricing`. (MBFO-5 will replace this with an
in-modal Stripe Embedded Checkout — for now, full-page redirect is
correct.)

**Pass / Fail:** ____.

### D6. `Not now` and X both close the modal

Re-open the modal. Test both dismiss paths:

- Click `Not now` → modal closes, you're back on Step 1, no state
  changed
- Click the X (or press Escape) → same

**Pass / Fail:** ____.

### D7. Back from Step 2 returns to Step 1 with selection preserved

After D1 or D4 advances you to Step 2, click the back arrow (top-left
of the wizard). Wizard slides RIGHT back to Step 1. The card you
previously selected (image or video) shows a visual selection ring
(orange).

**Pass / Fail:** ____.

### D8. Close (X) on Step 1 exits the wizard

Click the X top-right. Wizard closes; you're back on the FactDetail
page.

**Pass / Fail:** ____.

---

## Section E — mobile-specific

In Chrome DevTools mobile emulation (iPhone 14 / Pixel 7) AND on a
real device if at all possible:

### E1. Cards fit viewport above-the-fold

Both cards are visible without scrolling. There's a small bottom
padding for the safe-area inset.

**Pass / Fail (emulation):** ____.
**Pass / Fail (real device):** ____.

### E2. Video autoplay works on iOS Safari

This is the test that only a real device can prove. On a real iPhone,
the hero video on the video card autoplays muted in a loop on first
paint. No "tap to play" overlay. (`playsInline` + `muted` + `autoPlay`
must all work together — iOS Safari is famously fussy about this.)

**Pass / Fail:** ____.

### E3. No audio plays from anywhere

There is never any audio from the video card. Confirm via the OS
mute icon (which should NOT appear) or by listening on a device with
volume up.

**Pass / Fail:** ____.

### E4. Tap targets cover the whole card

Tapping anywhere on the image card (corner, edge, middle) advances
to Step 2. Same for the legendary-tappable video card.

**Pass / Fail:** ____.

### E5. Modal usability on a narrow viewport

The upgrade modal renders without horizontal scroll on a 375px-wide
viewport. The CTA and `Not now` are both fully visible without
scrolling the modal body.

**Pass / Fail:** ____.

---

## Section F — state persistence

### F1. Selection survives a page refresh

On Step 1, click the image card → land on Step 2. Hard-refresh
(Cmd-Shift-R). The wizard should re-open directly to Step 2, NOT
back to Step 1.

(Implementation note: this uses `sessionStorage` with a 1-hour TTL,
keyed by factId.)

**Pass / Fail:** ____.

### F2. Selection survives close + reopen within 1 hour

On Step 1, click image. On Step 2, click the X to exit. Re-open the
wizard from the same fact. You should land on Step 2 again.

**Pass / Fail:** ____.

### F3. Selection expires after 1 hour

Optional / time-permitting. If you leave a draft for 1+ hour and
re-open, the wizard should return to Step 1. (Tedious to test
manually; the unit tests cover the TTL math.)

**Pass / Fail:** ____.

### F4. Drafts are scoped to factId

Open Fact A, click image (advance to Step 2). Navigate to Fact B,
open the wizard. Fact B should start fresh on Step 1, NOT inherit
Fact A's image selection.

**Pass / Fail:** ____.

---

## Section G — accessibility quick pass

### G1. Tab order is sensible

Tab through the wizard with the keyboard. Order should be: image
card → video card → close X. (Back arrow is hidden on Step 1, so
not in the tab order.) Focus rings are visible on each.

**Pass / Fail:** ____.

### G2. ARIA labels are correct

In Chrome DevTools → Accessibility tree:

- Image card: `role="button"`, `aria-label="Image"`
- Video card (legendary): `role="button"`, `aria-label="Video"`
- Video card (locked): still a button, `aria-label="Video"`
- Video card (budget-reached, when MBFO-4 lands): NOT a button,
  `aria-disabled="true"`

**Pass / Fail:** ____.

### G3. Reduced motion still triggers transitions but kills the easing

In OS Settings → "Reduce motion" ON. The Step 1 → Step 2 transition
still happens but is instant (no slide easing). Inherited from
MBFO-1.

**Pass / Fail:** ____.

### G4. Modal focus management

Open the upgrade modal. Focus moves into the modal automatically.
Press Escape; modal closes; focus returns to the video card.

**Pass / Fail:** ____.

---

## Section H — hero example seeding (optional, only if you want to verify the real-asset path)

If you only test the placeholder fallback, skip this section. To
verify the real-asset rendering path, seed at least one image and
one video row:

```sql
INSERT INTO hero_examples (artifact_type, asset_url, poster_url, caption_label, sort_order, active)
VALUES
  ('image', '<URL to any .jpg or .png you trust>', NULL, 'Image meme', 1, true),
  ('video', '<URL to any short .mp4>', NULL, 'Video meme', 1, true);
```

Then re-open the wizard. The image card should show the still; the
video card should autoplay the MP4 muted in a loop.

### H1. Image renders from URL

The seeded JPG appears in the image card (object-cover; fills the
card frame).

**Pass / Fail:** ____.

### H2. Video plays muted in a loop

The seeded MP4 plays automatically, muted, looped. No play button
overlay.

**Pass / Fail:** ____.

### H3. Multiple rows rotate per visit

Seed 3 image and 3 video rows with distinguishable assets. Open the
wizard, note which assets show. Hard-refresh and re-open. The shown
assets may be different — randomization is per-mount.

**Pass / Fail:** ____.

### H4. The same wizard session shows the same asset

Open the wizard, note assets. Click around within Step 1 (or
advance to Step 2 and come back). The assets should not switch
mid-session. (They're memoized for the lifetime of the mount.)

**Pass / Fail:** ____.

### H5. Inactive rows are excluded

Mark one row `active=false` via SQL, refresh, re-open the wizard a
few times. That row should never appear.

```sql
UPDATE hero_examples SET active=false WHERE asset_url='<your seed URL>';
```

**Pass / Fail:** ____.

### Cleanup

After testing, clear your seed:

```sql
DELETE FROM hero_examples WHERE asset_url LIKE '<your test prefix>%';
```

---

## Section I — known scaffolded but unreachable surfaces

Re-stating the deferred items so you don't try to test them and flag
them as broken:

- **`CardBudgetReached.tsx`** — scaffolded, never rendered in MBFO-2.
- **Stripe Embedded Checkout** — the upgrade modal redirects to
  `/pricing` instead.
- **Step 2 internals** — placeholder until MBFO-3.
- **`/api/me/video-budget`** — endpoint not built; resolver treats
  every Legendary user as tappable.

---

## Section J — forcing the budget-reached visual (engineering preview only)

Skip unless you want to eyeball the budget-reached overlay in a
browser before MBFO-4 lands. To force it:

1. Open
   `artifacts/overhype-me/src/components/meme-builder/wizard/state/useVideoCardState.ts`.
2. Temporarily replace the `legendary` branch with a hardcoded:
   ```ts
   if (args.tier === "legendary") {
     return { kind: "budget-reached", resetDate: "Jun 1" };
   }
   ```
3. Reload the wizard while logged in as Legendary. The video card
   should show the dim overlay with `Budget reached / Resets Jun 1`,
   and clicking should be a no-op.
4. **Revert the change before committing anything.**

---

## Bug-report template

Please format any issues like:

```
[Section / row, e.g. "C1"] Title
Tier: <unregistered / registered / legendary>
Viewport: <mobile / desktop, browser, OS>
Expected: ...
Observed: ...
Repro: ...
Screenshot/video: ...
```
