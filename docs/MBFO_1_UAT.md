# MBFO-1 — User acceptance testing (in-app)

You're the end user here. MBFO-1 is the **foundation** session for the Meme
Builder Flow Overhaul. By design, it ships almost nothing user-facing on the
production path — the wizard sits behind a build-time flag while the
Phase-3 builder keeps running for everyone else. So this UAT splits into
two halves:

1. **Flag-OFF half (production path):** prove the production meme-build
   flow is exactly as it was before MBFO-1. This is the regression check.
   You spend most of your time here on a normal dev build.
2. **Flag-ON half (preview path):** prove the new wizard shell renders,
   navigates, persists, and exits correctly. You run this in a Vite dev
   server with `VITE_MBFO_WIZARD=1` set.

The automated test side is in
[`MBFO_1_TEST_RUN.md`](./MBFO_1_TEST_RUN.md) and is owned by Replit AI; that
runs in parallel and you don't need to read it.

If anything in this UAT fails, write down which section + row, what you
saw vs. what you expected, and a screenshot if it's visual. I'll handle the
rest.

---

## What MBFO-1 explicitly does NOT ship

These are deferred to MBFO-2/3/4 and are NOT expected to work yet. If you
hit them in the wizard, that's expected — not a failure:

- **Step 2 content.** Step 2 today is a single placeholder panel that says
  "Step 2 controls land in the next MBFO session." There is no source
  picker, name/pronoun field, live preview, framing drag, or text-split
  slider yet. The "Make my meme" button on Step 2 is also non-functional
  — clicking it does nothing visible (the parent stays put).
- **Image / video tier gating.** Tapping Video on Step 1 as a free or
  anonymous user does NOT yet open an upgrade modal. Tier gating wires
  up in MBFO-2 alongside the unified upgrade modal.
- **Generation.** No PuLID, Grok Imagine, or auto-subtitle is invoked
  by the wizard. Those wire up in MBFO-3 (image) and MBFO-4 (video).
- **Save / share from the wizard.** No `POST /api/memes` from the wizard.
  Saving happens in MBFO-3 once Step 2 is real.
- **`split_token_index` population.** The DB column exists but is NULL
  for every fact. The renderer falls back to its midpoint heuristic.
  You should see ZERO change in how facts render anywhere in the app.

Anything outside that list — anything that exists on `main` today —
should still work exactly as it did before. The flag-OFF half of this
UAT exists to confirm that.

---

## Setup

1. Pull the latest of `claude/setup-mbfo-context-FbqqB`.
2. Boot the dev app in Replit. The session-start hook applies migrations
   automatically; if you opened the DB before the latest pull, force a
   re-apply with `pnpm --filter @workspace/db run migrate`. (MBFO-1
   adds one migration — `0053_facts_split_token_index.sql` — which
   adds a single nullable integer column to `facts`.)
3. You'll need one account in this session:
   - **Registered (free)** — any free-tier account is fine for MBFO-1.
     Legendary works too. Anonymous works for the entry-flow check
     but not the wizard interior (Step 1 has no tier gates yet).
4. You'll need at least one fact on hand — any fact in the facts list
   with at least one meme-build entry point on its detail page.
5. Devices to have on hand if at all possible:
   - A **real mobile phone** (iOS or Android). The wizard is
     mobile-first by design — the slide transitions and the
     sticky-bottom CTA need a real touch device to feel right.
   - Desktop browser (any). Some checks are easier with DevTools.

---

# PART ONE — flag OFF (production regression)

These rows run against the **default** dev build, no env var set. They
exist to prove the Phase-3 builder still works.

## Section A — fact detail page is unchanged

### A1. The fact detail page renders normally

Open a fact's detail page (`/facts/<id>`). The variant card, vote
buttons, comments, and any inline meme grid render exactly as they did
before MBFO-1.

**Pass / Fail:** ____.

### A2. The meme-build button opens the Phase-3 studio (not the wizard)

