# PR #425 — One resolver, one client contract, no admin lockout — UAT

Your in-app acceptance test, David.

**Why this exists.** PR #402 was one instance of a class, not a one-off. The
system answered "is this account allowed to do this?" in two different
vocabularies — a **tier** (`unregistered/registered/legendary`, which the
Feature Permission Grid is keyed on) and a **role** (the same three plus
`admin`) — and every gate in the codebase picked one by hand. An admin's stored
tier is `registered`, so the grid's whole Admin column was unreachable: the
checkboxes rendered, and nothing read them.

Three things follow from that, and this PR fixes all three:

1. **The Admin column was decorative.** Every place an admin should have
   qualified had a hand-written exception in code instead — thirteen-plus of
   them, in three different shapes. Two of them denied admins by accident.
2. **The client guessed.** A dozen surfaces derived "is this person Legendary?"
   from the role, client-side, and the server derived it differently. That
   disagreement is what published your private meme.
3. **You could lock yourself out.** Once you turned "view as user" on, no
   button anywhere could turn it back off — and the admin screen told you
   "Access Denied", which is the worst possible thing to say to someone who
   still has access and just can't see it.

**The headline:** the Features screen is now real. Toggling a checkbox changes
what people can actually do, without a deploy.

## Before you start

- No feature flag. It's live everywhere.
- You'll want your **admin account**, a **plain registered** account, and a
  private/incognito window for the logged-out checks.
- A few checks use **Admin → Features**. Changes there take effect within about
  **a minute** — that's the resolver's cache window, and it's real. If a toggle
  seems not to have worked, wait a minute and reload before reporting it.
- **Undo everything you toggle.** Section 2 asks you to switch real capability
  off and back on. Note the starting state of each cell before you change it.

## The main event

### 1. The Admin column is live

This is the whole point of the PR. Before it, this test was impossible —
nothing read those cells.

- Log in as **admin**. Go to **Admin → Features**.
- Find the **`custom_avatar`** row. Note its Admin cell (should be checked).
- Go to your **Profile**. If you have a photo uploaded, you can select it as
  your avatar.
  - ✅ The custom-avatar option is available to you, even though your stored
    tier is `registered`. That's the Admin column granting it.
- Go back to **Admin → Features** and **uncheck** `custom_avatar` for **Admin**.
- Wait ~1 minute, reload your Profile.
  - ✅ The custom-avatar selection is now refused for you, and your avatar falls
    back to the generated icon.
- **Re-check the box.** Wait ~1 minute, reload.
  - ✅ It's back.

If unchecking the Admin cell changed nothing, the column is still decorative and
the core of this PR did not land. That's the single most important thing to
report.

### 2. Admin adds, it never replaces

A subtlety worth seeing once, because it looks like a bug if you don't expect it.

- In **Admin → Features**, uncheck `custom_avatar` for **Admin** but leave
  **Legendary** checked.
- If you have a **genuinely Legendary** account, log in as it.
  - ✅ It still has the custom avatar. Its own tier grants it; the admin overlay
    was never what it depended on.
- ✅ On your admin account (stored tier `registered`), the feature is now gone.

That asymmetry is deliberate: an admin's features are *their tier plus the admin
row*, never *the admin row instead of their tier*. So an admin who also pays for
Legendary can never lose a feature by being an admin.

**Re-check the box when you're done.**

### 3. You can always get out of "view as user"

This was a live lockout, and it's the one I'd most want you to confirm.

- As **admin**, open the account menu (tap your avatar) and choose
  **Exit Admin**. The site reloads as a registered user would see it.
- Open the account menu again.
  - ✅ There's now a **Resume Admin** entry. Before this PR there wasn't — every
    entry point was hidden unless admin mode was already on, so once you left,
    you were stuck.
- While still in "view as user", navigate to **`/admin`**.
  - ✅ You get a **"Viewing as a user"** panel explaining the state, with a
    working **Resume admin** button — *not* "Access Denied".
- Click **Resume admin**.
  - ✅ You're back to full admin, and `/admin` renders normally.

### 4. Preview mode actually previews

"View as user" now means something. Previously it flipped your admin flag but
left your membership tier alone, so a Legendary-holding admin previewing as a
user still got every Legendary feature — which made the preview close to
useless.

- As **admin**, choose **Exit Admin**.
- Go to a fact and open the meme builder, pick Image, pick a photo.
  - ✅ The **Private** pill is **locked** — you're previewing as a registered
    member, and registered members don't get private memes.
- ✅ You can still reach `/admin` (see step 3). Admin *privileges* deliberately
  ignore the toggle; only product *features* preview.
- **Resume Admin.** The Private pill is available again.

That split is the safety property: nothing you can toggle in Features, and no
preview state, can ever cost you console access.

