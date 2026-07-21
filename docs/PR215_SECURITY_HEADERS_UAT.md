# PR215 — Application Security Headers (C5) — UAT

In-app acceptance test for David. This adds standard **security headers** to the
API server — the kind browsers use to defend against clickjacking, MIME
sniffing, and injected content. The change is designed to be **invisible in
normal use**: if everything still works exactly as before, that's the pass
condition. The one new "policy" (Content-Security-Policy) ships in **report-only**
mode, meaning it *watches* but never *blocks* — so it cannot break anything yet.

Sibling doc (for Replit): [`PR215_SECURITY_HEADERS_TEST_RUN.md`](./PR215_SECURITY_HEADERS_TEST_RUN.md).

## What changed, in plain terms

The server now tells browsers a few safety rules on every response: "don't let
other sites frame this app" (in production), "use HTTPS" (in production), "don't
guess file types," and a watch-only content policy. It's tuned so it does **not**
interfere with the things that need to work: the Replit preview iframe, public
meme images loading on other sites, and social link previews.

## How to check it (just use the app normally)

Everything below should behave **exactly as it does today**. You're checking for
the *absence* of breakage.

1. **The app loads and works.** Open the site, log in, browse memes, create a
   meme, view your profile. All normal.
2. **Images show up.** Meme images and template images render everywhere they
   did before — on the site, and when a meme link is shared.
3. **Social previews still unfurl.** Paste a **public** meme's `/m/<slug>` link
   into Slack / iMessage / Twitter/X. You still get the rich preview card with
   the meme image — not a broken/blank card.
4. **Replit preview still works.** Open the app in the Replit **webview**
   preview canvas. It still loads inside the preview (the frame rules are
   relaxed in dev on purpose).
5. **Login/checkout still work.** Sign in (incl. any Google/Apple popup flow)
   and run a Stripe **test-mode** checkout. No new errors.

## What you should NOT see

- The Replit preview canvas going blank or refusing to load the app.
- Meme images or social preview cards breaking.
- Any login popup or checkout that stops working.
- Any visible change in normal browsing.

## Regression smoke table

| Action | Expect |
|--------|--------|
| Load site, log in, browse/create memes | Works as today |
| Meme + template images render | Yes, everywhere |
| Public meme link pasted for social preview | Rich card still unfurls |
| Open app in Replit webview preview | Still loads (frame rules relaxed in dev) |
| Google/Apple login popup | Still completes |
| Stripe test-mode checkout | Still completes |

## Known non-bugs / limitations

- **The Content-Security-Policy is report-only for now.** It watches for
  disallowed content and logs it to the browser console, but does **not** block
  anything. This is intentional: it lets us confirm the policy is correct before
  turning on enforcement in a later change. If you open browser devtools you may
  see `[Report Only] Refused to …` console messages — those are informational,
  not errors, and nothing breaks because of them.
- **Header effects differ by environment.** Some protections (HTTPS enforcement,
  frame-blocking) are **production-only** and intentionally off in the Replit
  preview so the webview keeps working. That's expected.
- **Nothing about this changes what users see.** There's no UI to this PR — a
  clean pass is "the app behaves identically to before."

## If something's wrong

Tell me: which step, what you expected, what happened, and — if a page or image
broke — open the browser devtools **Console** and paste any red error text (or a
`Refused to …` line). That tells me exactly which header to adjust.