Click whatever button currently launches meme creation on the fact
detail page (varies per variant — the "Make a meme" / "Build a meme" /
similar CTA).

You should see the **existing Phase-3 MemeStudio** — the hub with
"AI gallery / Photo / Stock / Gradient / Magic video / Manual video"
path cards on a left rail (desktop) or as a breadcrumb (mobile). This
is the unchanged production experience.

You should **NOT** see a full-screen takeover with an "Image / Video"
selector. That's the wizard, which is gated off in this build.

**Pass / Fail:** ____.

### A3. The studio works end-to-end as before

Pick the simplest path you know works on production (typically Stock).
Make a quick test meme and save it. The save should succeed; the meme
detail page should open. No new errors in the console.

If you have an existing pre-MBFO-1 smoke runbook, run it. The point is
to confirm nothing about the production path moved.

**Pass / Fail:** ____.

---

## Section B — global app regressions

### B1. Cold homepage loads

Visit `/` in a fresh incognito window. The homepage renders. The
"Top facts" / leaderboard / hashtag tiles all load.

**Pass / Fail:** ____.

### B2. Existing meme permalinks still resolve

Open any pre-existing meme permalink (`/m/<slug>`). The detail page
renders, the OG card metadata is intact (View Source → look for the
`og:image` / `og:title` tags), and the share modal (Phase 6) still
opens.

**Pass / Fail:** ____.

### B3. Fact rendering is identical

This is the explicit check that the new `facts.split_token_index`
column doesn't somehow accidentally affect rendering. Pick any fact
you have a strong visual memory of (a leaderboard top-5 fact is fine).
Compare its text on the leaderboard, on its detail page, and inside a
created meme. The text should look exactly as it did before MBFO-1.

**Pass / Fail:** ____.

---

# PART TWO — flag ON (wizard preview)

These rows run against a build where you've set
`VITE_MBFO_WIZARD=1`. Easiest way: stop the Replit dev server, restart
it with the env var. From a terminal in the repo:

```bash
cd artifacts/overhype-me
PORT=5180 BASE_PATH=/ VITE_MBFO_WIZARD=1 \
  pnpm exec vite --config vite.config.ts --host 0.0.0.0
```

Then open `http://<your-replit-host>:5180/facts/<id>` and click the
meme-build button. From this point on, that button opens the wizard
instead of the Phase-3 studio.

If anything in Part Two fails, also confirm `import.meta.env.VITE_MBFO_WIZARD`
is actually `"1"` in DevTools console — typos here are the most common
cause of "the wizard didn't open".

---

## Section C — wizard chrome (the takeover, top bar, close)

### C1. The wizard opens as a full-screen takeover

Click the meme-build button. The wizard should:

