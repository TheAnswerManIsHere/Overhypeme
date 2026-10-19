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

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/phase4.memes.save.test.ts:stores isPublic=false for an admin whose membership tier is only registered`; `artifacts/api-server/src/__tests__/memes.privacy-cache.test.ts:owner sees a private meme (200) and it is no-store`; `artifacts/api-server/src/__tests__/memes.privacy-cache.test.ts:serves a private meme to its non-admin owner as a decodable image`; `artifacts/overhype-me/src/components/meme-builder/wizard/__tests__/MemeBuilderWizard.test.tsx:saving with Private picked in the builder sends isPublic false and the browser lands on the returned permalink`

### 2. A private meme is not reachable logged out

**Do:** Copy the permalink from step 1 and open it in a
**private/incognito window**.

**Expect:** It does **not** load — you get the not-found page, not a "no
permission" page. A private meme shouldn't even admit it exists. Before
this PR that link would have rendered for the logged-out window, which is
exactly what you saw.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/memes.privacy-cache.test.ts:an unauthenticated caller gets 404`

**Deferred:** #628 — Phase 6 (The loop) — #591 rewrites the private-meme not-found page and its privacy suite covers permalinks, and the cited check proves the API 404, not the page a logged-out visitor sees

### 3. The creator can still see it afterward

**Do:** Signed back in as the creator, open the same permalink again.

**Expect:** The link still works.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/memes.privacy-cache.test.ts:owner sees a private meme (200) and it is no-store`; `artifacts/api-server/src/__tests__/memes.privacy-cache.test.ts:serves a private meme to its non-admin owner as a decodable image`

### 4. The public path is untouched

**Do:** On the same account, make a second meme on the same fact and leave
it **Public**.

**Expect:** Saves normally, and the permalink opens fine logged-out.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/memes.privacy-cache.test.ts:a public meme is visible to anyone`; `artifacts/api-server/src/__tests__/phase4.memes.save.test.ts:still defaults to public when isPublic is omitted, at every tier`; `artifacts/api-server/src/__tests__/phase4.memes.save.test.ts:stores isPublic=true when a legendary user explicitly asks for public` — the explicit isPublic true the builder sends is stored public; `artifacts/api-server/src/__tests__/phase4.memes.save.test.ts:a Public save right after a Private one with otherwise identical inputs is a new public meme, not the private one`; `artifacts/api-server/src/__tests__/memes.privacy-cache.test.ts:serves a public meme to a logged-out caller as a decodable image`; `artifacts/overhype-me/src/components/meme-builder/wizard/__tests__/MemeBuilderWizard.test.tsx:saving with the control left on Public posts isPublic true to /api/memes and navigates to the returned permalink`

### 5. A public meme appears in listings

**Do:** While logged out, check the fact's meme list and the gallery.

**Expect:** The public meme shows up in both: the fact's meme list, and
the fact page's "Memes from this fact" gallery under Community, where the
private one does not appear.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/publicScreens.spec.ts:logged out, the fact page's gallery shows the public meme and not the private one`; `artifacts/api-server/src/__tests__/routes.memes.test.ts:logged out, the community view returns the fact's public meme and omits its private one`

### 6. A real Legendary account still gets privacy

**Do:** If you have one, log in as **Legendary** (paid, non-admin), set
Private, save, and check the permalink logged-out.

**Expect:** Not-found logged-out, visible to the creator — same as step 1.
This is the path that was always supposed to work; the fix must not have
traded one entitled account for another.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/phase4.memes.save.test.ts:stores isPublic=false for a legendary user`; `artifacts/api-server/src/__tests__/memes.privacy-cache.test.ts:an unauthenticated caller gets 404`; `artifacts/api-server/src/__tests__/memes.privacy-cache.test.ts:owner sees a private meme (200) and it is no-store`; `artifacts/api-server/src/__tests__/memes.privacy-cache.test.ts:serves a private meme to its non-admin owner as a decodable image`; `artifacts/overhype-me/src/components/meme-builder/wizard/__tests__/MemeBuilderWizard.test.tsx:saving with Private picked in the builder sends isPublic false and the browser lands on the returned permalink`

**Deferred:** #628 — Phase 6 (The loop) — #591 rewrites the private-meme not-found page and its privacy suite covers permalinks, and the cited check proves the API 404, not the page a logged-out visitor sees

