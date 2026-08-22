# PR #213 — Private-Meme Access — UAT

This makes **private memes actually private**. Before, a meme you marked
private (legendary "not public") could still be opened by anyone with the
link, previewed on social, and its image was cached on the CDN. Now a
private meme is visible only to you (its creator) or an admin.

"Private" now means **owner-only/secret**: only you can see a meme you
marked private. To everyone else — logged in or not — it behaves as if it
doesn't exist (they get "not found," not "forbidden," so they can't even
tell it's there). Private memes are also no longer cached publicly, and
they won't generate a social-media preview card.

## Setup

- [david] Sign in as a legendary account. Only legendary accounts can mark
  a meme private, and step 1 needs that account's session.

## Steps

### 1. Mark a meme private and save it

**Do:** Create or save a meme with visibility set to private (not
public).

**Expect:** the meme saves with private visibility, with no error.

### 2. The owner can still see their own private meme

**Do:** Open the private meme's `/m/<slug>` link while logged in as the
creator.

**Expect:** it loads normally.

### 3. Nobody else can see it

**Do:** Open the same `/m/<slug>` link in a logged-out browser, or while
signed in as a different account.

**Expect:** it looks like a missing meme ("not found") — not the meme.

### 4. No social preview card

**Do:** Paste the private meme's link into a place that unfurls previews
(Slack, iMessage, Twitter).

**Expect:** a generic or no preview — not the meme's image and text.

### 5. Public memes are unaffected

**Do:** Open a normal public meme's `/m/<slug>` link.

**Expect:** it still opens for everyone, still previews on social, and
still loads fast (cached) — exactly as before.

## Regression

### R1. Owner opens their own private meme

**Do:** As the creator, open the private meme's link.

**Expect:** loads.

### R2. Admin opens a private meme

**Do:** As an admin, open a private meme that belongs to someone else.

**Expect:** loads.

### R3. Another user or a logged-out visitor opens a private meme

**Do:** As a different user, or logged out, open a private meme's link.

**Expect:** "not found."

### R4. A private meme's link is pasted for a social preview

**Do:** Paste a private meme's link somewhere that unfurls previews.

**Expect:** generic or no preview.

### R5. A public meme is opened by any viewer

**Do:** Open a public meme's link as any viewer.

**Expect:** loads and previews, as before.

### R6. "Share" on your own private meme

**Do:** Use the "Share" copy/buttons on your own private meme.

**Expect:** they work for you.

### R7. "Share" on someone else's private meme

**Do:** Try to use "Share" on a private meme you don't own.

**Expect:** "not found."

### R8. Order a product from your own private meme

**Do:** Order a product (Zazzle) from your own private meme.

**Expect:** works for you.

### R9. Order a product from someone else's private meme

**Do:** Try to order a product from a private meme you don't own.

**Expect:** "not found."

## Not bugs

- **A private meme whose creator's account was deleted becomes
  admin-only.** With no owner left, only an admin can view it —
  intended (fail-safe).
- **Only legendary accounts can make memes private** in the first place
  (that's the existing product rule; unchanged here). Everyone else's
  memes are public.
- **The CDN/edge cache fix for private images depends on the Cloudflare
  worker being redeployed.** The app itself already marks private images
  "do not cache"; the edge fully honors it after the worker's next
  deploy. Until then, the app-level protection (404 to non-owners) is
  already in force.
