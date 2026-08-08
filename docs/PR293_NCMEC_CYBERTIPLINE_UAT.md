# PR #293 — NCMEC CyberTipline reporting, phases 1-2 of 8 — UAT

Your in-app acceptance test, David.

**Why this exists.** Availeron Consulting is a registered CyberTipline ESP,
but `submitNcmecReport()` today is a stub — it writes a database row and
emails admins, and has never actually contacted NCMEC. This PR is the first
2 of 8 planned phases toward making that real: the database schema for
tracking a submission's full lifecycle, and a standalone ISPWS HTTP client +
XML builders that know how to talk to NCMEC's servers — but nothing wired
up to call them yet.

**There is almost no visible surface in this phase, and that's
deliberate.** No new admin page, no button that files anything, no report
ever leaves this app as a result of this PR. The one thing you *can* see
and test is a safety rail: the app now refuses to let the generic admin
config editor touch the settings that would eventually control real NCMEC
filing, even though those settings already exist in the database.

## Before you start

- Nothing to enable — there's no feature flag. Everything below is already
  live.
- You'll need admin access to `/admin/config`.

## The main event

### 1. The new NCMEC settings are visible on the existing config page

- Go to `/admin/config`.
- Look for keys starting with `ncmec_` or `async_job_ncmec_submit_` — there
  should be 8 of them, rendered as generic cards the same way every other
  unclassified config key is (this page doesn't have custom UI per key,
  just a name, a value, and a save button).
- ✅ All 8 are visible. Three are freely editable like any other setting:
  `NCMEC Safety Alert Email`, `NCMEC Submit — Max Attempts`, and
  `NCMEC Submit — 4th Retry Delay (ms)`.

### 2. The five filing-capable settings refuse to save

- Find **`NCMEC Submission Enabled`** (or any of: `NCMEC ISPWS
  Environment`, `NCMEC Report Classifier Hits`, `NCMEC Backlog Audit
  Cutoff`, `NCMEC Backlog Audit Completed At`).
- Try to change its value and save.
- ✅ The save fails and the card shows an inline red error message: *"This
  key controls NCMEC CyberTipline filing and cannot be written through the
  generic config route. Use the safety admin surface, which validates the
  resulting configuration before applying it."*
- ✅ The value shown on the card does not change — your edit did not take
  effect.

This is the actual point of this phase: right now there is no "safety
admin surface" yet (that's a later phase), so these five settings are
**unwritable by anything** — not just protected from the generic editor,
genuinely unreachable. That's intentional. It means nobody — including an
admin using this exact page — can accidentally flip on real NCMEC filing
before the surface built to do that safely actually exists.

### 3. Everything else about the config page still works normally

- Edit and save a few unrelated, pre-existing config keys you'd normally
  touch.
- ✅ Works exactly as before — this PR only added a refusal for the five
  NCMEC keys named above, nothing else on the page changed.

## Regression smoke

| Check | Expected |
|---|---|
| `/admin/config` loads | Loads normally, all existing keys still present |
| Edit a normal (non-NCMEC) config key | Saves normally |
| Edit `NCMEC Safety Alert Email` | Saves normally (not a reserved key) |
| Edit `NCMEC Submission Enabled` | Fails with the inline red refusal message, value unchanged |
| Sign in, browse facts, make a meme | All unaffected — this PR touches only the admin config route and a new, uncalled backend client |

## Known non-bugs

- **You cannot make this file a real report, no matter what you click.**
  There is no button or flow anywhere in the product that calls the new
  ISPWS client yet — it has no caller at all in this phase. Even if the
  master switch could somehow be turned on, nothing would act on it.
- **There's no dedicated NCMEC/safety admin page.** The 8 settings live on
  the existing generic `/admin/config` list because that's genuinely all
  that exists right now — a purpose-built `/admin/safety` page (where
  you'll eventually see reports, retries, and failures) is scoped for a
  later phase.
- **The three unreserved settings will save any reasonable-looking value**
  — an email-shaped string, a number in range — with no deeper checking
  (e.g. it won't yet stop you from setting the retry count to something
  that doesn't make sense in combination with the retry delay). Those
  cross-checks are tied to the same later phase as the safety admin
  surface, because they only matter once real filing can happen.

## If something's wrong

Please report it as:

```
Step number:
What I was doing:
What I expected:
What actually happened:
Device / browser:
```

The one to flag loudest: if any of the five reserved settings (step 2)
*does* save successfully, or if you find any way to make a real request
leave this app toward NCMEC's servers — either would mean this phase's
core safety property broke.
