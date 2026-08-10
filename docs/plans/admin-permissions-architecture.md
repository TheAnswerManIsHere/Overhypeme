# Plan: One source of truth for feature permissions

> Status: **DRAFT — under Codex plan review.** Not approved. Approval is
> David's, explicitly, in words.

## Problem

Overhype.me answers "is this account allowed to do this?" in two different
vocabularies, and every gate in the codebase picks one ad hoc.

1. **The tier vocabulary** — `unregistered | registered | legendary`. This is
   what the Feature Permission Grid (`tier_feature_permissions`) is keyed on,
   and what `hasFeature(tier, key)` looks up.
2. **The role vocabulary** — the same three plus `admin`, derived by
   `deriveUserRole(membershipTier, isAdmin)`.

`users.is_admin` is an orthogonal boolean, so an admin's *stored tier* is
`registered` unless they separately hold a paid entitlement. The grid has
`admin` rows for every feature (seeded by migrations `0028`/`0029`) and the
admin console renders an Admin column — but **no code path ever passes
`'admin'` to `hasFeature`**, so those rows are unreachable by construction.
The Admin column is decorative configuration.

Because the grid cannot express admin, every gate where an admin *should*
qualify has a hand-written exception in application code. The five current
`hasFeature` call sites handle admins **four different ways**:

| Feature key | Call site | How admin is handled today |
|---|---|---|
| `video_generation` | `videos.ts:415`, `videoJobs.ts:96` | Admin resolved first, `hasFeature` skipped entirely |
| `comment_captcha_bypass` | `facts.ts:472` | `isLegendaryOrAdmin \|\| hasFeature(...)` |
| `meme_private_visibility` | `createMemeRecord.ts:175` | `isAtLeastLegendary(role) \|\| hasFeature(...)` (added by PR #402) |
| `meme_rate_limit_high` | `createMemeRecord.ts:176` | Grid only — **admins silently denied** |
| `meme_ai_background` | `render.ts:124` | Grid only — **admins silently denied** |

The last two were never deliberately decided; they are an accident of the
admin's stored tier being `registered`. Both fail closed, so neither is a
leak — but neither is intentional either.

**The concrete symptom that commissioned this work:** PR #402. The meme
builder mapped `admin → legendary` client-side and offered a Private pill;
`createMemeRecord` resolved the same entitlement from the tier column, found
`registered`, and coerced the meme public. Both surfaces believed they agreed
with the other. A user's privacy choice was silently discarded and the meme
was world-readable at its permalink.

That was one instance of a class. The class is: **two vocabularies, no
chokepoint, and a configuration surface that lies about being the source of
truth.**

## Product Intent

David's words, from the pre-plan conversation:

> I want to do a comprehensive sweep of the code and make sure that any and
> all permissions around what features are enabled are tied exclusively to the
> configuration that we setup in the Feature Permission Grid with no admin
> overrides or callouts. I want all functions that check permissions to
> exclusively use this matrix so there is only ever one place to check and one
> source of truth for what different accounts can do in the system. The only
> exception to that may be something like a bootstrap issue or self-reference
> issue where the admin can't turn off admin privileges or something like
> that.

Restated as the outcome this plan must produce:

1. **Every product-feature permission resolves through one function**, which
   consults the Feature Permission Grid and nothing else. No `unless admin`
   exceptions anywhere in application code.
2. **The Admin column in the grid becomes live** — it is read at runtime, and
   toggling it changes what admins can do, with no deploy.
3. **The grid is complete.** Anything tier-specific that is currently
   hardcoded in code becomes a grid row, so the grid is a true and total
   picture of who-gets-what. Grid contents are aligned with David's product
   intent, feature by feature (see *Grid Intent Review*).
4. **Operational privileges stay out of the grid** — admin console access,
   user management, moderation, config editing remain role-gated. This is the
   bootstrap carve-out David anticipated, and it is what makes lockout
   impossible by construction.
5. **The client stops deriving permissions.** It is told what the user may do.

## Must Not Change

- **Backend authorization must never be affected by the admin "view as user"
  toggle for operational privileges.** `requireRole`/`requireAdmin` continue to
  gate on `realUserRole`. (Feature gates deliberately *do* honour the toggle —
  see Settled Decisions #4 — but console/admin-route access does not.)
- **`req.user` stays rebuilt from the database on every authenticated
  request.** Role, admin, and membership are never trusted from the session
  blob. (security-model.md invariant #3.)
- **`users.membership_tier` stays derived, never assigned.** This plan does not
  touch the entitlement model — no new writer of that column, and the
  effective-tier expression (`effectiveTierExpr()`) remains the read path.
- **Gates continue to fail closed.** A missing grid row, a DB error, or an
  unknown feature key denies. No permission check may fail open.
- **The three admin-flag grant paths stay as they are**: the stored
  `users.is_admin` boolean, the `ADMIN_USER_IDS` env allowlist, and the
  `BOOTSTRAP_ADMIN_EMAIL` hardcoded bootstrap. The bootstrap email in
  particular is the break-glass guarantee and is not being removed.
- **Ownership checks are not permissions in this sense and do not move into
  the grid.** "May I edit *my own* meme" is a resource-ownership question, not
  an entitlement one.
- **No rollout-flag gating.** Per the working rules, this ships as the new
  behavior, not behind a toggle.
- **Impersonation is out of scope.** See Settled Decisions #5.

## Settled Decisions

Decided with David in the pre-plan conversation on 2026-08-10.

1. **Everything tier-specific moves into the grid.** Capabilities currently
   hardcoded to a role rank (e.g. PuLID-stylised memes, any route-level
   `requireLegendary` product feature) get grid rows. The grid must be a
   complete picture, not a partial one. Where a capability is not currently
   represented, the proposed row and its per-tier defaults are brought to
   David for intent confirmation rather than chosen silently.

2. **Admin resolution is a UNION, never an override.** A user's feature set is
   `features(their tier) ∪ (isAdmin ? features('admin') : ∅)`. An admin who
   also holds a paid Legendary entitlement therefore never *loses* a feature by
   being an admin. Rejected alternative: letting the admin row-set replace the
   tier row-set, which would allow toggling the Admin column to take away
   something a person paid for. The union also mirrors how the entitlement
   model already resolves multiple membership sources.

3. **Operational privileges are NOT grid features.** Admin console access,
   user management, moderation actions, config editing, and the grid editor
   itself stay on `requireRole('admin')`. Consequence worth stating plainly:
   **the grid cannot cause an admin lockout, because nothing that grants
   access to the admin console lives in it.** This is the structural reason
   David's "bootstrap exception" is a clean carve-out rather than a
   compromise.

4. **"View as user" (Mode 1) becomes honest, and applies to feature gates
   only.** Today `session.adminModeDisabled` changes what the UI shows while
   the backend ignores it. After this change, the feature resolver keys on the
   toggle-aware role, so "view as user" genuinely drops the admin feature
   union end-to-end. Operational privileges continue to ignore the toggle, so
   an admin can never lock themselves out of the console mid-preview.

5. **Impersonation ("view as *this specific* user", Mode 2) is deferred to its
   own plan.** It is a wanted capability, but it is a session/auth feature
   with its own write-policy, audit, and privacy decisions (whose budget is
   spent, which actions are blocked, who-impersonated-whom logging). Bolting it
   onto an authorization overhaul multiplies the blast radius of the highest-
   stakes change class in the codebase. This plan is designed so impersonation
   is later a contained feature rather than a rewrite: the resolver takes an
   *effective user*, so impersonation becomes "set the effective user" plus its
   own policy and audit work.

6. **Admin-only creation knobs are admin TOOLS, not grid features.** Model
   overrides, video duration/resolution/aspect overrides, and engine selection
   are operator dials, not product entitlements. They stay role-gated and out
   of the grid.

7. **The wrong call must become impossible, not merely discouraged.** A
   tier-keyed `hasFeature(tier, key)` reachable from route code is how this bug
   class reproduces. The tier-keyed lookup is confined to the resolver module,
   and a CI guard fails the build if application code calls it directly —
   following the repo's established "recurring failure patterns become CI
   guards" practice (`check-docs-accuracy`, `check-codegen-drift`,
   the migration-snapshot validator).

## Repo Context Inspected

*(To be completed — inventory sweeps in progress.)*

Docs read: `docs/ai-context/membership-entitlements.md`,
`accounts-and-auth.md`, `known-failure-patterns.md` (the entitlement-gate
entry), `admin-console.md`, `security-model.md`,
`docs/engineering/code-review.md`, `.agents/PLANS.md`.

Code read so far: `artifacts/api-server/src/lib/tierFeatures.ts`,
`lib/userRole.ts`, `middlewares/tierMiddleware.ts`,
`middlewares/authMiddleware.ts`, `lib/createMemeRecord.ts`,
`routes/admin.ts` (user PATCH), `routes/auth.ts` (admin-mode toggle),
`lib/db/src/schema/featureFlags.ts`, migrations `0013`/`0028`/`0029`,
`artifacts/overhype-me/src/pages/admin/features.tsx`.

## Current Behavior

### The grid's actual contents

Seven features exist. Ground truth verified against the database, then
cross-checked against migrations `0013`/`0028`/`0029`/`0057` and `seed.ts`.

| Feature key | unregistered | registered | legendary | admin | Read by code? |
|---|---|---|---|---|---|
| `comment_captcha_bypass` | false | false | true | true | yes (`facts.ts:472`) |
| `meme_ai_background` | false | false | true | true | yes (`render.ts:124`) |
| `meme_private_visibility` | false | false | true | true | yes (`createMemeRecord.ts:175`) |
| `meme_rate_limit_high` | false | false | true | true | yes (`createMemeRecord.ts:176`) |
| `meme_upload_photo` | false | **true** | true | true | **no — fully orphaned** |
| `video_generation` | false | false | true | true | yes (`videos.ts:415`, `videoJobs.ts:96`) |
| `engine_experiments` | **no row** | **no row** | **no row** | **no row** | **no — read via a parallel hardcoded path** |

Five defects in the grid data itself, all found by this sweep:

1. **`engine_experiments` has no permission rows at all.** Migration `0057`
   inserted the feature definition but no tier rows, and it landed *after*
   `0029`'s backfill, so nothing ever filled them. The admin UI renders four
   unchecked boxes that create rows when toggled — but nothing reads them.
2. **`video_generation`'s tier rows are force-overwritten on every server
   boot.** `seed.ts:537-545` upserts them with
   `ON CONFLICT … DO UPDATE SET enabled = EXCLUDED.enabled`, unlike every
   other seeded row, which uses `DO NOTHING`. Any admin toggle of this
   feature silently reverts on the next restart — while the admin UI states
   "Changes take effect immediately without redeployment."
3. **`meme_upload_photo` is dead configuration.** No code anywhere reads it.
   Photo upload is actually governed by `uploadRateLimit.ts` plus
   authentication. Migration `0028` exists specifically to correct this row's
   value, for a row nothing consults.
4. **`engine_experiments` is read through a parallel mechanism**, not the
   grid: `engines.feature_flag_required` is resolved against a predicate
   `videos.ts:820-822` hardcodes to `isAdmin ? () => true : () => false`. So
   the grid row is decorative twice over.
5. **`meme_rate_limit_high`'s description is factually wrong.** It reads
   "100/hour instead of 10/hour"; the implementation is a rolling-24h save cap
   of 200 vs 30 (`createMemeRecord.ts:221-228`). Verified directly.

### Where an admin actually lands today

Admin exemption is implemented **13+ separate times, three different ways** —
an explicit `admin` key in one policy map, an `isAdmin` short-circuit in eight
places, and the `isAtLeastLegendary(role)` ladder in the rest — while the
grid's own admin column is unreachable.

| Subsystem | Admin gets | Deliberate? |
|---|---|---|
| Resource governance (spend/req/concurrency/duration/payload) | Its own generous `admin` policy row | **Deliberate** — the one place `admin` is a first-class key, and the model this plan generalises |
| Generation budget (`budgetGate`) | Unlimited (`Infinity`) | Deliberate, explicit branch |
| Daily upload cap | Unlimited | Deliberate, documented |
| Video jobs/day | Exempt | Deliberate |
| Fact-submit rate limit | Exempt | Deliberate |
| Comment CAPTCHA | Bypassed | Deliberate |
| Private memes / PuLID | Allowed | Deliberate (PR #402) |
| Video generation | Allowed | Deliberate short-circuit |
| Engine visibility | All engines | Deliberate placeholder |
| **Daily meme-save cap** | **30/day — the free-tier cap** | **Accidental** — keyed off the tier, in the same function that deliberately fixed two sibling gates to use the role |
| **Fact-submit pending cap (10 unresolved)** | **Capped like everyone else** | **Accidental** — its sibling rate limiter two functions away exempts admins |
| **`meme_ai_background`** | **Denied** | **Accidental** — tier-keyed, no role fallback |

The two accidental denials are exactly the two gates that reached for
`membership_tier` instead of the role. That is the same defect as PR #402,
still live in two more places.

### Other structural findings

- **`effectiveTierExpr()` emits only `unregistered|registered|legendary`,
  never `admin`.** This is the structural reason the grid's admin column is
  dead: the only value that can reach `getTierFeatures()` is a membership
  tier, by construction.
- **`engines.tierRequirement` is stored on all 20 engines as `"legendary"`
  and never enforced at runtime** — nothing outside the admin editor UI reads
  it. Dead metadata that looks like a permission.
- **The two meme save-cap config keys are unreachable.** They use a
  dot-namespaced convention (`memes.free_tier_daily_save_cap`) no other key
  uses, and neither is seeded by any migration or `seed.ts` — so they never
  appear in the admin config UI and can only ever return code defaults.
- **The client derives permissions 13 times.** `role === "legendary" || role
  === "admin"` is duplicated verbatim across 12 components, plus a 13th
  variant in `studioAdapter.ts` that *maps* admin→legendary — the mapping
  implicated in PR #402. There is no shared client helper, and no
  client-facing feature endpoint exists outside `/api/admin/feature-flags`.

## Source-of-Truth Analysis

| Concept | Source of truth today | Source of truth after |
|---|---|---|
| What features a tier gets | `tier_feature_permissions` (partial — code carries the admin half) | `tier_feature_permissions`, whole |
| What features an admin gets | Scattered application-code exceptions | `tier_feature_permissions` `admin` rows, unioned |
| Whether someone may operate the system | `requireRole('admin')` on `realUserRole` | unchanged |
| A user's membership tier | `effectiveTierExpr()` over entitlement sources | unchanged |
| Whether someone owns a resource | Per-route ownership checks | unchanged |
| What the client believes is permitted | Client-side derivation from role | Server-sent resolved feature set |

**No new source of truth is created.** The grid already exists and already
holds admin rows; this plan makes the existing rows reachable and removes the
shadow copy in application code. The one genuinely *new* artifact is the
server→client feature list, which is a projection of the grid, not an
independent store.

## Proposed Design

*(Detail to be completed; the shape is settled.)*

**One resolver.** A single module resolves an authenticated (or anonymous)
caller into a set of permitted feature keys, by union per Settled Decision #2,
keyed on the toggle-aware role per #4. Every product-feature gate in the
codebase calls it and nothing else. The tier-keyed primitive it wraps is not
exported to application code, and CI enforces that.

**Two rails, kept apart.** Product entitlements resolve through the grid;
operational privileges resolve through `requireRole` on `realUserRole`. The
plan states, for every gate found in the sweep, which rail it belongs on.

**One client contract.** The server sends the resolved feature set on the auth
payload; the client renders from it instead of deriving. This is what
structurally closes the #402 class — the builder's `roleToTier` mapping and
every sibling client-side derivation is deleted rather than corrected.

**Lockout guards.** Self-demotion and last-admin-removal guards on the admin
user routes, which the codebase does not have today.

## Grid Intent Review

*(To be completed — this section carries the full proposed matrix, feature by
feature, with current vs. proposed value per tier, for David's confirmation.
Every cell that changes meaning is called out. This is the section David
reviews for product intent; it is not a mechanical migration.)*

## Data Model and Migration Impact

*(To be completed.)*

## Runtime Behavior

*(To be completed.)*

## Admin/User UX Impact

*(To be completed.)*

## Security, Permissions, and Validation

*(To be completed.)*

## Testing Plan

*(To be completed.)*

## Implementation Steps

*(To be completed.)*

## Risks and Mitigations

*(To be completed.)*

## Questions for David

*(To be completed — carried into the plan-review loop and surfaced as numbered
questions.)*

## Definition of Done

*(To be completed.)*
