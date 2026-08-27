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

### 2. Unchecking the Admin cell actually removes the capability

**Do:** In Admin → Features, uncheck `custom_avatar` for **Admin**, wait
about a minute, then reload your Profile.

**Expect:** The custom-avatar selection is now refused, and your avatar
falls back to the generated icon. If nothing changed, the column is still
decorative and the core of this PR did not land.

### 3. Re-checking the Admin cell restores it

**Do:** Re-check `custom_avatar` for **Admin** in Admin → Features, wait
about a minute, then reload your Profile.

**Expect:** It's back — the custom-avatar option is available again.

### 4. A Legendary account keeps the feature independent of the Admin cell

**Do:** In Admin → Features, uncheck `custom_avatar` for **Admin** but
leave **Legendary** checked; then, if you have a genuinely Legendary
account, log in as it.

**Expect:** It still has the custom avatar — its own tier grants it, not
the admin overlay.

### 5. The admin account loses the feature when only its own cell is off

**Do:** On your admin account (stored tier `registered`), check whether
the custom-avatar option is still available.

**Expect:** It's gone. An admin's features are its tier plus the Admin
row, never the Admin row instead of its tier — so an admin who also pays
for Legendary can never lose a feature by being an admin.

### 6. Exiting admin mode switches you to a normal view

**Do:** As admin, tap your avatar in the top-right — it opens your
**Profile** page — and click **Exit Admin** there.

**Expect:** The site reloads as a registered user would see it.

### 7. A way back into admin is always visible

**Do:** Look at the same spot on your Profile page where **Exit Admin**
was.

**Expect:** The button now reads **Resume Admin**. Before this PR there
wasn't one — every entry point was hidden unless admin mode was already on,
so once you left, you were stuck.

### 8. Visiting /admin while previewing explains itself instead of refusing

**Do:** While still in "view as user", navigate to **`/admin`**.

**Expect:** A **"Viewing as a user"** panel explaining the state, with a
working **Resume admin** button — *not* "Access Denied".

### 9. Resume Admin actually restores admin

**Do:** Click **Resume admin**.

**Expect:** You're back to full admin, and `/admin` renders normally.

### 10. Preview mode hides Legendary features too

**Do:** As admin, click **Exit Admin** on your Profile page, then go to a
fact and open the meme builder, pick Image, pick a photo.

**Expect:** The **Private** pill is **locked** — you're previewing as a
registered member, and registered members don't get private memes.

### 11. Admin console access ignores the preview toggle

**Do:** While still previewing as a user, try to reach `/admin`.

**Expect:** You can still reach it (see step 8) — admin *privileges*
deliberately ignore the preview toggle; only product *features* preview.
That split is the safety property: nothing you can toggle in Features, and
no preview state, can ever cost you console access.

### 12. Resuming admin restores Legendary features

**Do:** Go back to your Profile page and click **Resume Admin**, then
return to the meme builder for the same fact and pick Image again.

**Expect:** The Private pill is available again.

### 13. Private memes still save private — the #402 regression

**Do:** As admin, `/facts/39/meme` → Image → pick a photo → set
**Private** → save.

**Expect:** Saves normally, lands on the permalink, renders for you.

### 14. A private meme is still invisible logged out

**Do:** Open the permalink from step 13 in a **private/incognito window**.

**Expect:** Does **not** load.

### 15. Photo upload during onboarding is never gated

**Do:** On a plain registered account, go through profile photo upload /
onboarding and upload a photo.

**Expect:** The upload **succeeds**. No error, no block. (The gate is on
*selecting* a photo as your avatar, never on uploading one — the photo you
upload is also the identity photo the meme and video generators use, so
gating the upload would break free onboarding.)

### 16. The public avatar stays generic until upgraded

**Do:** On the same account, check your public avatar.

**Expect:** It stays the **generated icon** — the photo is stored but not
shown.

### 17. Selecting the photo as avatar is refused with an upgrade prompt

**Do:** Try to select the uploaded photo as your avatar from the Profile
screen.

**Expect:** A clear refusal with an upgrade prompt — not a silent no-op
and not a generic error.

### 18. An entitled account can select the same photo

**Do:** On your admin (or a Legendary) account, select an uploaded photo
as your avatar.

**Expect:** It works, and the avatar shows.

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

### 20. The same account's own profile also withholds the photo

**Do:** View that account's own Profile page.

**Expect:** It shows the generated icon too.

### 21. Video generation still works before any toggle

**Do:** As admin or Legendary, generate a video from a fact.

**Expect:** Works as before.

### 22. Switching video_generation off actually blocks it

**Do:** In Admin → Features, uncheck `video_generation` for **Legendary**
and **Admin**, then wait about a minute.

**Expect:** Video generation is now refused with the Legendary-upgrade
message. (Before this PR, `video_generation` could not be switched off at
all — the server re-asserted the seeded values on every restart, so any
change survived until the next deploy and then silently reverted. That
re-seeding is gone.)

### 23. Switching it back on restores it

**Do:** Re-check `video_generation` for **Legendary** and **Admin**, then
wait about a minute.

**Expect:** Working again.

## Regression

### R1. Logged-out browsing still works

**Do:** Open `/`, a fact page, and a public meme permalink while logged
out.

**Expect:** All load normally, no login wall.

### R2. Commenting captcha is unchanged for a registered user

**Do:** Post a comment as a registered user.

**Expect:** Captcha behaves as before.

### R3. Admins and Legendary still bypass the comment captcha

**Do:** Post a comment as admin or Legendary.

**Expect:** No captcha.

### R4. Fact submission is unchanged

**Do:** Submit a fact as a registered user.

**Expect:** Rate limit and captcha behave as before.

### R5. AI backgrounds still generate

**Do:** Open the AI background picker as admin or Legendary and generate
one.

**Expect:** Generate works.

### R6. Ad slots still follow tier

**Do:** Browse as a registered user, then as Legendary.

**Expect:** Ads show for registered, none for Legendary.

### R7. The rest of the admin console still loads

**Do:** Open every admin screen you use often.

**Expect:** Each loads exactly as before.

### R8. Admin notification preferences still work

**Do:** Go to Profile → notification preferences as admin.

**Expect:** Visible and editable.

### R9. PuLID (stylized photo) memes still work

**Do:** Create a stylized photo meme as admin or Legendary.

**Expect:** Works.

### R10. Profile edits still save

**Do:** Change display name, pronouns, and avatar style.

**Expect:** Saves.

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
