# PR #425 — One resolver, one client contract, no admin lockout — UAT

Your in-app acceptance test, David.

**Why this exists.** PR #402 was one instance of a class, not a one-off.
The system answered "is this account allowed to do this?" in two different
vocabularies — a **tier** (`unregistered/registered/legendary`, which the
Feature Permission Grid is keyed on) and a **role** (the same three plus
`admin`) — and every gate in the codebase picked one by hand. An admin's
stored tier is `registered`, so the grid's whole Admin column was
unreachable: the checkboxes rendered, and nothing read them.

Three things follow from that, and this PR fixes all three:

1. **The Admin column was decorative.** Every place an admin should have
   qualified had a hand-written exception in code instead —
   thirteen-plus of them, in three different shapes. Two of them denied
   admins by accident.
2. **The client guessed.** A dozen surfaces derived "is this person
   Legendary?" from the role, client-side, and the server derived it
   differently. That disagreement is what published your private meme.
3. **You could lock yourself out.** Once you turned "view as user" on, no
   button anywhere could turn it back off — and the admin screen told you
   "Access Denied", which is the worst possible thing to say to someone
   who still has access and just can't see it.

**The headline:** the Features screen is now real. Toggling a checkbox
changes what people can actually do, without a deploy.

**One thing to expect while testing:** changes in Admin → Features take
effect within about **a minute** — that's the resolver's cache window, and
it's real. In practice the server you just toggled from updates
immediately, so a reload is usually enough; if a toggle still seems not to
have worked, wait a minute and reload again before treating it as a
finding.

**Steps 6, 7, 8 and 9 are now proven in CI and can be skipped** (PR #570,
`e2e/adminPermissions.spec.ts`). They run on every push and assert the
exit / resume / preview-gate behaviour, including that leaving admin mode
genuinely withdraws entitlements rather than just relabelling the button.
Run them only if you want to see it with your own eyes.

**Steps 1–3 are NOT covered and still want your eyes.** CI proves the same
*mechanism* on a different feature, because `custom_avatar` needs a stored
photo and CI has no way to produce one. So "the Admin column is real" is
machine-proven; "`custom_avatar` specifically works" is not.

## Setup

- [claude] Run the Replit engineering checklist first, against the live
  database: `docs/tests/Replit/PR425_ADMIN_PERMISSIONS_CORE_TEST_RUN.md`.
- [claude] Confirm the app is up before step 1. There's no feature flag —
  it's live everywhere.
- [david] In Admin → Features, note the current checked state of
  `custom_avatar` (Admin, Legendary) and `video_generation` (Legendary,
  Admin), then set all four to checked — the steps below need that
  starting state to demonstrate the uncheck/recheck behavior meaningfully.
  This is admin-gated setup: I hold no admin session, so it's yours to do,
  not mine.
- [david] Have ready: your **admin** account, a **plain registered**
  account, a private/incognito window for the logged-out checks, and — if
  you have one — a genuinely **Legendary** (paid) account for step 4.
- [restore] All four cells restored to the state noted above, not to
  "checked" — if any was intentionally off before the run, this run must
  not leave it on. Note that step 4 unchecks `custom_avatar` for Admin and
  nothing later in the steps re-checks it, so this is load-bearing even on
  a clean pass, not only on a stop mid-step. Admin-gated like the setup
  above, so David's to execute.

## Steps

### 1. Admin gets custom avatar through the grid, not the tier

**Do:** As admin, go to your Profile and, if you have a photo uploaded,
select it as your avatar.

**Expect:** The custom-avatar option is available to you, even though your
stored tier is `registered` — the Admin column in Admin → Features is
granting it.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/featureAccess.integration.test.ts:union semantics the admin overlay ADDS rather than replaces` `artifacts/api-server/src/__tests__/effectiveAvatar.integration.test.ts:the effective-avatar projection resolves the SUBJECT's entitlement — an admin subject gets the overlay`; `artifacts/overhype-me/e2e/adminPermissions.spec.ts:the Admin cell alone grants a registered-tier admin the custom-avatar photo, and unchecking it takes it away`

