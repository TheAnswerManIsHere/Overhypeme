# PR #402 — Private memes were saving as public — UAT

Your in-app acceptance test, David.

**Why this exists.** You made a meme private, signed out, opened its link,
and it rendered in full. The read side was never the problem — every
surface that serves a meme checks visibility correctly, and has for a long
time. The meme was simply **saved public in the first place**, so there
was nothing private for those checks to protect.

Two things caused that, and this PR fixes both:

1. **The server didn't count you as Legendary.** Privacy is a
   Legendary-level feature. The builder treats an admin as Legendary —
   which is why the Private pill was live for you and let you select it —
   but the save path was checking your *membership tier*, and an admin's
   stored tier is "registered" unless you separately hold a paid
   membership. So the save decided you weren't entitled to privacy. This
   is why #394's control looked like it did nothing: it worked exactly as
   designed and the save ignored it.
2. **When the save decided that, it published the meme anyway.** Instead
   of telling you "you can't do that," it quietly rewrote your Private
   choice to Public and reported success. That's the part that turned a
   permissions mismatch into an actual exposure — you were told it saved,
   and it had.

Now: an account that *is* entitled gets private, and an account that isn't
gets a visible error instead of a public meme.

**Still true after this PR, and worth a decision:** visibility is chosen
at creation time only. There is no way to change a meme's visibility
afterwards — which means **`/m/o1bV9xne49`, the meme from your report, is
still public**, and the only way to take it down is to delete it. A
post-creation switch is separate work; say the word and I'll scope it.

## Setup

- [claude] Confirm the app is up before you start. There's no feature flag
  — it's live everywhere the wizard is.
- [david] Have ready: your **admin** account, a **plain registered**
  account, a private/incognito window for the logged-out checks, and — if
  you have one — a genuinely **Legendary** (paid) account for step 6 (the
  whole point of step 1 is that you shouldn't need one).

## Steps

### 1. Private now actually saves private — on your admin account

**Do:** Log in as **admin**, go to `/facts/39/meme`, pick "Image", pick a
photo, set the control above **Make my meme** to **Private**, and save.

**Expect:** It saves normally. You land on the permalink and the meme
renders for you, the creator.

### 2. A private meme is not reachable logged out

**Do:** Copy the permalink from step 1 and open it in a
**private/incognito window**.

**Expect:** It does **not** load — you get the not-found page, not a "no
permission" page. A private meme shouldn't even admit it exists. Before
this PR that link would have rendered for the logged-out window, which is
exactly what you saw.

### 3. The creator can still see it afterward

**Do:** Signed back in as the creator, open the same permalink again.

**Expect:** The link still works.

### 4. The public path is untouched

**Do:** On the same account, make a second meme on the same fact and leave
it **Public**.

**Expect:** Saves normally, and the permalink opens fine logged-out.

### 5. A public meme appears in listings

**Do:** While logged out, check the fact's meme list and the gallery.

**Expect:** The public meme shows up in both.

### 6. A real Legendary account still gets privacy

**Do:** If you have one, log in as **Legendary** (paid, non-admin), set
Private, save, and check the permalink logged-out.

**Expect:** Not-found logged-out, visible to the creator — same as step 1.
This is the path that was always supposed to work; the fix must not have
traded one entitled account for another.

### 7. A plain registered account is still offered the upgrade, not the feature

**Do:** Log in as your **plain registered** account and start a meme.

**Expect:** The control is visible, and **Private** is dimmed with the
`LEGEND` badge.

### 8. Tapping Private for a registered account opens the upgrade modal

**Do:** Tap **Private**.

**Expect:** The upgrade modal opens, and closing it leaves **Public**
selected with your in-progress meme intact.

### 9. A registered account's meme still saves public

**Do:** Save it, then open the permalink logged-out.

**Expect:** It loads — a registered user's meme is public; that rule
hasn't changed.

### 10. Logged-out visitors still see no control

**Do:** Logged out, open `/facts/39/meme`.

**Expect:** No visibility control at all — unchanged.

### 11. Video memes still work

**Do:** Make a video meme.

**Expect:** Works normally. Video memes have no privacy field at all —
that's the pre-existing gap #394 flagged, not something this PR touches.

## Regression

### R1. An ordinary public image meme completes end-to-end

**Do:** Build and save an ordinary public image meme from start to
finish.

**Expect:** Completes normally, same as before this PR.

## Not bugs

- **A denied private request now fails loudly instead of silently
  downgrading.** If an entitled session's membership lapses while the
  builder is open, and you'd already picked Private, the save will refuse
  with *"Private memes are a Legendary feature."* rather than saving it
  public. That's the correct, deliberate behavior — publishing something
  you asked to keep private must never be a quiet outcome. Only worth
  reporting if you hit it on an account you believe is currently entitled.
