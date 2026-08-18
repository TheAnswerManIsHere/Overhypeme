# PR #402 — Private memes were saving as public — UAT

Your in-app acceptance test, David.

**Why this exists.** You made a meme private, signed out, opened its link,
and it rendered in full. The read side was never the problem — every surface
that serves a meme checks visibility correctly, and has for a long time. The
meme was simply **saved public in the first place**, so there was nothing
private for those checks to protect.

Two things caused that, and this PR fixes both:

1. **The server didn't count you as Legendary.** Privacy is a Legendary-level
   feature. The builder treats an admin as Legendary — which is why the
   Private pill was live for you and let you select it — but the save path
   was checking your *membership tier*, and an admin's stored tier is
   "registered" unless you separately hold a paid membership. So the save
   decided you weren't entitled to privacy. This is why #394's control looked
   like it did nothing: it worked exactly as designed and the save ignored it.

2. **When the save decided that, it published the meme anyway.** Instead of
   telling you "you can't do that," it quietly rewrote your Private choice to
   Public and reported success. That's the part that turned a permissions
   mismatch into an actual exposure — you were told it saved, and it had.

Now: an account that *is* entitled gets private, and an account that isn't
gets a visible error instead of a public meme.

**Still true after this PR, and worth a decision:** visibility is chosen at
creation time only. There is no way to change a meme's visibility afterwards
— which means **`/m/o1bV9xne49`, the meme from your report, is still public**
and the only way to take it down is to delete it. A post-creation switch is
separate work; say the word and I'll scope it.

## Before you start

- No feature flag. It's live everywhere the wizard is.
- You'll want your **admin account**, a **plain registered** account, and a
  private/incognito window for the logged-out checks.
- If you happen to have a genuinely **Legendary** (paid) account, use it for
  step 3 — but the whole point of step 1 is that you shouldn't need one.

## The main event

### 1. Private now actually saves private — on your admin account

This is the reported bug. Everything else is making sure the fix didn't cost
something.

- Log in as **admin**, go to `/facts/39/meme`, pick "Image", pick a photo.
- Set the control above **Make my meme** to **Private**, and save.
- ✅ It saves normally. You land on the permalink and the meme renders for
  you, the creator.
- Copy the permalink, then open it in a **private/incognito window**.
- ✅ It does **not** load — you get the not-found page, not a "no permission"
  page. A private meme shouldn't even admit it exists.
- ✅ Signed back in as the creator, the same link still works.

Before this PR that link would have rendered for the logged-out window, which
is exactly what you saw.

### 2. The public path is untouched

- Same account, make a second meme on the same fact, leave it **Public**.
- ✅ Saves normally, and the permalink opens fine logged-out.
- ✅ It shows up in the fact's meme list and the gallery when logged out.

If only step 1 works, the fix reached further than it should have — this is
the check for that.

### 3. A real Legendary account still gets privacy

- If you have one: log in as **Legendary** (paid, non-admin), set Private,
  save, and check the permalink logged-out.
- ✅ Not-found logged-out, visible to the creator — same as step 1.

This is the path that was always supposed to work; the fix must not have
traded one entitled account for another.

### 4. A plain registered account is still offered the upgrade, not the feature

- Log in as your **plain registered** account, start a meme.
- ✅ The control is visible, **Private** is dimmed with the `LEGEND` badge.
- Tap **Private** → ✅ the upgrade modal opens, and closing it leaves
  **Public** selected with your in-progress meme intact.
- Save, then open the permalink logged-out → ✅ it loads. A registered user's
  meme is public; that rule hasn't changed.

Note what you should *not* be able to do here: there's no way to talk the app
into saving a private meme on this account. If it ever did, it would now fail
loudly rather than silently publishing.

### 5. Nothing broke for logged-out visitors or the video flow

- Logged out, open `/facts/39/meme` → ✅ no visibility control at all
  (unchanged).
- ✅ Making a **video** meme still works normally. Video memes have no
  privacy field at all — that's the pre-existing gap #394 flagged, not
  something this PR touches.

## What I'd expect to go wrong, if anything does

The fix makes a denied private request an **error** instead of a silent
downgrade. That's deliberate — publishing something you asked to keep private
must never be a quiet outcome — but it means there's now one new way for a
save to fail: if an entitled session's membership lapses while the builder is
open, and you'd already picked Private, the save will refuse with *"Private
memes are a Legendary feature."* rather than saving it public.

That's the correct behavior, but if you hit it in normal testing on an
account you believe *is* entitled, that's a real finding — tell me and I'll
chase the entitlement, not the message.