### 2. Unchecking the Admin cell actually removes the capability

**Do:** In Admin → Features, uncheck `custom_avatar` for **Admin**, wait
about a minute, then reload your Profile.

**Expect:** The custom-avatar selection is now refused, and your avatar
falls back to the generated icon. If nothing changed, the column is still
decorative and the core of this PR did not land.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminPermissions.spec.ts:the Admin grid row grants a capability the account's own tier does not`; `artifacts/overhype-me/e2e/adminPermissions.spec.ts:the Admin cell alone grants a registered-tier admin the custom-avatar photo, and unchecking it takes it away`

### 3. Re-checking the Admin cell restores it

**Do:** Re-check `custom_avatar` for **Admin** in Admin → Features, wait
about a minute, then reload your Profile.

**Expect:** It's back — the custom-avatar option is available again.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminPermissions.spec.ts:the Admin grid row grants a capability the account's own tier does not`; `artifacts/overhype-me/e2e/adminPermissions.spec.ts:the Admin cell alone grants a registered-tier admin the custom-avatar photo, and unchecking it takes it away`

### 4. A Legendary account keeps the feature independent of the Admin cell

**Do:** In Admin → Features, uncheck `custom_avatar` for **Admin** but
leave **Legendary** checked; then, if you have a genuinely Legendary
account, log in as it.

**Expect:** It still has the custom avatar — its own tier grants it, not
the admin overlay.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/featureAccess.integration.test.ts:union semantics turning the admin row off does not remove what the account's own tier grants` `artifacts/api-server/src/__tests__/effectiveAvatar.integration.test.ts:the effective-avatar projection shows an entitled user's selected photo`; `artifacts/api-server/src/__tests__/effectiveAvatar.integration.test.ts:still shows the selected photo for a Legendary subject, admin and non-admin`

### 5. The admin account loses the feature when only its own cell is off

**Do:** On your admin account (stored tier `registered`), check whether
the custom-avatar option is still available.

**Expect:** It's gone. An admin's features are its tier plus the Admin
row, never the Admin row instead of its tier — so an admin who also pays
for Legendary can never lose a feature by being an admin.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/featureAccess.integration.test.ts:union semantics turning the admin row off does not remove what the account's own tier grants`; `artifacts/api-server/src/__tests__/featureAccess.integration.test.ts:union semantics an admin resolves a superset of what their own tier alone resolves` — the overlay never removes a tier grant; `artifacts/api-server/src/__tests__/featureAccess.integration.test.ts:own-tier monotonicity (PR #402) being an admin never makes an account worse off, for any key or tier` — no tier loses a key by being admin; `artifacts/overhype-me/e2e/adminPermissions.spec.ts:the Admin cell alone grants a registered-tier admin the custom-avatar photo, and unchecking it takes it away`

### 6. Exiting admin mode switches you to a normal view

**Do:** As admin, tap your avatar in the top-right — it opens your
**Profile** page — and click **Exit Admin** there.

**Expect:** The site reloads as a registered user would see it.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminPermissions.spec.ts:Exit Admin drops the Admin row's entitlements, and leaves a way back`; `artifacts/overhype-me/e2e/adminPermissions.spec.ts:Exit Admin hides the Admin Panel and withdraws private memes; Resume Admin on Profile restores them`

### 7. A way back into admin is always visible

**Do:** Look at the same spot on your Profile page where **Exit Admin**
was.

**Expect:** The button now reads **Resume Admin**. Before this PR there
wasn't one — every entry point was hidden unless admin mode was already on,
so once you left, you were stuck.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminPermissions.spec.ts:Exit Admin drops the Admin row's entitlements, and leaves a way back`

### 8. Visiting /admin while previewing explains itself instead of refusing

**Do:** While still in "view as user", navigate to **`/admin`**.

**Expect:** A **"Viewing as a user"** panel explaining the state, with a
working **Resume admin** button — *not* "Access Denied".

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminPermissions.spec.ts:/admin while previewing explains the state instead of refusing`

### 9. Resume Admin actually restores admin

**Do:** Click **Resume admin**.

**Expect:** You're back to full admin, and `/admin` renders normally.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminPermissions.spec.ts:Resume admin restores the console`