### 5. Private memes still work — the #402 regression

- As **admin**, `/facts/39/meme` → Image → pick a photo → set **Private** →
  save.
  - ✅ Saves normally, lands on the permalink, renders for you.
- Open the permalink in a **private/incognito window**.
  - ✅ Does **not** load.

### 6. The custom-avatar upsell is real, and onboarding still works

The gate is on *selecting* a photo as your avatar — never on uploading one.
That distinction matters: the photo you upload is also the identity photo the
meme and video generators use, so gating the upload would have broken free
onboarding.

On a **plain registered** account (not Legendary, not admin):

- Go through profile photo upload / onboarding and upload a photo.
  - ✅ The upload **succeeds**. No error, no block.
- ✅ Your public avatar stays the **generated icon** — the photo is stored but
  not shown.
- Try to select the photo as your avatar from the Profile screen.
  - ✅ You get a clear refusal with an upgrade prompt, not a silent no-op and
    not a generic error.

On your **admin** (or a Legendary) account:

- ✅ Selecting the uploaded photo as your avatar works, and it shows.

### 7. Identity photos stop leaking into public listings

This one is a pre-existing bug being closed on the way past, and it's the check
most likely to surprise you.

Previously, if a user uploaded a photo for meme generation and **never chose it
as their avatar**, that photo was still displayed publicly next to their
submitted facts and their comments — because those two listings never looked at
the avatar setting at all.

- Use a **registered** account that has uploaded a photo but has **not**
  selected it as its avatar (step 6 leaves you with exactly this).
- Submit a fact, and post a comment on any fact.
- View that fact's page — logged out, in an incognito window is fine.
  - ✅ Next to the submission and next to the comment, you see the **generated
    icon**, not the uploaded photo.
- ✅ The same account's own Profile page also shows the generated icon.

### 8. Video generation still works, and can now be switched off

- As **admin** or **Legendary**, generate a video from a fact.
  - ✅ Works as before.
- In **Admin → Features**, uncheck `video_generation` for **Legendary** *and*
  **Admin**. Wait ~1 minute.
  - ✅ Video generation is now refused with the Legendary-upgrade message.
- **Re-check both.** Wait ~1 minute.
  - ✅ Working again.

Before this PR, `video_generation` **could not be switched off at all** — the
server re-asserted the seeded values on every restart, so any change you made
survived until the next deploy and then silently reverted. That re-seeding is
gone.

## Regression smoke

| Area | Check | Expect |
|---|---|---|
| Logged-out browsing | Open `/`, a fact page, a public meme permalink | All load normally, no login wall |
| Commenting | Post a comment as a registered user | Captcha behaves as before |
| Comment captcha bypass | Post a comment as admin/Legendary | No captcha |
| Fact submission | Submit a fact as a registered user | Rate limit and captcha as before |
| AI backgrounds | Open the AI background picker as admin/Legendary | Generate works |
| Ad slots | Browse as a registered user, then as Legendary | Ads for registered, none for Legendary |
| Admin console | Every admin screen | Loads normally |
| Admin notifications | Profile → notification preferences as admin | Visible and editable |
| PuLID memes | Create a stylized photo meme as admin/Legendary | Works |
| Profile edit | Change display name, pronouns, avatar style | Saves |

## Known limitations — not bugs

- **Grid changes take up to ~1 minute to appear.** That's the resolver cache,
  and the Features screen says so. The process you're talking to updates
  immediately; others catch up within the window.
- **Numeric limits are untouched.** Spend budgets, upload caps, save caps, and
  rate limits are all still where they were — they're the next plan. The
  Features screen shows boolean features only.
- **Engine access is untouched.** `engine_experiments` still has no rows and
  engines are still admin-only via a hardcoded check. That's Plan 3.
- **Visibility is still chosen at creation only.** Unchanged from #402 — there
  is still no way to flip a meme's visibility afterwards.
- **The grid's write protection isn't here yet.** Right now the rules hold
  because our code is the only thing that writes the grid. Making that
  unbypassable at the database level is PR #422, which ships after this one.

## If something's wrong

```
Step:            (e.g. "3 — Resume Admin")
Account:         (admin / registered / legendary; logged out?)
What I did:
What I expected:
What happened:
Screenshot/URL:
```

The two failures worth reporting immediately, because they'd mean something
core didn't land: **step 1 unchecking the Admin cell changing nothing**, and
**step 3 leaving you unable to get back into admin**.

---

**Engineering checklist sibling:**
[`PR425_ADMIN_PERMISSIONS_CORE_TEST_RUN.md`](../Replit/PR425_ADMIN_PERMISSIONS_CORE_TEST_RUN.md)
— Replit runs that first, against the live database, before you start here.
