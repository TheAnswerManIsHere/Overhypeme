# PR213 — Private-Meme Access (C3) — UAT

In-app acceptance test for David. This makes **private memes actually private**.
Before, a meme you marked private (legendary "not public") could still be opened
by anyone with the link, previewed on social, and its image was cached on the
CDN. Now a private meme is visible only to you (its creator) or an admin.

## What changed, in plain terms

"Private" now means **owner-only/secret**: only you can see a meme you marked
private. To everyone else — logged-in or not — it behaves as if it doesn't
exist (they get "not found", not "forbidden", so they can't even tell it's
there). Private memes are also no longer cached publicly, and they won't
generate a social-media preview card.

## How to check it (as a legendary account)

1. **Make a meme private.** Create/save a meme with visibility set to private
   (not public).
2. **You can still see your own.** Open its `/m/<slug>` link while logged in as
   the creator → it loads normally.
3. **Others can't.** Open the same link in a logged-out browser (or as a
   different account) → it should look like a missing meme ("not found"), not
   the meme.
4. **No social preview.** Paste the private meme's link into a place that
   unfurls previews (Slack/iMessage/Twitter) → you should get a generic/no
   preview, NOT the meme's image and text.
5. **Public memes unchanged.** A normal public meme still opens for everyone,
   still previews on social, still loads fast (cached) — exactly as before.

## What you should NOT see

- A private meme opening for a logged-out visitor or a different user.
- A private meme's image or text showing up in a link preview.
- Any change to how **public** memes behave (they should be identical to today).

## Regression smoke table

| Action | Expect |
|--------|--------|
| Owner opens own private meme | Loads |
| Admin opens a private meme | Loads |
| Other user / logged-out opens a private meme | "Not found" |
| Private meme link pasted for social preview | Generic / no preview |
| Public meme (any viewer) | Loads + previews, as before |
| "Share" copy/buttons on your own private meme | Work for you |
| "Share" on someone else's private meme | Not found |
| Order a product (Zazzle) from your own private meme | Works for you |
| Order from someone else's private meme | Not found |

## Known non-bugs / limitations

- **A private meme whose creator's account was deleted becomes admin-only.**
  With no owner left, only an admin can view it — intended (fail-safe).
- **Only legendary accounts can make memes private** in the first place (that's
  the existing product rule; unchanged here). Everyone else's memes are public.
- **The CDN/edge cache fix for private images depends on the Cloudflare worker
  being redeployed.** The app itself already marks private images "do not
  cache"; the edge fully honors it after the worker's next deploy. Until then,
  the app-level protection (404 to non-owners) is already in force.
- If you ever find one of **your own** private memes showing "not found" to
  *you* while logged in as the creator, that's a bug — report it.

## Bug report template

```
Action: (which row of the table)
Meme: public / private; who created it
Viewer: owner / other user / logged-out / admin
Expected: (from the table)
Actual: (what happened)
Environment: production / Replit preview
```