- Cover the entire viewport (no app chrome / navbar / sidebar visible).
- Have a dark near-black background (`#111`, the brand near-black).
- Have a thin **orange progress fill** at the very top (~3px tall) at
  ~50% width (because you're on Step 1 of 2).
- Have a **back arrow** in the top-left that is visually present but
  greyed out / non-interactive (Step 1 has no "back" target).
- Have a **close X** in the top-right.

**Pass / Fail:** ____.

### C2. The back arrow is hidden on Step 1

Specifically: the back arrow should NOT respond to taps on Step 1. It
holds layout space for symmetry but it's invisible. Confirm by tapping
where the back arrow lives on Step 1 — nothing happens, the wizard
stays on Step 1.

**Pass / Fail:** ____.

### C3. The close X exits the wizard

Tap the close X. The wizard closes. You're returned to the underlying
fact detail page, scroll position preserved, no leftover backdrop. The
meme-build button you originally clicked is still there and clickable.

**Pass / Fail:** ____.

### C4. The progress bar advances on Step 2

Re-open the wizard. Tap the **Image** card to advance to Step 2.

The progress bar at the top should grow from ~50% to ~100%. The
transition is a smooth width tween (not an instant jump).

**Pass / Fail:** ____.

### C5. The back arrow becomes interactive on Step 2

On Step 2, the back arrow in the top-left is now fully visible (not
greyed out). Tap it. You return to Step 1.

**Pass / Fail:** ____.

---

## Section D — Step 1 (image / video selector)

### D1. The headline reads "What are we making?"

In the brand display font (Bebas Neue, uppercase, white). Body text
underneath: "Pick a format to start."

**Pass / Fail:** ____.

### D2. Two large cards: Image and Video

- **Image** card with a picture icon (small frame with a mountain inside).
- **Video** card with a video icon (a play triangle inside a frame).

Each card is a generous touch target with the title on the right and a
short subtitle underneath:
- Image: "A still meme with your name on it."
- Video: "Animated, with audio and captions."

**Pass / Fail:** ____.

### D3. Tapping a card advances to Step 2 with a slide-LEFT animation

Tap the Image card. The Step 1 content slides off to the left while
the Step 2 content slides in from the right. Duration is roughly a
quarter-second; the easing is smooth (not linear).

**Pass / Fail (slide direction):** ____.

**Pass / Fail (feels smooth, not stuttering):** ____.

### D4. The selected card stays visually selected when you go back

From Step 2, tap the back arrow. You return to Step 1 **and the Image
card is now visually highlighted** (orange border, orange-tinted fill,
icon background filled with orange). The Video card is back to its
default state.

**Pass / Fail:** ____.

### D5. Tapping the OTHER artifact card replaces the selection

From Step 1 with Image selected (per D4), tap the Video card. You
advance to Step 2 again. Go back. Step 1 should now show **Video**
highlighted, not Image. (A wizard remembers your latest selection,
not all selections.)

**Pass / Fail:** ____.

### D6. Back navigation animates slide-RIGHT

Look closely at the back-arrow transition (D4 / D5 / C5): the content
should slide in the **opposite** direction from D3. Step 2 slides off
to the right, Step 1 slides in from the left.

**Pass / Fail:** ____.

### D7. (Mobile only) Card tap targets are thumb-friendly

On your phone, the Image and Video cards should each be at least ~80px
tall. You shouldn't have to aim carefully to hit one.

**Pass / Fail:** ____.

---

## Section E — Step 2 (placeholder, expected to be empty)

This is the section that will grow in MBFO-3 (image path) and MBFO-4
(video path). Today it's a stub.

### E1. The headline reads "Build your meme"

In the brand display font. The subhead changes based on the artifact
you selected on Step 1:

- If you chose **Image** on Step 1: "Pick a photo, add your name. Tweak
  the placement."
- If you chose **Video** on Step 1: "Pick a photo, add your name. The
  motion runs on render."

Go back to Step 1, swap your selection, advance again — confirm the
subhead changes.

**Pass / Fail:** ____.

### E2. The placeholder panel is visible

Below the heading is a dashed-border panel that says:

> Step 2 controls land in the next MBFO session.
>
> Source picker · name · pronouns · live preview · framing · text split

That's the whole interior of Step 2 today.

**Pass / Fail:** ____.

### E3. The sticky-bottom "Make my meme" button is visible

Near the bottom of the viewport, a wide orange pill button reading
**Make my meme** is anchored. On mobile, it sits above the home-bar
inset (safe-area-inset-bottom is honored). Above the button there's a
short fade from transparent to the page background, so the button
doesn't sit on top of content abruptly.

**Pass / Fail:** ____.

### E4. The button is non-functional today (this is expected)

Tap **Make my meme**. Nothing visible happens. No toast, no navigation,
no console error. This is correct for MBFO-1 — the save/generate wiring
lives in later sessions. The button is here so the layout is real, not
so it works.

If anything DOES happen (a toast appears, the page reloads, the wizard
closes), file that — it means a placeholder hook got accidentally
wired up.

**Pass / Fail:** ____.

---

## Section F — sessionStorage draft persistence

The wizard auto-saves your in-progress state to sessionStorage with a
1-hour TTL, scoped per fact. These rows confirm that contract.

### F1. Refreshing the page mid-wizard rehydrates to where you were

1. Open the wizard from a fact detail page.
2. Tap **Video** to advance to Step 2.
3. While on Step 2, **reload the page** (browser refresh, or
   `Cmd+R` / `Ctrl+R`).

After reload, the fact detail page loads, then **the wizard re-opens
automatically — directly on Step 2** with Video as the selected
artifact. (The Step 2 placeholder panel shows the "video" subhead per
E1.)

Wait — actually, on reload, the wizard doesn't auto-open. The trigger
button doesn't re-fire. What you should see instead:

1. Page reloads.
2. The wizard is NOT visible (the trigger button hasn't been clicked).
3. **Click the meme-build button again.**
4. The wizard opens directly on **Step 2** with Video selected (NOT
   Step 1).

That's the persistence contract: the state survives a remount, but
the user has to re-launch the wizard from the same fact to see it.

**Pass / Fail:** ____.

### F2. Closing the wizard via X preserves the draft for re-open

1. Open the wizard, advance to Step 2, then close it via the X.
2. Click the meme-build button again **on the same fact**.
3. The wizard reopens on Step 2 with your prior artifact selection.

**Pass / Fail:** ____.

### F3. A different fact does NOT inherit another fact's draft

1. Open fact A. Open the wizard. Advance to Step 2 with Image. Close
   the wizard.
2. Navigate to a different fact B. Open its wizard.
3. The wizard for fact B opens on **Step 1**, not Step 2. No artifact
   is preselected.

**Pass / Fail:** ____.

### F4. The draft expires after 1 hour

Hardest to test in real time. The easy proxy: in DevTools → Application
→ Session Storage → your origin → find the key
`pending_meme_wizard_v2::<factId>` and inspect its value. It's a JSON
blob with a `capturedAt` field (a millisecond timestamp).

Edit the value directly: set `capturedAt` to a number 61 minutes in
the past (i.e. `Date.now() - 61 * 60 * 1000`). Then re-launch the
wizard from the same fact. It should open on **Step 1**, not Step 2,
and the storage row should be **gone** (the wizard clears stale rows
on read).

If editing JSON in DevTools isn't feasible, mark this row "skipped —
covered by automated test `wizardStorage.test.ts:expires entries older
than 1 hour`".

**Pass / Fail / Skipped:** ____.

### F5. No data leaks to localStorage

In DevTools → Application → Local Storage → your origin, **do not**
see any key starting with `pending_meme_wizard_`. The wizard
deliberately uses sessionStorage, not localStorage, so the draft dies
with the tab.

(localStorage may contain other unrelated keys from the rest of the
app — `auth_token`, `route_visits_*`, `collapse_*`, `fact_db_name` —
that's expected.)

**Pass / Fail:** ____.

### F6. The wizard does not collide with the legacy Phase-3 draft

If you've ever used the Phase-3 builder on this device, sessionStorage
may contain a `pending_meme_builder_v1::<factId>` key. The wizard uses
a DIFFERENT key prefix (`pending_meme_wizard_v2::`) and explicitly
ignores v1 payloads.

Open DevTools → Application → Session Storage. If you see both `v1::`
and `v2::` keys for the same factId, that's fine — they coexist.
Confirm by reading the keys (don't need to parse the JSON).

**Pass / Fail:** ____.

---

## Section G — accessibility & polish spot-checks

### G1. Keyboard navigation works

In the wizard on Step 1:

- Press **Tab**. Focus moves to the close X first, then to the back
  arrow (which is visually hidden on Step 1 but still in tab order —
  that's OK for now, MBFO-2 may refine), then to the Image card, then
  the Video card.
- Press **Enter** on a card. The wizard advances to Step 2.
- On Step 2, **Tab** through back arrow → close X → primary "Make my
  meme" button.

The focus ring is visible (a faint outline) on whichever element has
focus. If you can't see the focus ring at all, file that.

**Pass / Fail:** ____.

### G2. The dialog is announced as a dialog to screen readers

DevTools → Elements → find the wizard root. It should be
`<div role="dialog" aria-modal="true" aria-label="Meme builder" ...>`.

If you have VoiceOver / NVDA / TalkBack, open the wizard with the
screen reader on. It should announce "Meme builder, dialog" (or the
equivalent for your reader).

**Pass / Fail:** ____.

### G3. The progress bar has correct ARIA

DevTools → Elements → find the element with `role="progressbar"`. It
should have:

- `aria-label="Meme builder progress"`
- `aria-valuemin="1"`
- `aria-valuemax="2"`
- `aria-valuenow="1"` on Step 1, `"2"` on Step 2

**Pass / Fail:** ____.

### G4. Reduced-motion preference is honored

In macOS: System Settings → Accessibility → Display → Reduce motion.
In Windows: Settings → Accessibility → Visual effects → Animation
effects.

With reduced motion enabled, re-open the wizard and advance to Step 2.
The transition should be **instant** (or close to it — opacity-only,
no horizontal slide). Disable reduced motion again and confirm the
slide returns.

**Pass / Fail:** ____.

### G5. Brand consistency

The wizard should feel like the rest of the site:

- Dark near-black background.
- Orange accents on the progress fill, on the selected artifact card,
  and on the primary CTA — the brand `#ff6b35`.
- The "What are we making?" and "Build your meme" headlines use Bebas
  Neue (the brand display font).

**Pass / Fail:** ____.

### G6. Safe-area insets are honored on iOS

On an iPhone with a notch or Dynamic Island, the top bar of the wizard
should sit BELOW the inset (not under the camera cutout). The primary
CTA on Step 2 should sit ABOVE the home-bar inset (you shouldn't have
to fight the iOS home gesture to tap it).

**Pass / Fail:** ____.

---

## Section H — flag-off / flag-on coexistence

This is a sanity check that the build-time flag works as advertised.

### H1. With the flag UNSET, the wizard never renders

Restart the dev server **without** `VITE_MBFO_WIZARD=1`. Open a fact
detail page. Click the meme-build button. You get the Phase-3
MemeStudio. There is no path inside the production build that lands you
in the wizard.

**Pass / Fail:** ____.

### H2. With the flag SET, the Phase-3 studio is unreachable from FactDetail

Restart the dev server WITH `VITE_MBFO_WIZARD=1`. Open a fact detail
page. Click the meme-build button. You get the wizard. You should NOT
be able to see the Phase-3 hub from this entry point in this build.

(Other parts of the app that route through `MemeStudio` directly — if
any exist outside FactDetail — are unaffected by MBFO-1's flag. MBFO-1
only swaps the FactDetail entry. If you find another entry point still
launching MemeStudio in the flag-on build, note it — that's expected
for MBFO-1, but useful to inventory for MBFO-3.)

**Pass / Fail:** ____.

---

## Reporting failures

For each failed row, note:

- The Section letter + row number (e.g. "F4").
- Which account was logged in.
- Which device + browser + OS.
- Which fact you were on (the URL).
- What you saw vs. what you expected.
- A screenshot if it's visual; a screen recording if it's a
  transition / animation issue (Sections C, D, G4).

If the wizard silently fails to open with `VITE_MBFO_WIZARD=1` set,
capture:

- The value of `import.meta.env.VITE_MBFO_WIZARD` in DevTools console.
  (Should be `"1"`. If it's `undefined`, Vite didn't pick up the env
  var — restart the dev server with the variable exported from the
  shell, not just `pnpm run dev` with the var inline if your shell
  drops it.)
- Any error in DevTools → Console at the moment you clicked the
  meme-build button.

If the wizard renders but slide transitions are broken (no animation,
or animation in the wrong direction), capture:

- The value of `data-direction` on `[data-testid="meme-builder-wizard"] > div`
  in DevTools (it should be `"forward"` going Step 1 → 2 and `"back"`
  going Step 2 → 1).
- Whether `prefers-reduced-motion` is enabled in your OS.

MBFO-1 branch: `claude/setup-mbfo-context-FbqqB`.
