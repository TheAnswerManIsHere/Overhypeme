# Phase 6 — User acceptance testing (in-app)

You're the end user here. Phase 6 ships one focused thing you'll feel
in the product:

1. **A custom share modal on the meme detail page.** Tapping the
   "Custom share" button on memes you own (the cells from Phase 5:
   `registered-own`, `legendary-own-stock`, `legendary-own-pulid`) now
   opens a focused, mobile-first modal with three buttons. On mobile
   that's **Share / Twitter/X / Copy Link** (the Share button opens
   your OS share sheet — iMessage, Mail, WhatsApp, AirDrop, every app
   you have installed). On desktop browsers without Web Share API
   (Firefox, some Windows builds), it's **Email / Twitter/X / Copy
   Link** instead.

The automated test side is in
[`PHASE_6_TEST_RUN.md`](./PHASE_6_TEST_RUN.md) and is owned by Replit AI;
that runs in parallel and you don't need to read it.

If anything in this UAT fails, write down which section + row, what you
saw vs. what you expected, and a screenshot if it's visual. I'll handle
the rest.

---

## ⚠ Pre-flight: OG card verification (do this FIRST)

Phase 6 is the share button. The thing that gets shared is an
`https://<host>/m/<slug>` permalink, and what the recipient SEES is
the Open Graph card from Phase 5. **If Phase 5's OG cards aren't
rendering correctly, Phase 6 produces share links that look broken in
social platforms — the worst possible outcome.**

Before starting Section A, paste a real meme permalink directly into
each of these composers and confirm a card renders with the meme image,
creator name, and fact text:

| Composer | OG card renders correctly? |
|---|---|
| **iMessage** (the critical one — this is the dominant mobile path) | ____ |
| Discord (any text channel) | ____ |
| Slack (any channel; lets the unfurl bot fetch) | ____ |
| Twitter/X (paste in a new tweet draft, don't post) | ____ |

If any row is "no", **stop and file it** before continuing — the broken
preview is upstream of anything Phase 6 can fix.

If you've previously done this verification for Phase 5 and nothing
about the OG endpoint or Cloudflare Worker has changed since, you can
note "verified per Phase 5 sign-off on <date>" and proceed.

---

## Setup

1. Pull the latest of `claude/setup-overhype-project-O4p1p`.
2. Boot the dev app in Replit. The session-start hook applies migrations
   automatically; if you opened the DB before the latest pull, force a
   re-apply with `pnpm --filter @workspace/db run migrate`. (Phase 6
   adds one migration — `0052_share_intents.sql` — which creates the
   `share_intents` table and seeds six `share_copy_*` rows in
   `admin_config`.)
3. You'll need two accounts in this session:
   - **Registered (free)** — a free-tier account.
   - **Legendary** — a legendary-tier account. Use the dev admin panel
     to grant Legendary if you don't already have one.
4. You'll need at least two memes on hand:
   - **Meme A** — created by your Registered account (any mode is
     fine).
   - **Meme B** — created by your Legendary account, **stock-mode**
     (so the cell is `legendary-own-stock`, which has the Custom Share
     button as a secondary).
   - *(Optional)* **Meme C** — created by your Legendary account,
     PuLID-stylized (so the cell is `legendary-own-pulid`, which has
     Custom Share as a primary).
5. Devices to have on hand if at all possible:
   - A real **iPhone** with iMessage, Mail, and WhatsApp (or any one of
     them) — this is the dominant share path the modal is designed for.
   - An **Android phone** with at least one messaging app installed.
   - **Desktop Chrome on macOS** — supports Web Share API.
   - **Desktop Firefox on any OS** — does NOT support Web Share API.
     This is the primary "Email fallback" environment to verify.
   - *(Optional)* **Desktop Edge / Chrome on Windows** — Web Share
     support is variable; useful for confirming the runtime probe
     resolves correctly.

What's expected to be partial in this build:

- **GA4 `share_intent` event firing.** The component fires
  `trackEvent("share_intent", { meme_id, platform })` on every click,
  but it only reaches GA if `window.gtag` is loaded (i.e. only on
  builds with `VITE_GA_MEASUREMENT_ID` set in the env). If your dev
  build doesn't have that, the DB row in `share_intents` is the source
  of truth — see Section F.
- **Reddit / WhatsApp / LinkedIn / Telegram dedicated buttons.**
  Deliberately not shipped. The Web Share API on mobile already covers
  every messaging app the user has installed; cluttering the modal
  with platform-specific buttons defeats the design. Copy Link is the
  universal escape hatch for desktop users on those platforms.

---

## Section A — modal opens from the right CTA cells

You're logged in as your **Registered** account. Open Meme A (which
you created).