### 10. Preview mode hides Legendary features too

**Do:** As admin, click **Exit Admin** on your Profile page, then go to a
fact and open the meme builder, pick Image, pick a photo.

**Expect:** The **Private** pill is **locked** — you're previewing as a
registered member, and registered members don't get private memes.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/featureAccess.integration.test.ts:principal normalization view-as-user normalizes to registered, not to the account's own paid tier` `artifacts/overhype-me/src/components/meme-builder/wizard/__tests__/MemeBuilderWizard.test.tsx:MemeBuilderWizard visibility control on Step 2 shows a registered creator the upsell instead of letting them pick private`; `artifacts/overhype-me/e2e/adminPermissions.spec.ts:Exit Admin hides the Admin Panel and withdraws private memes; Resume Admin on Profile restores them`

### 11. Admin console access ignores the preview toggle

**Do:** While still previewing as a user, try to reach `/admin`.

**Expect:** You can still reach it (see step 8) — admin *privileges*
deliberately ignore the preview toggle; only product *features* preview.
That split is the safety property: nothing you can toggle in Features, and
no preview state, can ever cost you console access.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminPermissions.spec.ts:/admin while previewing explains the state instead of refusing` `artifacts/api-server/src/__tests__/tierMiddleware.test.ts:requireRole('admin') — unified middleware calls next for an admin even when adminModeDisabled (realUserRole ignores the toggle)`; `artifacts/api-server/src/__tests__/authMiddleware.fresh.test.ts:realUserRole stays 'admin' even when adminModeDisabled toggle is set (userRole becomes 'registered')` — the session middleware keeps realUserRole admin under the toggle; `artifacts/overhype-me/e2e/adminPermissions.spec.ts:with every Admin-row cell off, the admin still gets the console`

### 12. Resuming admin restores Legendary features

**Do:** Go back to your Profile page and click **Resume Admin**, then
return to the meme builder for the same fact and pick Image again.

**Expect:** The Private pill is available again.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/featureAccess.integration.test.ts:principal normalization an admin not previewing keeps their own tier and the overlay` `artifacts/overhype-me/src/components/meme-builder/wizard/__tests__/MemeBuilderWizard.test.tsx:MemeBuilderWizard visibility control on Step 2 lets a legendary creator choose private before saving`; `artifacts/overhype-me/e2e/adminPermissions.spec.ts:Exit Admin hides the Admin Panel and withdraws private memes; Resume Admin on Profile restores them`

### 13. Private memes still save private — the #402 regression

**Do:** As admin, `/facts/39/meme` → Image → pick a photo → set
**Private** → save.

**Expect:** Saves normally, lands on the permalink, renders for you.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/phase4.memes.save.test.ts:POST /api/memes — private visibility gate stores isPublic=false for an admin whose membership tier is only registered`

**Deferred:** #628 — Phase 7 (The image offering) — the wizard's save-and-land path to the permalink is reworked there, with scripted builder journeys for free and Legendary accounts

### 14. A private meme is still invisible logged out

**Do:** Open the permalink from step 13 in a **private/incognito window**.

**Expect:** Does **not** load.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/memes.privacy-cache.test.ts:GET /memes/:slug — private-meme owner-only enforcement an unauthenticated caller gets 404`

**Deferred:** #628 — Phase 6 (The loop) — #591 rewrites the private-meme not-found page and its privacy suite covers permalinks, and the cited check proves the API 404, not the page a logged-out visitor sees

### 15. Photo upload during onboarding is never gated

**Do:** On a plain registered account, go through profile photo upload /
onboarding and upload a photo.

**Expect:** The upload **succeeds**. No error, no block. (The gate is on
*selecting* a photo as your avatar, never on uploading one — the photo you
upload is also the identity photo the meme and video generators use, so
gating the upload would break free onboarding.)

**Lane:** scripted

**Check:** `artifacts/api-server/src/__tests__/routes.users.test.ts:POST /users/me/profile-image — task #507 stores the photo but skips the avatarSource flip for an unentitled user`; `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 7: the free account uploads the photo through the avatar route and sets it as its profile photo, and its profile photo URL serves the same bytes

