# Plan — your own photo is your picture; the avatar system is removed

```plan-oracle
# Oracle — photo is your picture; the avatar system is removed (Issue #849)

Agreed scope, David on Issue #628:
- Q1 (2026-11-21): "a member's own photo is their avatar, for everyone."
- Q11 (2026-11-23), approving the proposed scope (onboarding photo becomes the account picture for free members too; the Profile banner asking for a photo they already gave goes away, fixing #848; inventory rows F21/B19 rewritten) and adding: "You should also deprecate the whole avatar system." In this repo deprecated means removed (decisions.md 2026-11-17).

Product intent: wherever the product shows a member's picture, it is the photo they uploaded, for every member; with no photo, a plain placeholder; the generated-avatar system (styles, picker, Avatar/Photo switch, custom_avatar flag, Legendary photo-avatar perk) is removed.

Must not change: photo upload, storage, adult gate and profile-photo marking; the profile photo as meme identity source; the Legendary ring/crown; which surfaces show a picture; every other Legendary benefit and flag.
```

Issue #849 (and #848's remaining gap). Workstream #628, backlog wave 1.

## Problem

Onboarding asks every member for "a real photo of you", stores it as their profile photo, and then never shows it: only Legendary members who switch a toggle to "Photo" are pictured by it (`custom_avatar` feature flag). Everyone else is shown a generated robot icon (a DiceBear image URL built from their user id), and Profile offers six robot styles plus a Legendary upsell to use your own photo. David, 2026-11-03: *"I'm not sure that not using your image is a good idea."* 2026-11-21 (Q1): a member's own photo is their picture, for everyone. 2026-11-23 (Q11): *"You should also deprecate the whole avatar system."* In this repo "deprecated means removed" (`decisions.md`, 2026-11-17).

## Direction

`product-strategy.md` (made about a friend; the member's own likeness is the product's raw material) and the launch definition's Legendary feature set (F21), which this changes: the photo picture stops being a Legendary benefit.

## Product Intent

After this increment:
1. Wherever the product shows a member's picture (header, Profile, fact comments, admin user list), it shows **the photo they uploaded** (the one marked as their profile photo), for every member, free or Legendary.
2. A member with no uploaded photo is shown **their initial in a plain circle** (the existing `UserAvatar` fallback), never a generated icon.
3. **The avatar system is gone**: no generated robot icons, no avatar-style picker, no Avatar/Photo switch, no `custom_avatar` feature flag, no "your own photo as your avatar" Legendary perk in pricing or upgrade copy, and the `avatar_style` / `avatar_source` columns are dropped.
4. Profile keeps one picture control: upload or choose the photo that is your picture. The "add a real photo of you" prompt still shows to a member with no uploaded photo, and its copy says the photo becomes their picture.

## Must Not Change

- How a photo is uploaded, stored, checked (adults only, size and type limits) and marked as the profile photo (`POST /storage/upload-avatar`, `POST /users/me/profile-image`, `upload_image_metadata.is_profile`).
- The profile photo's use as the meme identity source (render, composite, provenance).
- The Legendary ring and crown drawn around a Legendary member's picture.
- Who can see a member's picture: the surfaces that show it today, and no new ones.
- Every other Legendary benefit and every other feature flag.
- The surface boundary: fact-detail comments show pictures; the compact comment feed and its composer show initials; `submittedByImage` stays unrendered.

## Settled Decisions

- Q1 (2026-11-21): own photo for everyone. Q11 (2026-11-23): remove the avatar system entirely.
- "Deprecated means removed" (`decisions.md`, 2026-11-17): code, flag rows and columns go, with a recovery tag and a retired-ledger row, not hidden behind a toggle.
- The upload route keeps its name (`/storage/upload-avatar`) and the upload kind its `"avatar"` label: renaming them touches the read-only gate, the adults-only gate and their tests for no user-visible gain. Recorded as a known leftover name.

## Repo Context Inspected

Survey of 2026-11-23 (subagent, file:line evidence, spot-checked): `lib/db/src/schema/auth.ts:18,46-47`; `upload_image_metadata.is_profile` (`schema/memes.ts:124-129`, migration 0055); `custom_avatar` rows (migration 0099:111-140); `lib/effectiveAvatar.ts`; `routes/facts.ts:47-80,425-459,499-534`; `routes/users.ts:111-213,260-429,513-597`; `routes/storage.ts:24-50`; `routes/auth.ts:232-255`; `routes/admin.ts:148`; `lib/featureAccess.ts:81`; `openapi.yaml` (`UserProfile`, `UpdateProfileRequest`); frontend `UserAvatar.tsx`, `Navbar.tsx:16-62`, `Profile.tsx` (picker, pills, banner, identity card), `lib/profile-photo.ts`, `FactComments.tsx:233-276`, `admin/users.tsx:827-925`, `Onboard.tsx:304-336`, `UnifiedUpgradeModal.tsx:56`, `Pricing.tsx`; tests listed under Testing Plan; docs `launch-feature-inventory.md` B15/B18/B19/F21, `launch-definition.md`, `product-brief.md`, `product-direction.md`, `product-strategy.md`, `glossary.md`, `accounts-and-auth.md`, manual chapters 9 and 10.

