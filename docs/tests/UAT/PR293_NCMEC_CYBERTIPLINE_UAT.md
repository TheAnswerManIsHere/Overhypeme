# PR #293 — NCMEC CyberTipline reporting, phases 1-2 of 8 — UAT

Your in-app acceptance test, David.

**Why this exists.** Availeron Consulting is a registered CyberTipline
ESP, but `submitNcmecReport()` today is a stub — it writes a database row
and emails admins, and has never actually contacted NCMEC. This PR is the
first 2 of 8 planned phases toward making that real: the database schema
for tracking a submission's full lifecycle, and a standalone ISPWS HTTP
client + XML builders that know how to talk to NCMEC's servers — but
nothing wired up to call them yet.

**There is almost no visible surface in this phase, and that's
deliberate.** No new admin page, no button that files anything, no report
ever leaves this app as a result of this PR. The one thing you *can* see
and test is a safety rail: the app now refuses to let the generic admin
config editor touch the settings that would eventually control real NCMEC
filing, even though those settings already exist in the database. There's
no feature flag — everything below is already live.

## Setup

- [david] Sign in as an admin — you'll need access to `/admin/config`.

## Steps

### 1. The eight NCMEC settings are visible on the existing config page

**Do:** Go to `/admin/config` and look for the keys starting with
`ncmec_` or `async_job_ncmec_submit_`.

**Expect:** There are 8 of them, rendered as generic cards the same way
every other unclassified config key is (this page has no custom UI per
key — just a name, a value, and a save button). All 8 are visible, and
three are freely editable like any other setting: `NCMEC Safety Alert
Email`, `NCMEC Submit — Max Attempts`, and `NCMEC Submit — 4th Retry
Delay (ms)`.

### 2. A reserved setting refuses to save

**Do:** Find "NCMEC Submission Enabled" (or any of: "NCMEC ISPWS
Environment", "NCMEC Report Classifier Hits", "NCMEC Backlog Audit
Cutoff", "NCMEC Backlog Audit Completed At"), change its value, and save.

**Expect:** The save fails and the card shows an inline red error
message: *"This key controls NCMEC CyberTipline filing and cannot be
written through the generic config route. Use the safety admin surface,
which validates the resulting configuration before applying it."*

### 3. A refused save doesn't actually write

**Do:** Reload the page after the failed save in the previous step (the
card keeps showing whatever you typed until you do — a failed save
doesn't reset the field on its own).

**Expect:** The value is back to what it was before your edit — your
attempt did not take effect.

### 4. Unrelated config keys still work normally

**Do:** Edit and save a few unrelated, pre-existing config keys you'd
normally touch, noting each value first so you can set it back
afterward — these are real, persistent writes with no undo. Leave "NCMEC
Safety Alert Email" out of this sweep if it's currently empty (the save
route rejects blank values, so once you type something in you can't set
it back to empty from this page); if it already holds a real address,
it's fine to edit and set back like any other key.

**Expect:** Works exactly as before — this PR only added a refusal for
the five NCMEC keys named in step 2, nothing else on the page changed.

## Regression

### R1. `/admin/config` loads normally

**Do:** Load `/admin/config`.

**Expect:** Loads normally, all existing keys still present.

### R2. A normal config key still saves

**Do:** Edit a normal (non-NCMEC) config key.

**Expect:** Saves normally.

### R3. NCMEC Safety Alert Email is editable like any unreserved key

**Do:** Look at the "NCMEC Safety Alert Email" card.

**Expect:** It's editable like any other unreserved key, with a working
save button — but don't actually save to it if it's currently empty (see
step 4's note).

### R4. NCMEC Submission Enabled still refuses to save

**Do:** Edit "NCMEC Submission Enabled" and save.

**Expect:** Fails with the inline red refusal message; value unchanged
after a page reload.

### R5. Ordinary product use is unaffected

**Do:** Sign in, browse facts, and make a meme.

**Expect:** All unaffected — this PR touches only the admin config route
and a new, uncalled backend client.

## Not bugs

- **You cannot make this file a real report, no matter what you click.**
  There is no button or flow anywhere in the product that calls the new
  ISPWS client yet — it has no caller at all in this phase. Even if the
  master switch could somehow be turned on, nothing would act on it.
- **There's no dedicated NCMEC/safety admin page.** The 8 settings live
  on the existing generic `/admin/config` list because that's genuinely
  all that exists right now — a purpose-built `/admin/safety` page (where
  you'll eventually see reports, retries, and failures) is scoped for a
  later phase.
- **The three unreserved settings will save any reasonable-looking
  value** — an email-shaped string, a number in range — with no deeper
  checking (e.g. it won't yet stop you from setting the retry count to
  something that doesn't make sense in combination with the retry delay).
  Those cross-checks are tied to the same later phase as the safety admin
  surface, because they only matter once real filing can happen.
- **Not all five reserved settings matter equally today.** Only two —
  `NCMEC Submission Enabled` and `NCMEC ISPWS Environment` — are actually
  read anywhere when deciding whether to file a report. `NCMEC Report
  Classifier Hits` is reserved (still refused by this same guard) but not
  yet consulted by anything — it exists for a later phase to start
  reading. The two backlog-audit keys (`Cutoff`, `Completed At`) are
  similarly vestigial for the filing decision — a later, already-shipped
  phase dropped the backlog-audit check they were meant to gate, pending
  a cleanup migration that will eventually remove them. Don't read "these
  five will all move to the safety admin surface" as a settled future
  plan — the two backlog keys' future is "removed," not "relocated," and
  the classifier-hits key's own wiring is still ahead of it.