### A1. The Custom Share button is present (you've seen this since Phase 5)

In the CTA bar, the "Custom share" button (share icon) is visible. From
Phase 5 it sits next to Download as a secondary; you don't need to
re-verify Phase 5 placement — just confirm the button is still there.

**Pass / Fail:** ____.

### A2. Tapping Custom Share opens the new modal (NOT a clipboard alert)

Click "Custom share".

In Phase 5 this used to either invoke `navigator.share()` and dismiss,
or copy the URL to clipboard with a `window.alert("Link copied!")`.
**Neither of those should happen anymore.** Instead, a modal with the
title **"Share this meme"** opens in the center of the screen on
desktop, or as a near-fullscreen card on mobile.

The modal contains:

- A title in the brand display font (Bebas Neue, orange) reading
  "SHARE THIS MEME".
- Three large stacked buttons (each a generous touch target with an
  icon on the left and an uppercase Bebas Neue label).
- A close (✕) button in the upper-right.

**Pass / Fail:** ____.

### A3. Modal closes via every dismissal path

With the modal open, verify each of these closes it:

| Action | Closes? |
|---|---|
| Clicking the ✕ in the upper-right | ____ |
| Pressing **Escape** on a desktop keyboard | ____ |
| Tapping the dimmed area outside the modal (the backdrop) | ____ |

(Mobile swipe-down isn't first-class in this build by design — backdrop
tap and the explicit ✕ are the canonical mobile dismiss paths.)

**Pass / Fail:** ____.

### A4. Custom Share is also available from the Legendary cells

Log in as **Legendary**. Open Meme B. The CTA cell is
`legendary-own-stock` — Custom Share is a secondary button next to
Download. Click it; the same modal opens.

If you have Meme C, repeat: open Meme C (`legendary-own-pulid`) — Custom
Share is a primary here. Same modal opens.

**Pass / Fail (legendary-own-stock):** ____.

**Pass / Fail (legendary-own-pulid):** ____.

---

## Section B — the right buttons render for the right environment

The modal's first button changes based on whether your browser supports
Web Share API. Detection runs once when the modal opens and does not
re-evaluate.

### B1. Mobile (iOS Safari): Share / Twitter/X / Copy Link

Open Meme A on your iPhone in Safari (not in an in-app browser like
the Twitter app — use Safari directly). Tap Custom Share.

The three buttons in order are:

1. **Share** with a system share icon (square with up-arrow).
2. **Twitter / X** with the X glyph.
3. **Copy Link** with a link icon.

There is **NO** "Email" button visible. (Mail is reachable via the
native share sheet that the Share button opens.)

**Pass / Fail:** ____.

### B2. Mobile (Android Chrome): Share / Twitter/X / Copy Link

Same three buttons in the same order on an Android device.

**Pass / Fail:** ____.

### B3. Desktop Chrome on macOS: Share / Twitter/X / Copy Link

Chrome on macOS supports Web Share API. The Share button should be
present (clicking it opens the macOS system share sheet).

**Pass / Fail:** ____.

### B4. Desktop Firefox: Email / Twitter/X / Copy Link

Firefox typically does not support Web Share API. The first button
should be **Email** (envelope icon) instead of Share.

The other two (Twitter/X and Copy Link) are unchanged.

**Pass / Fail:** ____.

### B5. Desktop Chrome / Edge on Windows (optional)

Web Share API support on Windows is variable across Chrome versions.
Whatever your build resolves to is fine — note it:

- If Share renders → **Pass (Web Share supported)**.
- If Email renders → **Pass (Email fallback engaged)**.
- If neither renders, or both render, or the wrong icon shows up → **Fail**.

**Result:** ____ (Share / Email / Fail — and which Chrome build).

### B6. No flash of the wrong button set

On any environment, when the modal opens you should see one of two
states:

1. A neutral skeleton (three pulsing grey blocks) for one paint cycle.
2. The correct button set immediately after.

You should NOT see the wrong button set briefly appear and then swap.
If you observe a flash of "Share" → "Email" or vice-versa, the runtime
probe is racing the first paint; file it.

**Pass / Fail:** ____.

---

## Section C — Web Share button (mobile, the dominant path)

These rows assume you're on a device where Web Share is supported (your
modal shows the **Share** button as the first option). Most mobile
testing happens here.

### C1. Tapping Share opens the OS share sheet

On Meme A, open the modal, tap **Share**.

- iOS: the standard iOS share sheet slides up from the bottom. It
  shows a row of suggested contacts at the top, then a row of
  installed app icons (iMessage, Mail, WhatsApp, AirDrop, etc.).
- Android: the equivalent system share sheet appears.

**Pass / Fail:** ____.

### C2. The pre-filled content is correct

The share sheet should pre-fill three things:

1. **Title** — `<creator name> on overhype.me` (the Web Share title
   template, default `{name} on overhype.me`).
2. **Text** — the meme's fact text (`{fact_text}`).
3. **URL** — the absolute permalink, e.g. `https://overhype.me/m/<slug>`.

Confirm by sending the share to **iMessage** (pick "Messages" from the
share sheet, send to yourself). The composed iMessage should include
the URL prominently and the text near it. The exact arrangement varies
by OS — what matters is that the link is intact and the text is the
fact text.

**Pass / Fail:** ____.

### C3. Send to iMessage — the recipient sees the OG card

Complete the iMessage send (to yourself or a friend who's expecting it).
The recipient bubble should render the **OG preview card** from Phase 5:
the meme image as the large preview, the creator name + fact text in
the title row, "overhype.me" as the source.

**This is the punchline of the whole feature.** If the OG card doesn't
render, the whole share flow looks broken to the recipient.

**Pass / Fail:** ____.

### C4. Send to Mail — the recipient sees the OG card

Repeat the share, this time pick "Mail" from the share sheet. The
default mail composer opens with the URL in the body. Send to yourself.
When you receive it, the URL should unfurl into a card preview (Apple
Mail, Gmail web, and Outlook all do this for known-host URLs).

**Pass / Fail:** ____.

### C5. Send to WhatsApp / Messenger / your messenger of choice

Pick another installed messaging app from the share sheet. Send. The
recipient should see a card preview, same as the iMessage / Mail rows.

**Which app you tested:** ____.

**Pass / Fail:** ____.

### C6. Dismissing the share sheet is silent (no error toast)

Open the modal, tap Share, then **dismiss** the OS share sheet without
picking an app (swipe down on iOS, tap outside on Android).

You should be returned to the meme detail page, the modal should be
closed, and there should be **NO** toast / alert / error message of any
kind. Dismissal is a deliberate user action, not an error.

**Pass / Fail:** ____.

### C7. After successful share, the modal closes and you're back on the meme page

Confirm the modal does not stay open after a successful share. (Some
buggy implementations leave the modal sitting under the share sheet.)

**Pass / Fail:** ____.

---

## Section D — Twitter/X button

### D1. Tapping Twitter/X opens a new tab to the X composer

In any environment (mobile or desktop), open the modal and tap
**Twitter / X**.

A new tab opens to `https://twitter.com/intent/tweet?text=…&url=…&hashtags=…`.

- On a desktop with X.com logged in: the X composer modal opens with
  the text, URL, and hashtags pre-filled.
- On mobile with the X app installed: the URL deep-links into the X
  app's compose flow.
- On any browser without an X session: the X login wall appears, then
  the composer once you log in. (The intent URL still works pre-login.)

**Pass / Fail (desktop):** ____.

**Pass / Fail (mobile with app):** ____.

### D2. The pre-filled content is correct

The composer should show:

1. The fact text as the tweet body (the `share_copy_twitter_template`
   default is `{fact_text}`).
2. The hashtags **#overhype #legendsaremadeup** appended (from
   `share_copy_twitter_hashtags`, comma-separated as `overhype,legendsaremadeup`).