### 7. A plain registered account is still offered the upgrade, not the feature

**Do:** Log in as your **plain registered** account and start a meme.

**Expect:** The control is visible, and **Private** is dimmed with the
`LEGEND` badge.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/meme-builder/__tests__/VisibilityToggle.test.tsx:locks private for a registered viewer: upsells instead of selecting`; `artifacts/overhype-me/src/components/meme-builder/wizard/__tests__/MemeBuilderWizard.test.tsx:shows a registered creator the upsell instead of letting them pick private` — the builder renders the control for a registered viewer; `artifacts/overhype-me/e2e/publicScreens.spec.ts:a plain registered account sees the visibility control with Private dimmed and the LEGEND badge`; `artifacts/overhype-me/src/components/meme-builder/__tests__/VisibilityToggle.test.tsx:renders the locked Private pill with the opacity-60 dimming class when canSetPrivate is false`

### 8. Tapping Private for a registered account opens the upgrade modal

**Do:** Tap **Private**.

**Expect:** The upgrade modal opens, and closing it leaves **Public**
selected with your in-progress meme intact.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/meme-builder/__tests__/VisibilityToggle.test.tsx:locks private for a registered viewer: upsells instead of selecting`; `artifacts/overhype-me/src/components/meme-builder/wizard/__tests__/MemeBuilderWizard.test.tsx:shows a registered creator the upsell instead of letting them pick private` — tapping Private opens the upgrade modal's Go Legendary to keep memes private copy; `artifacts/overhype-me/src/components/meme-builder/wizard/__tests__/MemeBuilderWizard.test.tsx:closing the upgrade modal leaves Public selected and the in-progress meme intact`

### 9. A registered account's meme still saves public

**Do:** Save it, then open the permalink logged-out.

**Expect:** It loads — a registered user's meme is public; that rule
hasn't changed.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/phase4.memes.save.test.ts:still defaults to public when isPublic is omitted, at every tier`; `artifacts/api-server/src/__tests__/memes.privacy-cache.test.ts:a public meme is visible to anyone`; `artifacts/api-server/src/__tests__/phase4.memes.save.test.ts:stores isPublic=true and answers 201 when a registered non-admin explicitly asks for public`; `artifacts/api-server/src/__tests__/memes.privacy-cache.test.ts:serves a public meme to a logged-out caller as a decodable image`; `artifacts/overhype-me/src/components/meme-builder/wizard/__tests__/MemeBuilderWizard.test.tsx:saving with the control left on Public posts isPublic true to /api/memes and navigates to the returned permalink`

### 10. Logged-out visitors still see no control

**Do:** Logged out, open `/facts/39/meme`.

**Expect:** The builder opens. Its image step shows the sign-up prompt
for using your own photo and no Public / Private visibility control at all.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/meme-builder/wizard/__tests__/MemeBuilderWizard.test.tsx:omits the control for a viewer who cannot save yet`; `artifacts/overhype-me/e2e/publicScreens.spec.ts:logged out, /facts/:id/meme opens the builder and its image step shows no visibility control`

### 11. Video memes still work

**Do:** Make a video meme.

**Expect:** Works normally. Video memes have no privacy field at all —
that's the pre-existing gap #394 flagged, not something this PR touches.

**Lane:** scripted

**Deferred:** #628 — Phase 4 (Cut and prune) — video memes (pipeline and engines) are on the cut list and are removed with it

## Regression

### R1. An ordinary public image meme completes end-to-end

**Do:** Build and save an ordinary public image meme from start to
finish.

**Expect:** Completes normally, same as before this PR.

**Lane:** scripted

**Check:** `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 4: an ordinary free account saves a public photo meme; anyone reads its permalink and its composed image, the image decoded; `artifacts/overhype-me/src/components/meme-builder/wizard/__tests__/MemeBuilderWizard.test.tsx:saving with the control left on Public posts isPublic true to /api/memes and navigates to the returned permalink`

## Not bugs

- **A denied private request now fails loudly instead of silently
  downgrading.** If an entitled session's membership lapses while the
  builder is open, and you'd already picked Private, the save will refuse
  with *"Private memes are a Legendary feature."* rather than saving it
  public. That's the correct, deliberate behavior — publishing something
  you asked to keep private must never be a quiet outcome. Only worth
  reporting if you hit it on an account you believe is currently entitled.