### 16. The public avatar stays generic until upgraded

**Do:** On the same account, check your public avatar.

**Expect:** It stays the **generated icon** — the photo is stored but not
shown.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/effectiveAvatar.integration.test.ts:the effective-avatar projection shows the generated icon for a stored photo that was never selected`; `artifacts/api-server/src/__tests__/routes.users.test.ts:POST /users/me/profile-image — task #507 stores the photo but skips the avatarSource flip for an unentitled user` — the photo is stored; `artifacts/api-server/src/__tests__/routes.facts.test.ts:logged out, submittedByImage and comment authorImage are the generated icon for an author with a stored but unselected photo`

**Deferred:** #628 — Phase 6 (The loop) — the public fact page gets its browser journey there, and the route assertion proves the avatar URL the API returns, not the icon the logged-out page shows

### 17. Selecting the photo as avatar is refused with an upgrade prompt

**Do:** Try to select the uploaded photo as your avatar from the Profile
screen.

**Expect:** A clear refusal with an upgrade prompt — not a silent no-op
and not a generic error.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.users.test.ts:POST /users/me/profile-image — task #507 rejects a standalone avatarSource:photo selection from an unentitled user`; `artifacts/overhype-me/e2e/adminPermissions.spec.ts:the free account: refused at /admin/help, photo withheld and its selection refused, and a submission confirmed`

### 18. An entitled account can select the same photo

**Do:** On your admin (or a Legendary) account, select an uploaded photo
as your avatar.

**Expect:** It works, and the avatar shows.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.users.test.ts:POST /users/me/profile-image — task #507 allows a standalone avatarSource:photo selection from an entitled user`; `artifacts/api-server/src/__tests__/effectiveAvatar.integration.test.ts:the effective-avatar projection shows an entitled user's selected photo`; `artifacts/overhype-me/e2e/adminPermissions.spec.ts:the paid account selects its stored photo and the avatar shows it`

### 19. An unselected identity photo doesn't leak next to a submission or comment

**Do:** Using a registered account that has uploaded a photo but not
selected it as its avatar (step 15 leaves you with exactly this), submit a
fact and post a comment on any fact, then view that fact's page logged
out.

**Expect:** Next to the submission and next to the comment, you see the
**generated icon**, not the uploaded photo. (Previously, an unselected
identity photo was still displayed publicly next to submissions and
comments, because those two listings never looked at the avatar setting at
all — a pre-existing bug closed on the way past.)

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/effectiveAvatar.integration.test.ts:the effective-avatar projection shows the generated icon for a stored photo that was never selected`; `artifacts/api-server/src/__tests__/routes.facts.test.ts:logged out, submittedByImage and comment authorImage are the generated icon for an author with a stored but unselected photo`

**Deferred:** #628 — Phase 6 (The loop) — the public fact page gets its browser journey there, and the route assertion proves the avatar URL the API returns, not the icon the logged-out page shows

### 20. The same account's own profile also withholds the photo

**Do:** View that account's own Profile page.

**Expect:** It shows the generated icon too.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/adminPermissions.spec.ts:the free account: refused at /admin/help, photo withheld and its selection refused, and a submission confirmed`