## Current Behavior

- The picture everyone else sees is chosen by `effectiveAvatarUrl`: the photo only when `avatar_source = 'photo'`, a photo is stored and the member holds `custom_avatar` (Legendary/admin); otherwise a DiceBear URL. The header and Profile repeat that rule in the browser.
- Onboarding's photo is stored and marked as the profile photo, but `avatar_source` flips to `photo` only for Legendary, so a free member keeps the robot (#848).
- Sign-in with Google or Apple copies the provider's picture into `profile_image_url` when it is empty; it is shown only on the admin user list.
- `submittedByImage` on facts is served but rendered nowhere.

## Source-of-Truth Analysis

One source after the change: **the uploaded profile photo** (`users.profile_image_url` holding a first-party `/api/storage/objects/` path, in step with `upload_image_metadata.is_profile`). Today four writers and readers break that (Astra, round 1, C1): Google/Apple sign-in copies the provider picture into the account on insert and whenever it is empty, so a cleanup is undone at the next sign-in (`auth.ts:232`); `PATCH /users/me` accepts Unsplash and Pixabay URLs and sets the picture without moving the Profile marker, so the shown photo, the Profile-marked photo and the deletion-protected photo can disagree (`users.ts:52,340`, `myContent.ts:132`); the admin list returns the raw value (`admin.ts:148`). After the change:
- **`POST /users/me/profile-image` is the only way to set the picture** (ownership check, public ACL, transactional Profile marker, all existing). `profileImageUrl` leaves `PATCH /users/me` and its request contract; every app flow (Profile upload, the uploads picker, onboarding) already uses the POST.
- **Sign-in copies the provider picture in as a real upload** (Q13, David 2026-11-23: *"why can't we copy them into local storage and use them as the default image until the user uploads a new or different one?"*). When a member signing in with Google has no profile photo, the server fetches the picture at a larger size, puts it through the same checks an upload gets (type, size, the NSFW classifier, adults-only), stores it as a first-party object, records it in `upload_image_metadata` and marks it as the profile photo. It is then an ordinary uploaded photo: it shows in My Images, can be replaced, and is the default meme star until the member picks another. The raw provider URL is never stored or served. Apple's sign-in sends no picture, so Apple members start with their initial. A fetch or check that fails leaves the member photo-less, and sign-in still succeeds.
- **One resolver, `profilePictureUrl(user)`** (first-party photo URL or null), serves `GET /users/me`, the admin users list and the three fact/comment projections. The browser renders what it is given, with no second rule.
A provider picture becomes a source only by being copied in as an upload (Q13).

## Proposed Design

- **Server:** replace `effectiveAvatarUrl` with `profilePictureUrl(user)`: the first-party photo URL or null. Used by the three `facts.ts` projections. `GET /users/me` returns `profileImageUrl` as today (first-party only, Q13) and drops `avatarStyle`/`avatarSource`; `PATCH /users/me` drops both fields; `POST /users/me/profile-image` drops the `mayFlipToPhoto` branch. `custom_avatar` leaves `featureAccess.ts`.
- **Contract:** `openapi.yaml` drops `avatarStyle`/`avatarSource` from `UserProfile` and `UpdateProfileRequest`; regenerate clients.
- **Browser:** every picture goes through `UserAvatar` (photo, else initial). Remove the DiceBear helpers, the style picker, the Avatar/Photo pills, `toggleAvatarSource`, the `can("custom_avatar")` checks and the `/pricing` redirect on photo pick. Rewrite the banner and identity-card copy ("becomes your picture"). Comments use `UserAvatar` instead of a person icon. Pricing and the upgrade modal drop the photo perk.
- **Selection:** remove the `PATCH /users/me` picture setter; replace the OAuth URL copy with the copy-in above; `admin.ts` users projection uses the resolver.
- **Data:** migration drops `users.avatar_style`, `users.avatar_source` and the `custom_avatar` feature-flag and tier rows (capturing the flag rows the way earlier retirements did); Q13 decides provider pictures.
- **Retirement:** `pre-cut/avatar-system` tag, ledger row in `docs/retired/README.md`, `decisions.md` entry superseding F21's photo-avatar perk.

## Data Model and Migration Impact