3. The permalink as the URL — rendered as a `t.co` short link in the
   final tweet.

**Pass / Fail:** ____.

### D3. Long fact text doesn't break the composer

Find or create a meme whose fact text is very long (200+ chars). Open
its share modal and tap Twitter/X.

The composer should NOT show a "Tweet too long" warning. Phase 6's
share-copy endpoint truncates the text server-side with an ellipsis
to leave budget for the URL and hashtags.

If you can't find a long-text meme, this row is "skipped — covered by
automated test `routes.shareCopy.test.ts:truncates very long fact text`".

**Pass / Fail / Skipped:** ____.

### D4. Names with special characters are encoded correctly

If you have a meme whose creator name contains an apostrophe (`O'Hara`)
or accented characters (`José`), open its share modal and tap
Twitter/X. The composer should show the name correctly rendered (NOT
`Jos%C3%A9` literally, NOT `O%27Hara`). The URL is encoded but the
DECODED form is what the user sees.

If you don't have a meme like that, this row is "skipped — covered by
automated test `routes.shareCopy.test.ts:URL-encodes names with special
characters`".

**Pass / Fail / Skipped:** ____.

### D5. The new tab uses noopener / noreferrer

Open the modal, right-click the Twitter/X button, "Inspect element".
The `<button>`'s click handler opens the tab via
`window.open(url, "_blank", "noopener,noreferrer")` so the X.com tab
cannot navigate the parent. (This is hard to verify visually — the
shortcut is to confirm via DevTools that the button is a `<button>`
not an `<a target="_blank">`.) If that's not feasible, mark "trusted
to engineering".

**Pass / Fail / Trusted:** ____.

---

## Section E — Copy Link button

### E1. Tapping Copy Link writes the permalink to clipboard

In any environment, open the modal and tap **Copy Link**.

You should see:

1. A toast in the corner of the screen reading **"Link copied"** with
   the description "Paste it anywhere."
2. The modal closes.

Open a text field (the URL bar of a new browser tab works) and paste.
The exact value `https://<host>/m/<slug>` should appear.

**Pass / Fail (toast):** ____.

**Pass / Fail (clipboard contents):** ____.

### E2. Pasted into Discord — the OG card unfurls

Open Discord (any channel you can post in, even a DM to yourself).
Paste the link. Send. Within ~2 seconds, the message should unfurl into
an embed showing the meme image, creator name, and fact text.

**Pass / Fail:** ____.

### E3. Pasted into Slack — the OG card unfurls

Same as above but in any Slack channel.

**Pass / Fail:** ____.

### E4. Pasted into a text DM on Twitter/X — the OG card unfurls

Open a DM thread on X. Paste the link. Send. The card preview should
render in the conversation.

**Pass / Fail:** ____.

### E5. Falls back gracefully when Clipboard API isn't available

This is hard to reproduce in a modern browser (every browser in the
target matrix supports `navigator.clipboard`). If you have a way to
test in a legacy environment (Safari < 13 or an old Android WebView)
where `navigator.clipboard` is undefined, confirm the link still ends
up in the clipboard via the legacy `document.execCommand("copy")`
fallback.

If you can't reproduce, mark "skipped — vanishingly rare; covered by
inline fallback in `MemeShareModal.tsx`".

**Pass / Fail / Skipped:** ____.

---

## Section F — Email button (desktop without Web Share)

These rows assume you're on a desktop browser where the modal shows
the **Email** button as the first option (Firefox is the easy
reproducer).

### F1. Tapping Email opens your default mail client

In Firefox, open Meme A, click Custom Share, click **Email**.

Your default mail client (Apple Mail, Outlook, Thunderbird, Gmail in
the browser if you have it as the default `mailto:` handler) opens to
a new compose window.

**Pass / Fail:** ____.

### F2. The subject is correct

