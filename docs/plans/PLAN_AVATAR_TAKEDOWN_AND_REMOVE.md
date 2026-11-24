# Plan — a takedown is final, and "Remove my picture" (Issue #849, Q16 and Q17)

```plan-oracle
Agreed with David 2026-11-24 (scope approved in chat), reproduced:

Direction: Issue #849 — a member's own photo is their picture for everyone (Q1); the
avatar system is removed (Q11); Google's picture is the default until the member chooses another (Q13).

Product intent:
- Q16 = 1: a member whose profile photo an admin took down never gets an automatic picture
  again — the Google copy-in skips them. They can still upload and choose one; takedowns stay final.
- Q17 = 1: a "Remove my picture" control returns them to their initial; their photos stay in
  their library. David: "However, remind them that memes can't be generated without a picture
  and so if they want to generate one they'll need to upload it at generation time."
- Following Q13: a member who removed their picture never has Google's copied back later.
  Choosing a picture of their own still works.

Must not change: makeProfilePhoto is the one way a picture is chosen (owner content lock, then
account row FOR UPDATE); the Google copy keeps every existing check; takedowns stay final for the
owner; removing deletes no photo (the photo loses only the profile marker and its deletion
protection); members with a picture today see no change.

Settled: Q1, Q11, Q13, Q16 = 1, Q17 = 1; takeDownContent (PR #1173) clears the picture.
Now: the above + tests + accounts-and-auth.md. Never: Issue #875, Issue #628 waves.
Tier: production, sensitive (accounts and auth) + migration — full ceremony.
```

## Problem
The account remembers *that* it has no picture, never *why*. The Google copy runs on every Google
sign-in (`routes/auth.ts:446`) and fills any empty picture, so a picture an admin took down, or one
the member removed, is replaced at their next sign-in. There is also no way to remove a picture.

## Product Intent / Must Not Change / Settled Decisions
As the oracle above, verbatim.

## Repo Context Inspected
`profilePhoto.ts`, `providerPicture.ts`, `contentTakedown.ts`, `contentVisibility.ts`
(`lockOwnerContent`), `routes/users.ts` (PATCH and POST profile-image), `routes/auth.ts:446`,
`createMemeRecord.ts`, `MyImagePicker.tsx`, `Profile.tsx`, `Library.tsx`, migration 0163.

## Source-of-Truth Analysis
- The current picture: `users.profile_image_url` and the upload's `is_profile` marker, kept equal by
  the one setter. Unchanged.
- New, single fact: **whether an automatic picture may ever be set** — `users.no_auto_picture`. Only
  the Google copy reads it. It is set by removal and by a profile-photo takedown, and nothing clears it
  (a manual choice does not; the flag is about the *automatic* default only).

## Proposed Design
1. **Migration 0164** — add `users.no_auto_picture boolean NOT NULL DEFAULT false`; backfill `true`
   for every owner named in `admin_actions` rows with `action = 'content_takedown'`,
   `detail->>'kind' = 'photo'`, `detail->>'wasProfile' = 'true'`. Idempotent; RAISEs counts. Touches no
   picture. Forward-only and additive: recovery normally keeps `no_auto_picture` and its values;
   dropping it would be a deliberate retirement of the feature, since a removal choice cannot be
   reconstructed from the audit log.
2. **One lock order for every picture write** (owner content lock → account row FOR UPDATE → upload
   rows). Three paths, swept by grep of `profileImageUrl` writes: `makeProfilePhoto`, the new removal,
   and the photo takedown (which reads the row's owner first, takes the owner lock, then proceeds).
3. **`makeProfilePhoto`** — under the lock, re-checks the upload is live and the member's (refused
   otherwise, so a selection racing a takedown cannot reattach it); with `onlyIfNone`, also loses (the
   existing discard path) when `no_auto_picture` is set.
4. **Google copy** — returns a new outcome `declined` early when `no_auto_picture` is set (saves the
   fetch); the in-lock check in 3 is what makes it correct.
5. **Takedown** — when it clears the profile photo, also sets `no_auto_picture = true`, same transaction.
6. **Removal** — `DELETE /users/me/profile-image`: under the lock, clears the picture and the profile
   marker and sets `no_auto_picture`. Deletes no media, changes no ACL. Idempotent.
7. **Profile UI** — a "Remove my picture" control beside the picture when one is set, with a confirm
   step carrying the reminder (Q18 decides its wording) and the existing pending/error/maintenance
   conventions; after success, the profile and upload-list queries are refreshed. The upload picker
   shows when there is no current picture and at least one upload (today it needs two).

## Data Model and Migration Impact
One additive column with a default; one backfill from the audit log. Row-state matrix: owner with a
profile takedown → true; any other → false; re-run → no change.

## Security, Permissions, and Validation
Removal is the signed-in member's own row only, server-side. The takedown stays admin-only. No new
input but the request itself.

## Testing Plan
API (real test DB): removal clears picture and marker, keeps the photo listed and deletable, sets the
flag; Google copy declines after removal and after a profile takedown, on later sign-ins; a copy in
flight that loses to a removal is discarded; manual selection after removal and after takedown works;
selecting a taken-down photo is refused, including a selection racing the takedown; unaffected members'
pictures unchanged; manual reselection after removal leaves the flag set; migration backfill, and a
re-run that keeps an existing `true` with no takedown record; both races exercised through the real
mutation paths. Browser (Playwright): remove, initial shown on
Profile and the navbar, the single-photo picker returns and reselecting that photo works, the
reminder text shown.

## Questions for David
- **Q18 — the reminder's wording.** Astra checked, and I confirmed: after removing their picture a
  member can still make a meme from any saved photo — the meme builder picks their first library photo
  automatically. So "they'll need to upload it at generation time" isn't true unless we change meme
  making. Options: 1. keep meme making as it is and say *"Your picture becomes your initial. Your photos
  stay in your library. Memes still need a photo — pick a saved one or upload one when you make a
  meme."*; 2. use your sentence as written and change meme making so a member with no picture must
  upload fresh (new scope). Astra and I both recommend 1.
  **Answered: Q18: 1 (David, 2026-11-24).** Meme making is unchanged; the reminder uses the option-1 wording.

## Definition of Done
Everything in the Testing Plan green in CI; `accounts-and-auth.md` updated; UAT section in the PR.
