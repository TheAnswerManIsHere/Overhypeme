# Phase 5 — User acceptance testing (in-app)

You're the end user here. Phase 5 ships three things you'll feel in the
product:

1. **The meme detail page now adapts to who you are and whose meme it is.**
   There are seven distinct states (anonymous viewing someone else's vs.
   your-own-fresh-render; registered viewing your own vs. someone else's;
   legendary viewing your own stock-mode vs. your own PuLID vs. someone
   else's). Each state surfaces a different primary action.
2. **Permalink URLs moved from `/meme/:slug` to `/m/:slug`.** Greenfield —
   nothing in the wild is hitting the old path. You'll just notice the
   shorter URL when you copy a share link.
3. **Open Graph cards.** When you paste an `/m/:slug` link into a social
   composer (Discord, Slack, Twitter/X, iMessage, LinkedIn, Facebook), it
   unfurls into a proper preview card with the meme image instead of the
   generic site title.

The automated test side is in
[`PHASE_5_TEST_RUN.md`](./PHASE_5_TEST_RUN.md) and is owned by Replit AI;
that runs in parallel and you don't need to read it.

The deploy runbook (Cloudflare worker rollout + verification) is in
[`PHASE_5_DEPLOY.md`](./PHASE_5_DEPLOY.md). Replit owns that too.

If anything in this UAT fails, write down which section + row, what you
saw vs. what you expected, and a screenshot if it's visual. I'll handle
the rest.

---

## Setup

1. Pull the latest of `claude/setup-overhype-project-g8QzX`.
2. Boot the dev app in Replit. The session-start hook applies migrations
   automatically; if you opened the DB before the latest pull, force a
   re-apply with `pnpm --filter @workspace/db run migrate`. (Phase 5
   itself adds no migrations — this is just hygiene.)
3. You'll need three accounts in this session, ideally already logged in
   in three separate browsers (or the same browser using a normal
   window + incognito + private):
   - **Anonymous** — signed out.
   - **Registered (free)** — a free-tier account with **no** profile
     photo on file. We'll use this to verify the "stock + upload nudge"
     fallback.
   - **Legendary** — a legendary-tier account. Use the dev admin panel
     to grant Legendary if you don't already have one. Keep this account
     **with a profile photo on file** so the legendary CTA paths get the
     PuLID stylize toggle they expect.
4. You'll need at least three memes on hand for cell coverage:
   - **Meme A** — created by your Registered account, **stock-mode**
     (i.e. built from a Pexels photo, not a self-upload).
   - **Meme B** — created by your Legendary account, **stock-mode**
     (the meme's `imageTransform` is null).
   - **Meme C** — created by your Legendary account, **PuLID-stylized**
     (you used the legendary "stylize me" toggle in the builder; the
     meme's `imageTransform` is `pulid`).

   Make all three on the same fact if it's easier — note the fact ID
   from the URL.
5. Have a Discord server, a Slack workspace, and a Twitter/X account
   ready. If you only have one or two of those, that's fine; record
   which platforms you couldn't test.

What's expected to be partial in this build:

- **Custom social share** is a Phase-6 dependency. In Phase 5, the
  "Custom share" button calls `navigator.share()` (mobile) or copies
  the URL to clipboard (desktop). That's enough for UAT.
- **NSFW OG cards.** The schema is plumbed (`is_nsfw` is propagated
  through `/api/memes/:slug` and the OG endpoint reads it) but no
  placeholder image was shipped yet because NSFW mode itself isn't
  shipped. Tests cover the data path; the visual swap will come with
  NSFW mode.
- **Cloudflare Worker.** In Replit dev, the worker doesn't run — you'll
  hit the api-server and SPA directly. Section F covers production
  paste tests once the worker is deployed.

---

## Section A — anonymous viewing someone else's meme (`anon-other`)

You're signed out for this section. Open the permalink for **Meme A**
(the registered-user-built stock meme) — `/m/<slug>`.

### A1. The page loads with the inline name+pronoun input

1. The SAVED chip + dimensions metadata + meme image + heart count + the
   "WHAT'S NEXT?" header are all visible.
2. The primary CTA is a card with the heading **"See it with your
   name"** and contains:
   - A name input (placeholder "Your name").
   - A pronoun dropdown (defaulting to `they/them`).
   - A button labelled "See it with your name".
3. Below the card, a **"Browse more facts"** secondary button.
4. Below that, a **tier ladder** — two side-by-side cards: "Free" (sign
   up) on the left, "Legendary" on the right.

There must NOT be a Download button, Merch button, or "Make this fact
about me" button visible. Those belong to other cells.

**Pass / Fail:** ____.

### A2. Submitting the name opens the builder pre-seeded

1. Type "Casey" in the name input.
2. Pick `she/her` from the dropdown.
3. Click **See it with your name**.
4. The full-screen meme builder slides in. The **stock photo picker** is
   visible (not the upload zone — anonymous users are stock-only). The
   live preview shows the fact text rendered with "Casey" and `she/her`.
5. The stock photo currently selected matches the one from Meme A (so
   the preview looks similar to the meme you just viewed, but with
   Casey's name).

**Pass / Fail:** ____.

### A3. The builder respects anonymous limits

1. With the builder still open, click around the action bar. There
   should be `Download` and `Sign up to save` (or similar) actions.
2. There must NOT be a `Save` action — anonymous users can't persist
   memes.
3. Close the builder. You're back on the meme detail page, still
   signed out.

**Pass / Fail:** ____.

### A4. "Browse more facts" goes to the library

Click it. You land on `/library`.

**Pass / Fail:** ____.

### A5. Tier ladder cards link out

1. The "Free" card → `/login`.
2. The "Legendary" card → `/pricing`.

**Pass / Fail:** ____.

---

## Section B — registered user viewing their own meme (`registered-own`)

Log in to your **Registered** account. Open Meme A (which you created).

### B1. Two primary actions: Download + Custom share

The primary row has two equal-weight buttons:
- **Download** (downward arrow icon).
- **Custom share** (share icon).

**Pass / Fail:** ____.

### B2. The Legendary upsell is concrete, not generic

Below the primaries, there's a Legendary upsell card with a crown icon
and the heading "Turn this up to 11".

The body copy must reference the meme's actual creator name. Since you
created Meme A and your display name is shown there, the copy reads
something like:

> See yourself in this meme like **<your display name>**, not just your
> name.

(For Meme B / C — created by Legendary user with a different display
name — the body would name that person. For this UAT row you're the
creator so the name is your own. The point is the copy is **never**
"see yourself in any meme" — always tied to a real person.)

**Pass / Fail:** ____.

### B3. Merch tertiary still works

Below the upsell, a single secondary button: **Wear this meme**.
Clicking it goes to `/wear/<slug>?source=meme-page` — the existing
Zazzle-redirect page. Confirm the page loads and the existing "Open in
Zazzle" flow is unbroken.

**Pass / Fail:** ____.

### B4. Download produces a JPEG

Click Download. Your browser saves `overhype-<slug>.jpg`. (The bytes
come from `/api/memes/<slug>/image`, the existing path — Phase 5 didn't
change download mechanics for already-saved memes.)

**Pass / Fail:** ____.

### B5. Custom share copies the link or invokes the OS sheet

Click Custom share.

- On a desktop browser without `navigator.share()`: the URL
  `https://<host>/m/<slug>` is copied to clipboard and an alert
  confirms.
- On mobile / browsers that support it: the OS share sheet opens with
  the meme title + URL pre-filled.

This is a placeholder; Phase 6 owns the real custom-share flow.

**Pass / Fail:** ____.

---

## Section C — registered user viewing someone else's meme (`registered-other`)

Still on your Registered account. Open Meme B (built by your Legendary
account — you didn't create it).

### C1. Primary is "Make this fact about me"

The primary CTA is a single button **"Make this fact about me"** with a
right-arrow icon.

**Pass / Fail:** ____.

### C2. The builder opens in stock mode with the upload nudge

The Registered account in this UAT was set up **without** a profile
photo. So clicking the primary should:

1. Open the builder overlay.
2. Show a small banner above the builder: "Tip: Want your photo in this?
   Add one in your profile and we'll use it next time."
3. The builder is in **stock mode** (stock picker visible) — not the
   self-upload zone.

If you want to verify the other branch of this fork: open your profile,
upload a photo, then come back to Meme B and click the CTA again. Now
the builder should open in **self-upload mode** with your avatar
pre-selected, and the upload nudge should NOT appear. Roll the photo
back if you want to keep the registered account "no photo" for the
rest of this UAT.

**Pass / Fail (no-photo):** ____.

**Pass / Fail (with-photo):** ____.

### C3. Secondary is "Browse more facts"

Same as Section A — links to `/library`.

**Pass / Fail:** ____.

### C4. Legendary upsell mentions the actual creator

The upsell card body reads "see yourself in this meme like **<Legendary
account display name>**, not just your name" — using the name of the
Legendary user who created Meme B.

**Pass / Fail:** ____.

### C5. Builder save returns to a new permalink

Inside the builder, type a name, pick `they/them`, then click Save.
After the save completes, the URL changes to `/m/<new-slug>` (a
**different** slug from Meme B's). You're now viewing your own
freshly-created meme.

**Pass / Fail:** ____.

---

## Section D — legendary viewing their own stock meme (`legendary-own-stock`)

Log out of Registered and into **Legendary**. Open Meme B (which you
created in stock mode).

### D1. Primary is "Turn this up to 11"

The primary CTA has a crown icon and reads **"Turn this up to 11"**.

**Pass / Fail:** ____.

### D2. Clicking it opens the builder in self-upload mode with name preserved

1. Click "Turn this up to 11".
2. The builder opens. The mode picker shows **self-upload** (the photo
   picker, not the stock picker).
3. The legendary **"Stylize me with AI"** toggle is visible (this is the
   real PuLID lever — Phase 3 deliberately doesn't expose `pulid` as a
   distinct mode).
4. The name field is pre-populated with the **same name** that's on
   Meme B (your Legendary account's display name).
5. Pronouns are pre-populated to your account's setting.

**Pass / Fail:** ____.

### D3. Secondary row: Download + Custom share

Side-by-side buttons, both with secondary styling.

**Pass / Fail:** ____.

### D4. Tertiary: Merch (Wear this meme)

Same as Section B — links to `/wear/<slug>?source=meme-page`.

**Pass / Fail:** ____.

---

## Section E — legendary viewing their own PuLID meme (`legendary-own-pulid`)

Still on Legendary. Open Meme C — the PuLID-stylized meme you created.

### E1. "Turn this up to 11" is gone

There must be NO "Turn this up to 11" button anywhere on the page.
Phase 5 detects `meme.imageTransform === "pulid"` and hides it (the
meme is already at 11).

**Pass / Fail:** ____.

### E2. Download + Custom share are PRIMARIES

Both buttons get primary styling (full-width orange, white text) — not
secondary. The visual rhythm is "you got the prize, here's how to use
it" rather than "let's do another lap".

**Pass / Fail:** ____.

### E3. Merch tertiary still present

Same Wear-this-meme button as before, secondary styling.

**Pass / Fail:** ____.

---

## Section F — legendary viewing someone else's meme (`legendary-other`)

Still on Legendary. Open Meme A (built by your Registered account).

### F1. Primary is "Make this fact about me", crown variant

The CTA reads **"Make this fact about me"**. It has a crown icon (the
legendary-flavoured variant).

**Pass / Fail:** ____.

### F2. Clicking opens the builder in self-upload mode

Because your Legendary account has a profile photo on file, the builder
opens in self-upload mode with your avatar pre-selected. The legendary
stylize toggle is visible. The upload-nudge banner does NOT appear (you
already have a photo).

**Pass / Fail:** ____.

### F3. Secondary: Browse more facts

Links to `/library`.

**Pass / Fail:** ____.

### F4. NO tier upsell

Critically — there must NOT be a Legendary upsell card on this page.
You're already at the top tier; offering it would be a copy bug.

**Pass / Fail:** ____.

---

## Section G — anonymous post-render transient state (`anon-own-transient`)

This is the trickiest cell because it's a transient state — it only
exists right after an anonymous user finishes building a meme and lands
on the permalink with `?just_created=1&source=photo` in the URL.

You can reach it organically: sign out completely, go to a fact, open
the builder, build a meme, save (anonymously, the save flow will park
the meme in a transient state), and land on `/m/<slug>?just_created=1`.

If that flow is unwieldy in your environment, simulate it by visiting
any meme you created with **no-creator** state appended:

```
/m/<slug-of-a-meme-with-null-creator>?just_created=1
```

(In dev you may not have any null-creator memes yet. In that case mark
this section as "skipped — covered by automated test
`useViewerCell.test.ts`".)

### G1. Primary is "Save your meme — sign up free"

The full-width orange button with right-arrow icon.

**Pass / Fail / Skipped:** ____.

### G2. Secondary is Download

Below the primary.

**Pass / Fail / Skipped:** ____.

### G3. Tier ladder is visible

Same two cards (Free / Legendary) as in Section A.

**Pass / Fail / Skipped:** ____.

### G4. Clicking "Save your meme" routes to login with returnTo

Click the primary. You land on `/api/login?returnTo=%2Fm%2F<slug>%3Fjust_created%3D1`.

**Pass / Fail / Skipped:** ____.

---

## Section H — preserved chrome (regression check)

For every cell you tested above, the page chrome was preserved from the
prior MemePage implementation. Confirm at least once that:

- The **SAVED chip** (green pill, ✓ Saved) is in the top-left.
- The **dimensions metadata** ("1080×1080 · ready" or similar) is
  beside it.
- The **MemeHeartButton** is below the image.
- On desktop, the layout is **two-pane** (image left / actions right).
- On mobile, single-column.
- The **"View full fact →"** link at the bottom navigates to
  `/facts/<id>` for the meme's underlying fact. Confirm the link target
  is correct and the fact detail page loads cleanly.

**Pass / Fail:** ____.

---

## Section I — Open Graph cards (production-only, post-deploy)

This section can ONLY be run after Replit AI has deployed the Cloudflare
Worker per `PHASE_5_DEPLOY.md`. In Replit dev mode the worker doesn't
exist; the OG endpoint exists at `/api/og/m/:slug` but no UA-based
routing is happening.

### I1. Direct OG endpoint is reachable

In any environment (dev or prod), open in a browser:

```
https://<host>/api/og/m/<slug>
```

The page is a minimal HTML shell. View source. The `<head>` contains:

- `<title>` with the creator name and the first line of the fact text.
- `og:type`, `og:site_name="overhype.me"`, `og:title`, `og:description`,
  `og:url`, `og:image` (= the meme image URL),
  `og:image:width="1080"`, `og:image:height="1080"`, `og:image:alt`.
- `twitter:card="summary_large_image"`, `twitter:title`,
  `twitter:description`, `twitter:image`.
- `<meta http-equiv="refresh" content="0;url=/m/<slug>">` so a human
  who lands here is bounced into the SPA.

The `<body>` has an `<h1>`, the fact line, an `<img>`, and a "View on
overhype.me" link.

The response headers include `Cache-Control: public, max-age=3600,
s-maxage=3600` and `Content-Type: text/html; charset=utf-8`.

**Pass / Fail:** ____.

### I2. Soft-deleted meme returns a generic card, no leaked content

1. Have a soft-deleted meme on hand (any meme you've removed via the UI
   or via the admin panel).
2. Open `/api/og/m/<deleted-slug>`.
3. The HTTP status is **410**.
4. The body's title is "Removed · overhype.me" with body "This meme has
   been removed by its creator." The original fact text, image URL, and
   creator name MUST NOT appear anywhere in the response.

**Pass / Fail:** ____.

### I3. Missing meme returns a generic card

Open `/api/og/m/__definitely-does-not-exist__`. HTTP 404. Body has
`og:type` etc. but the title is "Not found · overhype.me".

**Pass / Fail:** ____.

### I4. Twitter/X paste test (production only)

In a Twitter/X composer (DM or new tweet), paste a real
`https://overhype.me/m/<slug>` URL. The card unfurls within ~3 seconds
showing:

- The meme image as the large preview.
- The creator name + fact text in the title row.
- "overhype.me" as the source.

**Pass / Fail / N/A (dev):** ____.

### I5. Slack paste test (production only)

In any Slack channel, paste the same URL. Slack-ImgProxy fetches the
image and renders the unfurl card.

**Pass / Fail / N/A (dev):** ____.

### I6. Discord paste test (production only)

In any Discord text channel, paste the URL. Embed renders with image
preview, title, and description.

**Pass / Fail / N/A (dev):** ____.

### I7. iMessage paste test (production only)

Send the URL to yourself in iMessage. The bubble preview shows the meme
image. (iMessage uses the facebookexternalhit UA family for previews.)

**Pass / Fail / N/A (dev):** ____.

### I8. Facebook composer (production only)

Paste the URL into a status composer. The link card unfurls with a
large image preview.

**Pass / Fail / N/A (dev):** ____.

### I9. LinkedIn share dialog (production only)

Paste the URL into a post composer. Card renders with image.

**Pass / Fail / N/A (dev):** ____.

### I10. Plain Chrome receives the SPA, NOT the OG shell

In your browser (Chrome / Safari / Firefox — i.e. NOT a crawler), open
`https://overhype.me/m/<slug>`. The full SPA loads (React hydrates, you
see the meme detail page chrome). The page source on first paint is
`index.html`, not the OG shell.

If you see a stripped-down HTML page with `og:image` tags as the
**rendered DOM**, the worker is misclassifying your UA as a bot. File
this — it's a bug in the worker's `isbot` integration.

**Pass / Fail / N/A (dev):** ____.

---

## Section J — accessibility & polish spot-checks

### J1. Keyboard navigation works

Tab through the CTA bar in any cell. Each button is reachable in tab
order; pressing Enter activates it. The Legendary upsell card (a `<a>`
in disguise) is also tab-able.

**Pass / Fail:** ____.

### J2. The builder overlay is dismissible with the X button

In any cell that opens the builder (Sections A, C, D, F), click the X
in the upper-right of the overlay. The overlay closes and you're back
on the detail page; nothing else changes.

**Pass / Fail:** ____.

### J3. No layout shift on data load

Reload any meme detail page. The page renders the spinner, then the
detail page; the spinner-to-detail transition does NOT shift the visible
layout (the heading and CTA bar appear in the same position they'll
keep). If you see a multi-step layout reflow, file it.

**Pass / Fail:** ____.

---

## Reporting failures

For each failed row, note:

- The Section letter + row number (e.g. "C2").
- Which account was logged in.
- Which meme (A / B / C, or your custom one with the slug).
- What you saw vs. what you expected.
- A screenshot if it's visual.

If a CTA cell doesn't render at all (e.g. you expected `legendary-other`
but got `registered-other`), include the values of:

- `useAuth().role` (visible in the React DevTools `AuthContext` value).
- The meme's `createdById` (visible in the network response for
  `/api/memes/<slug>` in DevTools).
- Whether `?just_created=1` was in the URL.

That triple plus the cell I expected lets me reproduce the bug without
playing detective.

Phase 5 branch: `claude/setup-overhype-project-g8QzX`.
