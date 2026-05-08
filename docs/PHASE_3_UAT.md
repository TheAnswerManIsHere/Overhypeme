# Phase 3 — User acceptance testing (in-app)

You're the end user here. The new universal meme builder is now wired
into the live Studio in place of the legacy builder, so this UAT runs
**entirely in the running app** — no `curl`, no SQL, no DevTools digging
required. The automated test side is in
[`PHASE_3_TEST_RUN.md`](./PHASE_3_TEST_RUN.md) and is owned by Replit AI;
that runs in parallel and you don't need to read it.

If anything in this UAT fails, write down which section + row, what you
saw vs. what you expected, and a screenshot if it's visual. I'll handle
the rest.

---

## Setup

1. Open the dev app in Replit and sign out so you start fresh.
2. Pick any active fact and click **Make a meme** (or whatever the entry
   button is called on the fact card / fact detail page). The Studio
   modal opens.
3. The Studio's left rail / hub still shows the four image paths
   (Stock Photo, Photo Editor, AI Gallery, Gradient). Each one now
   mounts the **new** universal builder behind the scenes — that's what
   you're testing.

What's expected to be partial in this build:

- **Save**, **Share**, **Download**, and **Try AI mode** buttons emit
  callbacks but don't yet wire to the production share / upgrade flows.
  Verify they appear and click without crashing — Phase 5/6 finishes the
  wire-up.
- The "Stylize me with AI" toggle for legendary users renders and shows
  the blocking PuLID overlay when toggled on + Save, but the underlying
  fal.ai call is the legacy `/api/memes/ai/:factId/generate` route, so a
  successful stylization isn't yet persisted as a library row. Phase 4
  finishes that.
- The **Gradient** path is being deprecated and currently routes to the
  Stock builder with a small notice at the top. Confirm the notice
  appears.

Everything else (behavior matrix, picker modality, tokens, debounce,
upload errors, signup interruption) should work today.

---

## Section A — open the Studio as an unregistered (not-logged-in) user

You should be signed out for this section.

### A1. Stock Photo path

1. Open the Studio → **Stock Photo**.
2. Header reads "See this fact with YOUR name" (if you came from a
   shareable URL with `?name=...`) or "Build your meme" (default).
3. Name and pronouns fields appear, pre-filled empty (or with the
   query-string value if there was one).
4. A horizontal strip of stock thumbnails appears (touch device) or a
   3–5 column grid (desktop with mouse).
5. Picking a thumbnail outlines it in fire-orange.
6. Action bar at the bottom shows **Download** and **Save and share —
   sign up free**. **It must NOT show a Save button.**

**Pass / Fail:** ____.

### A2. Photo Editor path (self-upload)

1. Open the Studio → **Photo Editor**.
2. Instead of a builder, you should see a **tier-locked panel** with
   "Sign up free to upload your photo" and a Sign up button.
3. The Sign up button kicks off the login flow.

**Pass / Fail:** ____.

### A3. AI Gallery path

1. Open the Studio → **AI Gallery**.
2. You should see the existing AccessGate "Log in to generate AI scenes
   of you for this fact." (This pre-existing gate stays until you log
   in — that's intentional.)

**Pass / Fail:** ____.

---

## Section B — open the Studio as a registered (free) user

Log in to a non-legendary account before this section.

### B1. Stock Photo path

1. Open the Studio → **Stock Photo**.
2. Same UI as A1, but the action bar now shows **Download / Save meme /
   Share** with **no signup CTA** and **no Try AI mode** chip.
3. Type a name; the live preview re-renders with your name substituted
   into the fact text (verify the fact text is using your name).
4. Change pronouns to **they/them**. Verify the verb conjugation
   actually flips (e.g. "they push" not "they pushes").

**Pass / Fail per row:** B1.2: ____  B1.3: ____  B1.4: ____.

### B2. Photo Editor path