One migration (next free number), idempotent: `DROP COLUMN IF EXISTS avatar_style, avatar_source`; delete `custom_avatar` from `tier_feature_permissions` and `feature_flags` after copying the flag row to the retired-rows table (`schema/featureFlags.ts:104` pattern); clear `profile_image_url` where it is not a first-party path (a provider URL stored before this change; the member gets the copy-in at their next Google sign-in). Notice reports counts: columns dropped (or already absent), flag rows captured/deleted (or already gone), provider pictures cleared, failed 0. Destructive: the `pre-cut/avatar-system` tag restores code but not the dropped columns, so recovery is the tag plus a forward migration re-adding `avatar_style`/`avatar_source` with their defaults and restoring the captured `custom_avatar` flag and tier rows (both row sets captured, following the existing retirement pattern). Individual style choices are not worth restoring (each was a generated icon from the user id). Legacy fixture (`users.ndjson`, allowlist, seed) updated.

| Row | Before | After |
|---|---|---|
| Member with an uploaded photo, any tier | robot unless Legendary + "Photo" | their photo |
| Member with no photo | robot | initial |
| Member with only a provider picture | robot (provider picture on admin list) | initial until next Google sign-in, then that picture as an upload |
| `custom_avatar` flag/tier rows | present | captured, then deleted |

## Runtime Behavior

A member who uploads or picks a photo is pictured by it at once on the header, Profile and their comments. Deleting a photo is unchanged (the current profile photo cannot be deleted, `accounts-and-auth.md:446`). No new endpoint; no paid call.

## Admin/User UX Impact

Profile: one "Your picture" section (upload / choose from your uploads), no styles, no toggle, no lock. Banner for no photo: "Add a real photo of you — it becomes your picture and stars in your memes." Pricing and the upgrade modal lose the photo-avatar line. Admin user list shows the same rule (photo or initial). Admin Features page loses the "Custom Avatar Photo" row.

## Security, Permissions, and Validation

Unchanged upload gates (adults only, size/type, ownership check in `POST /users/me/profile-image`). External image URLs can no longer be set as a picture (the `PATCH` setter and its Unsplash/Pixabay allowance go). Removing `custom_avatar` removes a 403 path, not a permission anyone else relied on. The picture shown publicly is only a first-party object the member uploaded (Q13), so no third-party image URL is served to other visitors.

## Testing Plan

- API: replace `effectiveAvatar.integration.test.ts` with a `profilePictureUrl` test (photo → URL for a free member and a Legendary one; no photo → null; provider picture → null under Q13 1). Update `routes.users.test.ts` (style/source validation removed; profile-image no longer flips anything), `routes.facts.test.ts` (projection), `featureAccess.integration.test.ts` (flag gone).
- Migration: run twice, counts in the notice; legacy fixture integration passes.
- Frontend: `profile-photo.test.ts`; a Profile test that no style picker or Avatar/Photo switch renders; Navbar shows photo or initial.
- Copy-in (Q13): a Google sign-in with no profile photo stores the picture as a first-party upload marked as profile photo (the provider fetch is a test double); a member who already has a photo keeps it; a failed fetch or a refused check leaves no photo and sign-in still succeeds; an Apple sign-in stores nothing.
- Picture boundary (C1): `PATCH /users/me` with a `profileImageUrl` is refused or ignored and cannot replace the selected upload; choosing another upload keeps the shown URL, the Profile marker and the deletion protection on the same photo.
- e2e: `photoUpload.spec.ts` asserts a free member's chosen photo is **displayed and loads** in the header and on Profile (not only the API JSON), keeping the no-repeat-banner check; it runs under `e2e:storage`, not the required E2E Smoke, so its run is recorded as a scripted UAT step. `adminPermissions.spec.ts` drops the `custom_avatar` cases.
- UAT (human): the Profile picture section and the no-photo banner read right on a phone.

## Implementation Steps

1. Migration + schema + fixture; server rule and routes; contract and codegen.
2. Browser: header, Profile, comments, admin list, pricing/upgrade copy.
3. Tests and e2e; docs (inventory B15/B18/B19/F21, launch definition, product docs, glossary, accounts-and-auth, manual 9 and 10 + regenerated help), `decisions.md`, retired ledger, recovery tag.
One PR.

## Risks and Mitigations

- A missed DiceBear reference shows a broken or robot image: a guard test greps the frontend and API source for `dicebear` and `avatarSource`.
- Clearing provider pictures loses a value someone might want: none is shown publicly today, and there is no real member data (Q10's premise).

## Questions for David

None open. Q13 answered 2026-11-23: copy the provider picture in as an upload (above).

## Definition of Done

- A free member who uploads a photo during onboarding sees it as their picture on the header and Profile, and other visitors see it beside their comments.
- No surface renders a generated icon; `dicebear`, `avatarStyle`, `avatarSource` and `custom_avatar` appear nowhere in source but the migration and the retired ledger.
- Pricing and the upgrade modal no longer offer the photo picture as a Legendary perk.
- Migration idempotent with counts; full API suite, frontend tests and e2e green.
