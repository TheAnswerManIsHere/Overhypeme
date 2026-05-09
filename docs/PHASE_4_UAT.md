# Phase 4 — User acceptance testing (in-app)

You're the end user here. Phase 4 ships three server-rendered endpoints
(`/api/render-preview`, `/api/render-download`, the refactored
`/api/memes`), the shared composite that backs all three, the
`transient_renders` audit table, and the daily save cap. Most of this
is invisible from the UI — the only user-facing change is the **Download**
button now produces server-rendered bytes instead of snapping the
client-side canvas. So this UAT is shorter than Phase 3's: most of
the work is in the server and the rest is "press the button, verify
the output looks right".

The automated test side is in
[`PHASE_4_TEST_RUN.md`](./PHASE_4_TEST_RUN.md) and is owned by Replit AI;
that runs in parallel and you don't need to read it.

If anything in this UAT fails, write down which section + row, what you
saw vs. what you expected, and a screenshot if it's visual. I'll handle
the rest.

---

## Setup

1. Pull the latest of `claude/setup-overhype-project-ZszJ6` (PR [#40](https://github.com/TheAnswerManIsHere/Overhypeme/pull/40)).
2. Boot the dev app in Replit. The session-start hook applies migrations
   automatically; if you opened the DB before the latest pull, force a
   re-apply with `pnpm --filter @workspace/db run migrate` to land the
   two new migrations (0050 `transient_renders`, 0051 memes index).
3. You'll need three accounts in this session, ideally already logged in
   in three separate browsers (or the same browser using
   incognito + private windows):
   - **Anonymous** — signed out.
   - **Registered** — a free-tier account.
   - **Legendary** — a legendary-tier account (use the dev admin panel
     to grant Legendary if you don't already have one).
4. Pick one fact you'll use across the whole UAT — it makes
   side-by-side comparisons easier. Note its fact ID from the URL
   (e.g. `/facts/123` → fact id 123).

What's expected to be partial in this build:

- The UI does not surface a "preview" button — `/api/render-preview` is
  still wired only by the cold-permalink personalisation flow (Phase 5).
  In this UAT we exercise it via DevTools (Section A).
- The Cloudflare WAF rate limits described in
  `docs/cloudflare-rate-limits.md` are configuration that runs at the
  edge in production. In Replit dev they don't fire. Section F shows
  how to spot-check them once production is configured.

---

## Section A — anonymous render-preview via DevTools

You're signed out for this section.

### A1. Stock-mode preview returns image bytes

1. Open DevTools → Network tab on a fact page.
2. Paste this into the DevTools Console (substitute `<FACT_ID>` and a
   real `pexelsPhotoId` from the stock picker):

   ```js
   const res = await fetch("/api/render-preview", {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({
       factId: <FACT_ID>,
       imageSource: { type: "stock", pexelsPhotoId: <PEXELS_ID> },
       name: "Alex",
       pronouns: "they/them",
     }),
   });
   console.log(res.status, res.headers.get("content-type"));
   const blob = await res.blob();
   const img = new Image();
   img.src = URL.createObjectURL(blob);
   document.body.appendChild(img);
   ```

3. Expected: `200 image/jpeg` and a meme image appears at the bottom of
   the page with the fact text personalised to "Alex" and "they/them"
   over the Pexels photo.
4. The response should NOT have a `Content-Disposition` header (it's a
   preview, not a download).

**Pass / Fail:** ____.

### A2. Anonymous user is blocked from non-stock modes

Still signed out:

```js
fetch("/api/render-preview", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    factId: <FACT_ID>,
    imageSource: { type: "upload", uploadKey: "/objects/foo.jpg" },
    name: "Alex",
    pronouns: "they/them",
  }),
}).then(r => r.json()).then(console.log);
```

Expected: `{ error: "mode_requires_auth" }` with status 403.

**Pass / Fail:** ____.

### A3. Bad pronoun is rejected

```js
fetch("/api/render-preview", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    factId: <FACT_ID>,
    imageSource: { type: "stock", pexelsPhotoId: <PEXELS_ID> },
    name: "Alex",
    pronouns: "garbage/value",
  }),
}).then(r => console.log(r.status));
```

Expected: 400. The server only accepts the curated allowlist
`he/him`, `she/her`, `they/them`, `xe/xem`, `ze/zir`.

**Pass / Fail:** ____.

### A4. Oversized name is rejected

```js
fetch("/api/render-preview", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    factId: <FACT_ID>,
    imageSource: { type: "stock", pexelsPhotoId: <PEXELS_ID> },
    name: "A".repeat(51),
    pronouns: "they/them",
  }),
}).then(r => console.log(r.status));
```

Expected: 400.

**Pass / Fail:** ____.

### A5. Newline in name is rejected

```js
fetch("/api/render-preview", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    factId: <FACT_ID>,
    imageSource: { type: "stock", pexelsPhotoId: <PEXELS_ID> },
    name: "Alex\nSmith",
    pronouns: "they/them",
  }),
}).then(r => console.log(r.status));
```

Expected: 400. Phase 4 deliberately rejects control characters in the
name to keep it from corrupting downstream LLM prompts that bake the
name in.

**Pass / Fail:** ____.

---

## Section B — Download button (registered user)

Log in to your registered account. Open the meme builder
(Studio → Stock Photo).

### B1. Download produces a JPEG file

1. Type a name and pick `they/them`.
2. Pick a stock thumbnail.
3. Click **Download**.
4. Your browser saves a file named `overhype-<fact-slug>.jpg` to the
   download folder. The filename slug is derived from the fact text.

**Pass / Fail:** ____.

### B2. Network panel confirms server render

1. Open DevTools → Network → filter to `render-download` before clicking
   Download.
2. Click Download. You should see exactly one
   `POST /api/render-download` request with status 200.
3. The response headers include `Content-Type: image/jpeg` and
   `Content-Disposition: attachment; filename="overhype-...jpg"`.

**Pass / Fail:** ____.

### B3. The downloaded file opens cleanly

Open the downloaded JPEG in your OS image viewer. Confirm:

- The fact text is personalised with the name + pronouns you typed.
- For `they/them`, verb conjugation is plural (e.g. "they push" not
  "they pushes"). For `he/him` / `she/her`, singular ("he pushes").
- The orange left accent bar, ghost "OM" watermark, and "overhype.me"
  footer are all in place.

**Pass / Fail:** ____.

---

## Section C — Save flow (registered user)

Same fact, still logged in as registered.

### C1. Save creates a permalink

1. With the same name + pronouns + stock thumbnail as Section B, click
   **Save meme**.
2. The builder closes; the action's `onComplete` reports `kind:"saved"`
   with a permalink URL.
3. Navigate to `/meme/<permalinkSlug>`. The meme detail page renders the
   image.
4. Inspect the slug shape: it should be **10 characters**, alphanumeric
   only (e.g. `aB3xZ9pQ7m`). Phase 4 switched from a UUID slice (12
   chars, lowercase only) to nanoid(10).

**Pass / Fail:** ____.

### C2. Save and Download produce the same image

1. Save a meme as in C1 — note the slug.
2. Visit `/api/memes/<slug>/image` directly in a new tab. Save the
   image with right-click → "Save image as".
3. Download the same meme via the builder (Section B1) — same name,
   same pronouns, same stock photo.
4. Compare both files in your OS image viewer. They should look
   pixel-for-pixel identical.

   *(Power-user check: hash both files with `sha256sum` (macOS:
   `shasum -a 256`). Identical bytes are the byte-identity invariant.
   Some sub-pixel JPEG-encoder drift is still acceptable; if the
   visual content is the same, the test passes.)*

**Pass / Fail:** ____.

### C3. Idempotency — double-clicking Save doesn't duplicate

1. Pick a stock thumbnail. Type a name. **Don't click Save yet.**
2. Click Save **twice in rapid succession** (within 60 s).
3. Refresh the page and visit `/facts/<FACT_ID>/memes?visibility=mine`
   — you should see exactly **one** new meme on the list, not two.
4. Repeat with a different fact and 5 seconds between clicks — still
   one meme.
5. Now wait 70 seconds and Save again with the same inputs — this
   time a second meme **is** created (the idempotency window has
   expired).

**Pass / Fail per row:** C3.3: ____  C3.4: ____  C3.5: ____.

### C4. Idempotency — different inputs do create distinct memes

1. Save a meme.
2. Within 60 s, change the framing transform (drag the photo a few
   pixels in the picker), then Save again.
3. Both memes should appear in `/facts/<FACT_ID>/memes?visibility=mine`
   with **different slugs**.

**Pass / Fail:** ____.

---

## Section D — Tier gating

### D1. Anonymous → 401 on Save

1. Sign out. Open the builder. Pick a stock thumbnail.
2. Click Save. The studio's anonymous flow should kick off the signup
   modal — it should NOT silently 500.
3. Open DevTools Network and call `POST /api/memes` directly via
   Console:

   ```js
   fetch("/api/memes", {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({
       factId: <FACT_ID>,
       imageSource: { type: "template", templateId: "action" },
     }),
   }).then(r => console.log(r.status));
   ```

   Expected: 401.

**Pass / Fail:** ____.

### D2. Free user → 403 when saving with imageTransform=pulid

Logged in as registered (free tier). In DevTools Console:

```js
fetch("/api/memes", {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json", "x-csrf-token": document.cookie.match(/csrf_token=([^;]+)/)[1] },
  body: JSON.stringify({
    factId: <FACT_ID>,
    imageSource: { type: "upload", uploadKey: "/objects/uploads/aa/bb.jpg" },
    imageTransform: "pulid",
  }),
}).then(r => r.json()).then(console.log);
```

Expected: status 403, body `{ error: "tier_mismatch" }`.

**Pass / Fail:** ____.

### D3. Legendary user → save with PuLID succeeds

Switch to the legendary account, then run the same fetch as D2 but
with a real `uploadKey` (do an actual upload first if you don't
already have one). Expected: 201 with the new meme returned.

**Pass / Fail:** ____.

---

## Section E — Daily save cap

The free-tier cap is 30/day; legendary is 200/day. Both are configurable
via `admin_config` keys `memes.free_tier_daily_save_cap` and
`memes.legendary_tier_daily_save_cap`.

This is genuinely tedious to UAT manually because you'd need to save 30
memes in a day. Two practical paths:

### E1. Lower the cap temporarily, then trip it

1. In the admin config UI (or via psql), set
   `memes.free_tier_daily_save_cap = 2` for testing.
2. Sign in as a registered user with no recent memes.
3. Save two memes back-to-back with different inputs (vary the framing
   transform so idempotency doesn't collapse them).
4. Try to save a third. Expected: HTTP 429, body
   `{ error: "daily_cap_reached", cap: 2 }`, with a `Retry-After: 3600`
   header.
5. **Restore** the config to 30 when you're done.

**Pass / Fail:** ____.

### E2. Soft-deleted memes don't count

1. Lower the cap to 2 again.
2. Save one meme (count = 1).
3. Soft-delete it via `DELETE /api/memes/<slug>` (the existing
   delete handler).
4. Save two more memes — both should succeed (the deleted one is no
   longer counted against the cap).
5. **Restore** the cap.

**Pass / Fail:** ____.

---

## Section F — Cloudflare edge rate limit (production only)

Skip if you're testing in Replit dev — the WAF rules don't apply there.

Once the rules are created in the Cloudflare dashboard per
`docs/cloudflare-rate-limits.md`:

1. From a single client IP, hit `/api/render-preview` 35 times in a
   loop with valid bodies.
2. The first 30 should return 200. The remaining 5 should return 429
   with the custom JSON body `{"error":"rate_limited","endpoint":"render-preview","retryAfterSeconds":3600}`
   and a `Retry-After: 3600` header.
3. Cloudflare batches counters at ~10 s granularity, so the cutover
   may slide by a couple of requests in either direction — that's
   fine.
4. Repeat for `/api/render-download` with a 10/hour expectation.

**Pass / Fail (production check, can defer):** ____.

---

## Section G — `transient_renders` audit (DB spot-check)

Optional but good to verify once. Open `psql` against the dev DB.

### G1. Every render writes one row

1. Trigger a successful preview (Section A1).
2. ```sql
   SELECT endpoint, mode, result, latency_ms, created_at
     FROM transient_renders
    ORDER BY created_at DESC LIMIT 5;
   ```
3. Confirm the most recent row has `endpoint='preview'`, `result='success'`,
   `mode='stock'`, and a non-null `latency_ms`.

**Pass / Fail:** ____.

### G2. Rejected requests are also logged

1. Trigger a rejection (Section A3 — bad pronoun).
2. Same query as G1. Confirm a recent row with `result='rejected'`,
   `rejection_reason='invalid_input'`, and the IP hash present.

**Pass / Fail:** ____.

### G3. Raw IPs are never stored

1. ```sql
   SELECT DISTINCT ip_hash FROM transient_renders LIMIT 5;
   ```
2. Every value should be a 64-character hex string. None should look
   like an IP (no dots, no colons).

**Pass / Fail:** ____.

---

## Section H — purger job (long-running, optional)

The hourly retention purger is registered in `src/index.ts` and runs at
the next top-of-hour after boot.

1. Boot the server. Tail the logs.
2. Within ~1 minute of boot, look for a log line:
   `transient_renders purger scheduled {nextRunAt: "...", msUntilNext: ...}`
3. At the next top-of-hour, look for `transient_renders purger run` (only
   prints if rows were deleted) or no log line if there were no rows past
   30 days.
4. To force a run without waiting, in `psql`:
   ```sql
   INSERT INTO transient_renders (endpoint, ip_hash, result, created_at)
   VALUES ('preview', '0000000000000000000000000000000000000000000000000000000000000000',
           'success', now() - interval '40 days');
   ```
   Then trigger the job from a Node REPL:
   ```js
   const { runTransientRenderPurger } = await import("./src/jobs/transientRenderPurger.ts");
   await runTransientRenderPurger();
   ```
   Expected: `{ deleted: 1, retentionDays: 30, cutoff: "..." }`.

**Pass / Fail (optional):** ____.

---

## Section I — full sign-off

After A–G (H is optional), give a single overall sign-off:

| | OK | Concerns |
|---|---|---|
| Anonymous render-preview works for stock mode | | |
| Anonymous render-preview blocks non-stock with 403 | | |
| Validation rejects bad pronouns / oversized names / control chars | | |
| Download button produces a JPEG that looks correct | | |
| Save creates a permalink with a 10-char nanoid slug | | |
| Save image and download image are visually identical | | |
| Double-click Save doesn't duplicate the meme | | |
| Distinct inputs DO produce distinct memes | | |
| PuLID tier gate fires for free users | | |
| Daily save cap fires at the configured threshold | | |
| Soft-deleted memes don't count against the cap | | |
| `transient_renders` rows have hashed IPs (no raw addresses) | | |

**Sign-off:** ____  **Date:** ____.

---

## Reporting issues

If anything fails, please file with:

1. Which section / row.
2. What you saw (status code, response body, screenshot).
3. What you expected.
4. Browser + tier (logged-out / registered / legendary).
5. The fact ID and pexelsPhotoId you were using.

Phase-4 branch: `claude/setup-overhype-project-ZszJ6` (PR [#40](https://github.com/TheAnswerManIsHere/Overhypeme/pull/40)).