1. Open the Studio → **Photo Editor**.
2. The picker now appears with three tabs: **Primary / My photos /
   Upload new**. (No "AI stylings" tab — that's legendary-only.)
3. **No Stylize toggle** is visible.
4. If you don't have an avatar yet, the Primary tab is hidden and the
   builder lands on Upload new.

**Pass / Fail:** ____.

### B3. Gradient path

1. Open the Studio → **Gradient**.
2. A small notice at the top reads "Gradient backgrounds are being
   phased out…"
3. Below the notice, the Stock Photo builder is mounted (same UX as
   B1).

**Pass / Fail:** ____.

---

## Section C — open the Studio as a legendary user

Log in to a legendary account.

### C1. Stock Photo path

1. Open the Studio → **Stock Photo**.
2. Same UI as B1, plus a **Try AI mode** ghost button on the right of
   the action bar.
3. Clicking Try AI mode emits the upgrade-required callback (the modal
   closes for now; Phase 5 wires the upsell flow).

**Pass / Fail:** ____.

### C2. Photo Editor path with stylize toggle

1. Open the Studio → **Photo Editor**.
2. The picker now has a **fourth tab — AI stylings** (alongside
   Primary / My photos / Upload new).
3. The **Stylize me with AI** toggle is visible below the picker.
4. Pick or upload a photo.
5. Toggle Stylize on. Click **Save meme**.
6. The blocking PuLID progress overlay appears with a progress bar and
   a Cancel button. Cancel works.
7. **Test:** pick an image from the AI stylings tab (after at least one
   stylization has been generated for this fact). The stylize toggle
   should auto-disable with a helper message: "This image is already
   AI-stylized."

**Pass / Fail per row:** C2.2: ____  C2.3: ____  C2.5: ____  C2.6: ____  C2.7: ____.

### C3. AI Gallery path

1. Open the Studio → **AI Gallery**.
2. The new builder mounts in self-upload mode with the stylize toggle
   visible by default.

**Pass / Fail:** ____.

---

## Section D — input modality (mobile vs. desktop)

The picker layout switches based on input modality, **not** viewport
width.

### D1. Desktop with mouse

Open the Studio → Stock Photo on a laptop with a mouse plugged in.
The stock thumbnails should appear in a **grid** (3–5 columns).

Resize the browser down to ~400 px wide. The layout stays a grid because
the input modality didn't change.

**Pass / Fail:** ____.

### D2. Touch device (or DevTools touch emulation)

In Chrome DevTools, toggle device emulation → pick any touch device →
reload. The thumbnails are now a **horizontal scrollable strip** with
snap-to-thumbnail behavior. Drag your finger / mouse horizontally — each
card snaps to the start.

**Pass / Fail:** ____.

---

## Section E — token substitution + entry flow copy

### E1. Token substitution

In the Studio (Stock Photo path, registered or higher), type each row
in the table and verify the live preview matches:

| Type | Name | Pronouns | Expected preview text |
|---|---|---|---|
| 1 | Quinn | he/him | substitutes "him/his/he" naturally |
| 2 | Quinn | she/her | substitutes "her/hers/she" naturally |
| 3 | Quinn | they/them | substitutes "them/their/they" AND verb conjugates correctly (e.g. "they push" not "they pushes") |
| 4 | (blank) | they/them | placeholder dashes (`___`) where the name would be |

**Pass / Fail per row:** 1: ____  2: ____  3: ____  4: ____.

### E2. Entry-flow header copy

This is harder to test from the studio because every studio mount uses
`entryFlow='fact-detail'`. The other entry flows
(cold-permalink / library / remix / creation) are wired by Phase 5.
For now confirm the header on every studio open reads "Build your meme"
(neutral creation copy).

**Pass / Fail:** ____.

---

## Section F — picker scrubbing does not spam the network

1. Open the Studio → Stock Photo (any logged-in tier).
2. Open DevTools → Network tab → filter to `pexels-images`.
3. The initial load shows one `GET /api/facts/<id>/pexels-images?...`
   request.
4. Click rapidly through 8–10 different stock thumbnails (a click every
   ~50 ms).
5. The Network tab should show **no further requests storm**. The
   live-preview canvas re-renders client-side, debounced at 150 ms, so
   no extra Pexels round-trips fire while you scrub.

**Pass / Fail:** ____.

---

## Section G — self-upload error states

Log in as a registered user. Open the Studio → Photo Editor → Upload
new tab.

| Test | What to do | Expected message |
|---|---|---|
| G1 — too large | Drag a > 15 MB image | "That file is too big. Try one under 15 MB." |
| G2 — invalid format | Drag a `.tiff`, `.heic`, or `.bmp` file | "Use a JPEG, PNG, or WebP image." |
| G3 — moderation rejection | Upload an image the Phase-1 NSFW classifier rejects (your test fixture for this) | "This image cannot be used. Please try a different one." (NO classifier details exposed.) |
| G4 — network error | Disconnect Wi-Fi or stop the dev API server, then drag a valid image | "Something went wrong. Check your connection and try again." |

After every error a **Try another** button appears that re-opens the
file picker without page reload.

**Pass / Fail per row:** G1: ____  G2: ____  G3: ____  G4: ____.

---

## Section H — signup interruption (preserves your work)

Sign out. Then:

1. Open any fact → Studio → **Stock Photo**.
2. Type your name. Pick a pronoun. Click a stock thumbnail.
3. Click **Save and share — sign up free**.
4. The login flow opens.
5. Complete signup or log in.
6. Re-open the same fact's Studio → Stock Photo.
7. **Expected:** the name, pronouns, and selected stock thumbnail are
   restored. You can immediately click Save without re-typing anything.
8. After a successful Save, the preserved state is cleared (re-opening
   the studio shows a fresh blank form, not your old draft).

**Pass / Fail per step:** 3: ____  6: ____  7: ____  8: ____.

---

## Section I — gradient deprecation notice

Open the Studio → **Gradient**. Confirm:

- A notice banner reads "Gradient backgrounds are being phased out.
  We've routed you to stock photos for now."
- Below the notice the Stock Photo builder is mounted and works
  identically to Section B1 / C1.

**Pass / Fail:** ____.

---

## Section J — full-page sign-off

After A–I, give a single overall sign-off:

| | OK | Concerns |
|---|---|---|
| Behavior matrix matches what we agreed | | |
| Picker modality detection feels right | | |
| Token substitution works for he/she/they | | |
| Self-upload errors don't leak classifier details | | |
| Signup interruption preserves state | | |
| Stylize toggle gating is correct | | |
| Gradient deprecation notice is clear | | |
| Studio still feels cohesive (no broken layouts) | | |

**Sign-off:** ____  **Date:** ____.

---

## Reporting issues

If anything fails, please file with:

1. Which section / row.
2. What you saw.
3. What you expected.
4. A screenshot if visual.
5. Browser + tier (logged-out / registered / legendary).

Phase-3-adjacent branches: `claude/setup-overhype-project-GDzfb` (this
work) and `codex/follow-up-on-github-mention` (PR #38, framing transform
follow-up).