_Step 21 retired with video, which launch Phase 4 deleted (removal 2, #744; ledger: `docs/retired/README.md`)._

_Step 22 retired with video, which launch Phase 4 deleted (removal 2, #744; ledger: `docs/retired/README.md`)._

_Step 23 retired with video, which launch Phase 4 deleted (removal 2, #744; ledger: `docs/retired/README.md`)._

## Regression

### R1. Logged-out browsing still works

**Do:** Open `/`, a fact page, and a public meme permalink while logged
out.

**Expect:** All load normally, no login wall.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/routeLoadSmoke.spec.ts` `artifacts/api-server/src/__tests__/memes.privacy-cache.test.ts:GET /memes/:slug — private-meme owner-only enforcement a public meme is visible to anyone`; `artifacts/overhype-me/e2e/routeLoadSmoke.spec.ts:logged out, the ordinary and feed routes load with no sign-in wall, no error and no redirect`

**Deferred:** #628 — Phase 6 (The loop) — the public fact page and meme permalink page get their browser journey there

### R2. Commenting captcha is unchanged for a registered user

**Do:** Post a comment as a registered user.

**Expect:** Captcha behaves as before.

**Lane:** ci

**Deferred:** #628 — Phase 5 (Account and identity) — Turnstile replaces hCaptcha at comments there, and Phase 9 rebuilds comment posting

### R3. Admins and Legendary still bypass the comment captcha

**Do:** Post a comment as admin or Legendary.

**Expect:** No captcha.

**Lane:** ci

**Deferred:** #628 — Phase 5 (Account and identity) — Turnstile replaces hCaptcha at comments there, and Phase 9 rebuilds comment posting

### R4. Fact submission is unchanged

**Do:** Submit a fact as a registered user.

**Expect:** Rate limit and captcha behave as before.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.reviews.test.ts:returns 403 ONBOARDING_REQUIRED for non-admin/non-legendary/non-captcha users` `artifacts/api-server/src/__tests__/routes.reviews.test.ts:PENDING CAP: returns 429 PENDING_CAP_REACHED when the user is at the unresolved cap`; `artifacts/api-server/src/__tests__/routes.reviews.test.ts:happy path: inserts a triage_pending review with NO paid prep and returns 201` — a verified registered user still submits; `artifacts/api-server/src/__tests__/routes.reviews.test.ts:PER-MINUTE LIMIT: a non-admin account's submission past the fact_submit window max gets 429 with the 'too quickly' message`

_Step R5 retired with the legacy meme studio, which launch Phase 4 deleted (removal 1, #744; ledger: `docs/retired/README.md`)._

### R6. Ad slots still follow tier

**Do:** Browse as a registered user, then as Legendary.

**Expect:** Ads show for registered, none for Legendary.

**Lane:** ci

**Deferred:** #628 — Phase 10 (Membership and money) — ad-free is an inert grid row at launch with no ad surface live, and the Legendary row set is defined there

### R7. The rest of the admin console still loads

**Do:** Open every admin screen you use often.

**Expect:** Each loads exactly as before.

**Lane:** ci

**Check:** `artifacts/overhype-me/e2e/routeLoadSmoke.spec.ts`; `artifacts/overhype-me/e2e/routeLoadSmoke.spec.ts:Users shows each tier, an admin grant as a grant, creates a Legendary user, and keeps a revoked grant`

### R8. Admin notification preferences still work

**Do:** Go to Profile → notification preferences as admin.

**Expect:** Visible and editable.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.users.test.ts:PATCH /users/me/notifications updates both flags for admin users`; `artifacts/overhype-me/e2e/adminPermissions.spec.ts:Exit Admin hides the Admin Panel and withdraws private memes; Resume Admin on Profile restores them`

_Step R9 retired with PuLID, which launch Phase 4 deleted (removal 3, #744; ledger: `docs/retired/README.md`)._

### R10. Profile edits still save

**Do:** Change display name, pronouns, and avatar style.

**Expect:** Saves.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.users.test.ts:PATCH /users/me — success trims and persists string fields`

## Not bugs

- **Grid changes take up to ~1 minute to appear.** That's the resolver
  cache, and the Features screen says so. The process you're talking to
  updates immediately; others catch up within the window.
- **Numeric limits are untouched.** Spend budgets, upload caps, save caps,
  and rate limits are all still where they were — they're the next plan.
  The Features screen shows boolean features only.
- **Engine access is untouched.** `engine_experiments` still has no rows
  and engines are still admin-only via a hardcoded check. That's Plan 3.
- **Visibility is still chosen at creation only.** Unchanged from #402 —
  there is still no way to flip a meme's visibility afterwards.
- **The grid's write protection isn't here yet.** Right now the rules
  hold because our code is the only thing that writes the grid. Making
  that unbypassable at the database level is PR #422, which ships after
  this one.