The subject reads **"A meme of `<creator name>` on overhype.me"** by
default. (This comes from the `share_copy_email_subject_template`
admin_config row.)

**Pass / Fail:** ____.

### F3. The body has the right shape

The pre-filled body looks like:

```
<creator name> thought you'd appreciate this:

"<fact text>"

See it: https://<host>/m/<slug>

— Sent from overhype.me, where legends are made up.
```

Specifically:

- Creator's name on the first line, possessive opener.
- Fact text in quotes on its own paragraph.
- Permalink on its own line, prefixed with "See it:".
- Brand sign-off on the final line.
- The permalink is a clickable URL in the recipient's mail client
  (Gmail, Outlook, Apple Mail all autolink bare URLs in plain-text
  bodies).

**Pass / Fail:** ____.

### F4. The encoding is correct (no `+` in spaces)

In the Apple Mail / Outlook compose window, the body should show
*spaces* — not literal `+` characters between words. (This is the
`mailto:` URL using `%20` for spaces; the bug-prone path is `+` which
Outlook renders literally.)

**Pass / Fail:** ____.

### F5. Send to yourself — recipient sees a clean email with a clickable link

Send the email to your own address. When you receive it:

- The subject line displays correctly.
- The body is plain text (no broken HTML, no double-escaped quotes).
- The permalink is clickable.
- Clicking the link in the email opens the meme detail page; in any
  browser that previews link cards in the email body (Apple Mail,
  Gmail web), the link unfurls into an OG preview.

**Pass / Fail:** ____.

---

## Section G — share-intent telemetry is being recorded

Phase 6 logs every share-button click into a new `share_intents` table.
This is the data that future analytics will read to know which share
paths users actually use.

You can verify rows are being inserted from the dev DB shell:

```bash
psql $DATABASE_URL -c "SELECT platform, count(*) FROM share_intents WHERE created_at > now() - interval '1 hour' GROUP BY platform ORDER BY count DESC;"
```

### G1. Performing each share action inserts a row

1. Note the current row count: `SELECT count(*) FROM share_intents;`
2. Perform one Web Share / Email click — confirm count + 1.
3. Perform one Twitter/X click — confirm count + 1.
4. Perform one Copy Link click — confirm count + 1.
5. Re-query by platform; you should see at least one row for each
   platform you exercised, with the correct `platform` value.

**Pass / Fail:** ____.

### G2. The rows are scoped to the authenticated user

Run:

```bash
psql $DATABASE_URL -c "SELECT user_id, platform, created_at FROM share_intents ORDER BY created_at DESC LIMIT 10;"
```

The `user_id` column should match the user ID of the account you were
logged in as when you clicked the buttons.

**Pass / Fail:** ____.

### G3. A failed log endpoint does NOT block sharing

This is the "fire-and-forget" guarantee. To simulate a failed log, the
easiest path is the browser DevTools network tab:

1. Open Meme A in your Registered account, open DevTools → Network.
2. In the Network tab, right-click `/api/share-intents` (after a
   previous share-button click registered the URL) → "Block request URL".
3. Open the share modal, click any share button.
4. The share action should still complete — the OS share sheet opens,
   or the link gets copied with the toast, or the Twitter/X tab opens.
5. The blocked POST shows up as failed in the Network tab. No error
   toast appears. The user-visible action proceeds normally.
6. Unblock the URL when done.

**Pass / Fail:** ____.

---

## Section H — DB-stored copy templates are editable without a redeploy

The six `share_copy_*` rows in `admin_config` are the source of truth
for every string the user sees in the modal. Editing them in the DB
should change behavior on the next request, no redeploy needed.

### H1. Edit the Twitter template, see the change immediately

In the dev DB:

```bash
psql $DATABASE_URL -c "UPDATE admin_config SET value = '🔥 {fact_text} 🔥' WHERE key = 'share_copy_twitter_template';"
```

Wait ~60 seconds for the in-process config cache to expire (or restart
the api-server to bust it immediately).

Open Meme A, click Custom Share → Twitter/X. The composer should now
show the fact text wrapped in 🔥 emoji.

Restore:

```bash
psql $DATABASE_URL -c "UPDATE admin_config SET value = '{fact_text}' WHERE key = 'share_copy_twitter_template';"
```

**Pass / Fail:** ____.

### H2. Same for the email body

```bash
psql $DATABASE_URL -c "UPDATE admin_config SET value = 'Custom test body for {name}: {permalink}' WHERE key = 'share_copy_email_body_template';"
```

Wait for the cache to expire. Click Custom Share → Email (in Firefox or
similar). The body should reflect the new template, with `{name}` and
`{permalink}` substituted with the meme's actual creator name and URL.

Restore the original (use the multi-line value from the migration —
copy from `lib/db/migrations/0052_share_intents.sql`).

**Pass / Fail:** ____.

---

## Section I — auth gating

The modal is reached only via the Custom Share CTA, which itself only
renders for the `registered-own`, `legendary-own-stock`, and
`legendary-own-pulid` cells. So an anonymous viewer should never see it
through normal navigation.

### I1. Anonymous users don't see the Custom Share button

Sign out completely. Open Meme A. The CTA cell is `anon-other`. There
should be NO Custom Share button (the `anon-other` row in Section A of
the Phase 5 UAT also called this out — confirm it's still true).

**Pass / Fail:** ____.

### I2. Direct API hits without auth get 401

For the brave: in your terminal, hit the share-copy endpoint without
a session cookie:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://<host>/api/share-copy/<any-slug>/twitter"
```

Expected: **401**. This is the belt-and-suspenders gate at the API
surface, in case anyone ever reaches the modal through a path the cell
matrix doesn't cover.

Same check on the intent log:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" \
  -d '{"memeId":"anything","platform":"twitter"}' \
  "https://<host>/api/share-intents"
```

Expected: **401**.

**Pass / Fail (share-copy):** ____.

**Pass / Fail (share-intents):** ____.

---

## Section J — accessibility & polish spot-checks

### J1. Keyboard navigation works

In the modal, press **Tab**. Focus moves through Close (✕) → first
share button → second → third → wraps back. Focus rings are visible
(orange outline matching the brand). Pressing **Enter** activates the
focused button.

**Pass / Fail:** ____.

### J2. Focus returns to the trigger on close

Open the modal from the Custom Share button. Press Escape to close.
Focus should return to the Custom Share button (so a keyboard user
isn't dropped at the top of the page).

**Pass / Fail:** ____.

### J3. Mobile layout is comfortable to thumb-tap

On a real phone, the three share buttons should each be at least
~56pt tall (large enough that you can't miss with a thumb). The icons
are visible. The labels are readable.

**Pass / Fail:** ____.

### J4. Brand consistency

The modal should feel like the rest of the site:

- Dark background (not white).
- Orange accents on hover / active (the `#ff6b35` brand orange).
- Bebas Neue display font for the title and button labels.

**Pass / Fail:** ____.

### J5. Modal doesn't break the underlying page

After closing the modal (any path), the meme detail page should look
exactly as it did before opening. No leftover backdrop, no shifted
layout, no scroll position jump. The Custom Share button is still
clickable.

**Pass / Fail:** ____.

---

## Reporting failures

For each failed row, note:

- The Section letter + row number (e.g. "C3").
- Which account was logged in.
- Which device + browser + OS.
- Which meme (A / B / C, or your custom one with the slug).
- What you saw vs. what you expected.
- A screenshot if it's visual; a screen recording if it's a
  flash-of-wrong-content (Section B6).

If a share button silently does nothing (no toast, no tab opens, no
share sheet), open DevTools → Console and capture any warnings or
errors. The most useful thing is the response status and body for
`/api/share-copy/<slug>/<platform>` — visible in the Network tab right
after the click.

If the modal's button set is wrong for your device (e.g. you got Email
on iOS Safari), include the value of:

- `navigator.share` evaluated in the console (should be a function on
  iOS Safari, undefined on Firefox).
- The response of the runtime probe — set a breakpoint in
  `useWebShareSupport.ts` if you can, or just note the unexpected
  rendering and the device.

Phase 6 branch: `claude/setup-overhype-project-O4p1p`.
