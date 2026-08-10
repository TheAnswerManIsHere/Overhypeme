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

7. **Numeric limits live in the grid too — the grid holds values, not just
   checkboxes (David, 2026-08-10).** I recommended leaving dollar budgets,
   upload caps and rate limits in `admin_config` with an admin bucket added,
   on blast-radius grounds. David decided against it, and his reason
   supersedes mine: *"a big issue I have is not remembering that a setting
   somewhere else affects behavior. It should be clear and obvious from one
   screen who is allowed to do what."* A permission you cannot see from the
   permissions screen is not actually governed by it. So the grid becomes the
   total picture, and the boundary is drawn as:

   > **The grid holds anything that determines what a given account may do.
   > `admin_config` keeps global system tuning that is identical for
   > everybody.**

   That rule is stated here because it is the thing that decides where the
   *next* setting goes, and getting that wrong is how the grid drifts back
   into being partial.

8. **"View as user" is faithful, including the numeric exemptions (David,
   2026-08-10).** Previewing as a registered user means hitting a registered
   user's spend cap and upload cap, not keeping operator headroom. A preview
   that silently retains privileges is how the PR #402 class survives
   testing. David noted an override toggle can be added later if the
   faithfulness gets in the way; it is not built now.

9. **Admins may view any content but may not act on content they do not
   own** (delete another user's meme, remove their link, cancel their job).
   Confirmed by David as intended, and therefore documented as a decision
   rather than left as an unwritten asymmetry a future reviewer would
   "fix".

10. **The wrong call must become impossible, not merely discouraged.** A
   tier-keyed `hasFeature(tier, key)` reachable from route code is how this bug
   class reproduces. The tier-keyed lookup is confined to the resolver module,
   and a CI guard fails the build if application code calls it directly —
   following the repo's established "recurring failure patterns become CI
   guards" practice (`check-docs-accuracy`, `check-codegen-drift`,
   the migration-snapshot validator).

## Repo Context Inspected

Three exhaustive sweeps were run over the codebase: backend authorization
gates, client-side gates, and the grid/config data. Their findings are the
*Current Behavior* section. Coverage: every route file under
`artifacts/api-server/src/routes/`, every middleware, every `lib/` helper that
makes an access decision, every client component that branches on role or
tier, the `feature_flags` / `tier_feature_permissions` tables queried
directly, and every migration touching them. Load-bearing or alarming claims
were re-verified by hand before being written down — the fail-open budget
gate, the ungated video parameters, the boot-time grid overwrite, the
unreachable render gate, and the admin-mode lockout were each confirmed
against the source rather than taken from a report.

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

### The backend: six grid calls, twelve contradictions

Only **six** feature-grid call sites exist in the entire backend, and they
handle admins four different ways (table in *Problem*). Everything else is
role-hierarchy code. The sweep documented **twelve** places where one
capability is gated in two places by two different rules. The ones that
change behaviour today:

| # | Capability | The divergence |
|---|---|---|
| 1 | **"Is this caller an admin?"** | **Six different spellings** across the codebase: `realUserRole === 'admin'`, `isRealAdmin`, `req.user.isAdmin`, a fresh `db.select(usersTable.isAdmin)`, a local `deriveUserRole` re-derivation, and `isAdminById`. The four DB-reading variants see only the stored column, so an admin granted via `ADMIN_USER_IDS` or `BOOTSTRAP_ADMIN_EMAIL` passes `requireAdmin` but gets **no budget exemption** (`budgetGate.ts:82`) and **no private-meme or PuLID rights on the pipeline path** (`createMemeRecord.ts:158`). `auth.ts:433` checks `isAdminById` but not `isAdminByEmail`, so a bootstrap-email-only admin cannot toggle admin mode at all. |
| 2 | **Video generation cannot actually be turned off** | `videos.ts:414` denies a legendary user when the grid row is off; `videoJobs.ts:91-105` runs an `isAtLeastLegendary` short-circuit *first* and allows them. Same feature key, two gate shapes — so switching `video_generation` off in the grid does nothing on the wizard path. |
| 3 | **PuLID / AI background: three vocabularies for one capability** | `render.ts:124` pure grid (denies admins), `createMemeRecord.ts:178` pure role, `memes.ts:1281`/`pulidJobs.ts:172` `requireLegendary`. |
| 4 | **Four sites accidentally honour the admin-mode toggle** | `facts.ts:471`, `jobs.ts:26,44`, `affiliate.ts:16` read the toggle-aware `isAdmin` while the stated contract is that backend authorization ignores it. Two of those (`jobs.ts`) gate *running a cron job manually* — operational work that must not follow the toggle. |
| 5 | **Two admin-only video parameters are not gated at all** | `videos.ts:573-577` consumes `adminGenerateAudio` and `adminNegativePrompt` with **no admin check**, while `adminDuration`/`adminAspectRatio`/`adminResolution`/`adminMode` three lines above are all `isAdmin &&`-guarded. Verified directly. Any legendary user can set the negative prompt and disable audio. |
| 6 | **`budgetGate` fails OPEN** | `budgetGate.ts:118-122` catches any error and returns `allowed: true, limit: Infinity`. Verified directly. A gate that controls real fal.ai spend grants unlimited spend when it malfunctions — the only permission function in the codebase that fails open on error. |
| 7 | **The grid editor accepts any tier string** | `setTierFeature` (`tierFeatures.ts:67`) does no validation, so `PATCH /admin/feature-flags` can write rows for tiers that do not exist. |

Two further gates are dead rather than wrong: `injectMembershipTier`
(`tierMiddleware.ts:74`) is exported and never mounted, and the PuLID gate at
`render.ts:124` is **unreachable** — `deriveRenderMode` takes an optional
`imageTransform` second argument that `render.ts:102` never passes, and
`RenderRequestBody` has no such field, so `mode` can never be `"pulid"`.
Verified directly. The practical exposure is small (producing a PuLID image
still requires passing `requireLegendary` on `pulidJobs.ts:172`, and upload
ownership is still checked), so this is a latent trap rather than a live
bypass — but wiring `imageTransform` through, the obvious next step, would
re-arm the exact PR #402 divergence.

### The frontend: the client never learns what it may do

**No user-facing API response carries an entitlement.** `AuthUser` and
`UserProfile` carry role and tier only; `UserProfile`'s own doc comment
instructs clients to *derive* access from the tier field. The grid is visible
to exactly one client surface — `/admin/features` — which reads it in order to
*edit* it, not to obey it.

Consequences found:

- **Every user-facing gate re-derives the rule by hand.** Roughly 60 sites.
  `role === "legendary" || role === "admin"` appears verbatim 12 times.
- **The Features console is half-inert by construction.** Four capabilities
  are server-gated as *role OR grid flag* but client-gated as
  `tier === "legendary"` only. If an operator grants `registered` the
  `meme_private_visibility`, `comment_captcha_bypass`, or `video_generation`
  flag, **the server allows it and the client keeps the control locked.** The
  operator flips a switch and sees nothing happen.
- **Three builder generations enforce three different upload rules** —
  registered (`MemeBuilder.tsx:1226`), legendary (`MemeStudioVideoTab.tsx:296`,
  `VideoBuilder.tsx:229`), registered (`Step2Image.tsx:514`) — for a server
  capability that is authentication-only.
- **The video Engine dropdown silently discards a non-admin's choice.** It
  renders whenever more than one engine is returned, and `/api/engines`
  returns flag-free engines to everyone; `videoJobs.ts:111-112` then drops a
  non-admin's `videoEngineId` with no error. The user picks an engine, gets a
  200, and receives a different model. This is dormant only while exactly one
  flag-free video engine is active, and arms itself the moment an operator
  activates a second one.
- **The one place doing it right** is that same dropdown's *read* side —
  visibility derived from a server-filtered list. It is also the highest-
  severity live bug, because the write path re-derives the same permission
  independently. Whichever pattern this plan adopts, the read gate and the
  write gate must be one expression evaluated once.

### The admin lockout is real, and it is live

**Confirmed by direct inspection.** There are exactly three client call sites
for `POST /auth/toggle-admin-mode`, and **all three are gated on the admin
mode already being on**:

- `AccountMenu.tsx:110-124` nests "Exit Admin" inside `if (isAdminModeOn)`.
- `Profile.tsx:97` declares `const isRealAdmin = role === "admin"` — the
  *effective* role, despite the name — so both of its toggle buttons
  (`:1033`, `:1159`) disappear once admin mode is off.

So once an admin turns "view as user" on, **no UI anywhere can turn it back
off.** The server would happily toggle it back (`auth.ts:428-442` requires
only `isRealAdmin`), and `AdminLayout` compounds the confusion by showing a
real admin an "Access Denied" screen with first-time-setup instructions. This
is precisely the self-reference lockout David anticipated, and it exists
today.

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

### Two rails, named and kept apart

| | **Entitlement rail** | **Privilege rail** |
|---|---|---|
| Answers | "What product features does this account get?" | "What may this account do *to the system*?" |
| Source of truth | The Feature Permission Grid | `requireRole` on `realUserRole` |
| Runtime-editable | Yes, by an admin, no deploy | No — code |
| Honours "view as user" | **Yes** | **No** |
| Examples | private memes, video generation, AI backgrounds, captcha bypass | admin console, user management, moderation, config editing, the grid editor itself |

Keeping these apart is what makes David's bootstrap exception structural
rather than a special case: **nothing that grants access to the admin console
lives in the grid, so no grid configuration can lock an admin out.**

### One resolver

A new module — `artifacts/api-server/src/lib/featureAccess.ts` — is the only
code permitted to read the grid:

```
resolveEntitlements(principal) -> Map<featureKey, Entitlement>
  = merge( gridRows(principal.tier),
           principal.isAdmin ? gridRows('admin') : ∅ )

Entitlement = { allowed: boolean, limit: number | null }   // null = unlimited

can(principal, featureKey)      -> boolean
limitFor(principal, featureKey) -> number | null
requireFeature(featureKey)      -> express middleware
```

**Every feature carries a value, and booleans are the degenerate case.** A
boolean feature is `{allowed, limit: null}`; a metered one adds a number. The
three states a metered cell can hold are:

| Grid cell | Meaning |
|---|---|
| off | denied entirely |
| on, no number | **unlimited** |
| on, number | capped at that number |

This is what lets today's hardcoded admin exemptions become *visible cells*
reading "Unlimited" instead of `if (isAdmin) return Infinity` buried in a
helper — which is the whole point of Settled Decision #7.

**`merge` is "more permissive wins", the numeric analogue of the union.**
`allowed` OR-s; `limit` takes the larger, with unlimited beating any number.
An admin therefore never ends up with a *smaller* allowance than their own
tier would have given them, exactly as the boolean union guarantees they never
lose a feature.

- **`principal`** is derived from `req.user` — carrying the *effective* tier
  and the *toggle-aware* admin flag — or the anonymous principal
  (`tier: 'unregistered'`, `isAdmin: false`) when there is no session. Taking
  a principal rather than a tier string is the whole point: it is the seam
  impersonation later slots into (Settled Decision #5).
- **Union**, per Settled Decision #2.
- **One admin predicate.** The six current spellings collapse to the
  principal's flag, which is built from `isRealAdmin` in `authMiddleware`
  (stored column **OR** `ADMIN_USER_IDS` **OR** bootstrap email) — so
  env-granted and bootstrap admins stop silently losing entitlements.
- **Fails closed** on a missing row, an unknown key, or a DB error.
- **`hasFeature(tier, key)` stops being exported to application code.** The
  tier-keyed primitive becomes module-private, and a CI guard
  (`scripts/check-permission-chokepoint.mjs`, wired into `build.yml` beside
  the existing `check:docs` / `check:codegen-drift` guards) fails the build if
  any file outside `featureAccess.ts` references it, or if a product-feature
  route reintroduces an inline role comparison. Per Settled Decision #7 and
  the repo's standing "recurring failure patterns become CI guards" practice.

### One client contract

The resolved feature set ships to the client on the auth payload —
`AuthUser.features: string[]`, computed by the **same** resolver the write
paths use. The client obeys it instead of deriving:

- `roleToTier` (`studioAdapter.ts:45-49`) — the PR #402 function — is deleted.
- The 12 verbatim `role === "legendary" || role === "admin"` derivations and
  the three contradictory upload rules collapse into `can('feature_key')`.
- The Features console stops being half-inert: granting `registered` a flag
  now visibly changes the UI, because the UI is reading the grid.
- `AuthUser` is codegen-owned (`lib/api-spec/openapi.yaml` →
  `lib/api-zod`), so the field is added at the spec and regenerated —
  never hand-edited into `lib/api-zod/src/index.ts`, per that package's
  standing codegen-drift gotcha.

**Read gate and write gate must be one expression evaluated once.** The engine
dropdown is the worked example of getting this wrong: its read side filters
server-side and its write side re-derives independently, so a mismatch is
silent.

### Lockout and self-reference guards

The exception David named, made concrete. Three guards, none of which exist
today:

1. **An admin may not remove their own admin flag** (`PATCH /admin/users/:id`).
2. **The last active admin may not be demoted or deleted** — checked inside the
   transaction, not before it, so two concurrent demotions cannot both pass.
3. **"View as user" gains a re-entry path.** The toggle control is gated on
   `realRole === 'admin'` rather than the effective role, so it is reachable in
   both directions; `AdminLayout` shows a real admin in view-as-user mode a
   "You are viewing as a user — exit admin mode" panel instead of the current
   "Access Denied" screen.

### Adjacent defects folded in

These are all *permission checks disagreeing with each other*, which is the
brief, so they are fixed here rather than separately:

- `budgetGate` fails **closed** on error instead of granting infinite spend.
- `adminGenerateAudio` / `adminNegativePrompt` get the admin gate their
  siblings already have.
- `video_generation`'s grid rows stop being force-overwritten on every boot.
- `videos.ts` and `videoJobs.ts` resolve video generation through one call, so
  turning the feature off in the grid actually turns it off.
- `setTierFeature` validates the tier identifier.
- `injectMembershipTier` (dead) and the unreachable `render.ts` PuLID gate are
  removed — the latter replaced by a real, reachable gate.
- The four operational sites reading the toggle-aware `isAdmin`
  (`jobs.ts` ×2, `affiliate.ts`, `facts.ts`) are moved to the correct rail.

## Grid Intent Review

**This is the section that needs David's product judgement.** Every row below
is a capability the system already has; the question is only what the grid
should say about it. "Current" reflects live behaviour, whether it comes from
the grid or from hardcoded application code.

### Existing keys

| Feature | Current behaviour | Proposed grid row (u / r / l / **a**) | Change |
|---|---|---|---|
| `comment_captcha_bypass` | legendary + admin skip comment captcha | ✗ / ✗ / ✓ / **✓** | none — admin cell becomes live |
| `meme_private_visibility` | legendary + admin (post-#402) | ✗ / ✗ / ✓ / **✓** | none — admin cell becomes live |
| `meme_rate_limit_high` | legendary only; **admins wrongly on the free cap** | *replaced by the metered `daily_meme_saves` below* | **fixes an accidental denial**; the boolean disappears in favour of the actual numbers, which also retires its wrong description |
| `meme_ai_background` | legendary via `requireLegendary`; **admins wrongly denied** on the (dead) render gate | ✗ / ✗ / ✓ / **✓** | **fixes an accidental denial**; rewired to the reachable routes |
| `video_generation` | legendary + admin, **cannot actually be switched off** | ✗ / ✗ / ✓ / **✓** | grid toggle starts working; boot overwrite removed |
| `meme_upload_photo` | **dead row** — upload is authentication-only | ✗ / ✓ / ✓ / **✓** | **wired up for the first time**, matching today's real behaviour and resolving the three-way builder disagreement |
| `engine_experiments` | **no rows**; admin-only via a hardcoded predicate | ✗ / ✗ / ✗ / **✓** | rows created, hardcoded predicate replaced |

### New keys — capabilities that exist but are not in the grid

| Proposed feature | Where it lives today | Proposed grid row (u / r / l / **a**) |
|---|---|---|
| `meme_pulid_stylize` | `requireLegendary` on `pulidJobs.ts:172` + a role check in `createMemeRecord` | ✗ / ✗ / ✓ / **✓** |
| `fact_submit_captcha_bypass` | legendary/admin short-circuits in `reviews.ts:136`, `ai.ts:336` | ✗ / ✗ / ✓ / **✓** |
| `fact_submit_rate_limit_bypass` | legendary/admin short-circuit in `rateLimit.ts:184` | ✗ / ✗ / ✓ / **✓** |
| `ads_free` | client-only, `AdSlot.tsx:21` — no server gate exists | ✗ / ✗ / ✓ / **✓** |
| `profile_photo_avatar` | client-only, `Navbar.tsx:46` — real photo vs. generated avatar | ✗ / ✗ / ✓ / **✓** |

### Metered rows — the numeric limits moving in from elsewhere

Per Settled Decision #7. "∞" is the *unlimited* cell state, which is how
today's hardcoded admin exemptions become visible. Every value below is what
the system does today.

| Proposed feature | Lives today in | u | r | l | **a** |
|---|---|---|---|---|---|
| `daily_meme_saves` | code constants 30 / 200, via the `meme_rate_limit_high` boolean | ✗ | 30 | 200 | **∞** ¹ |
| `ai_generation_budget` (per budget period, USD) | `admin_config` `budget_limit_*_usd` | ✗ | 0.50 | 10.00 | **∞** |
| `daily_photo_uploads` | `admin_config` `upload_rate_limit_*_per_day` | ✗ | 20 | 200 | **∞** |
| `daily_video_jobs` | code constant 3, flat | ✗ | 3 | 3 | **∞** ² |
| `fact_submits_per_minute` | code constant 5/60s | ✗ | 5 | ∞ | **∞** |
| `pending_fact_submissions` | code constant 10, flat | ✗ | 10 | 10 | **∞** ³ |
| `governance_daily_spend` (USD) | `resourceGovernance.POLICIES` | 0 | 3 | 20 | **200** |
| `governance_monthly_spend` (USD) | same | 0 | 25 | 250 | **2000** |
| `governance_requests_per_day` | same | 0 | 25 | 250 | **2000** |
| `governance_concurrent_jobs` | same | 0 | 1 | 3 | **10** |
| `governance_max_duration_sec` | same | 0 | 8 | 30 | **120** |
| `governance_max_payload_mb` | same | 0 | 1.5 | 8 | **25** |

¹ **fixes the accidental denial** — admins are currently on 30/day.
² admins are currently exempt in code; ∞ makes that visible.
³ **fixes the accidental cap** — admins are currently held to 10 like everyone
else, unlike the sibling rate limiter which exempts them.

The governance rows are the only place in the codebase that already models
admin as a first-class tier with its own policy. Moving it into the grid
generalises the one thing that was already right.

### What deliberately stays in `admin_config`

Applying the boundary rule from Settled Decision #7 — these are identical for
every account, so they are system tuning, not permissions:
`budget_period`, `user_max_images`, `max_memes_per_fact`,
`ai_max_images_per_gender`, `pexels_photos_per_gender`,
`bg_display_limit_stock` / `_gradient` / `_upload`, and the
moderation fail-open switches. If any of these later needs to differ by tier,
the rule says it moves to the grid at that point.

**One per-user exception is retained and documented:**
`users.monthly_generation_limit_override_usd`, set on the user-edit screen,
overrides `ai_generation_budget` for a single account. That is a deliberate
per-user override rather than a second source of tier truth, and the Features
page will say so, so it does not become the next "setting somewhere else."

Every proposed row reproduces today's behaviour except the four marked as
fixing an accidental denial or cap. Nothing silently gains or loses access on
migration day — the grid starts by describing what already happens, and from
then on it is the thing that decides.

## Data Model and Migration Impact

### Schema

Two additive columns, no table split — one table keeps the admin page a single
screen, which is the requirement behind Settled Decision #7.

- `feature_flags` gains **`value_type`** (`'boolean' | 'integer' | 'decimal'`,
  default `'boolean'`), **`unit`** (nullable display string — `USD`, `per day`,
  `MB`), and nullable **`min_value` / `max_value`** for input validation,
  mirroring how `admin_config` already describes its own editable values.
- `tier_feature_permissions` gains a nullable **`limit_value`**
  (`numeric(12,4)`). `NULL` on an enabled metered row means *unlimited*; it is
  meaningless on a boolean row.

A CHECK constraint enforces that `limit_value` is null whenever the feature's
`value_type` is `'boolean'`, so the two shapes cannot be mixed up in data.
Because a raw-SQL constraint that exists only in a migration has been lost in
this repo before, the matching `check()` is declared in
`lib/db/src/schema/featureFlags.ts` in the same PR.

### Migration

Forward-only, idempotent, in this order:

1. Add the columns and the CHECK.
2. Insert the new boolean `feature_flags` rows and their four tier rows each;
   fill `engine_experiments`' four missing rows.
3. Insert the metered `feature_flags` rows, then their tier rows — **reading
   the current values out of `admin_config` where they live there**
   (`budget_limit_*`, `upload_rate_limit_*`) rather than hardcoding, so an
   operator who has already retuned them keeps their values. Code-constant
   sources (save caps, governance policy, video jobs, submit limits) are
   written from the constants.
4. **Delete the migrated `admin_config` rows.** This is the step that actually
   delivers David's requirement — if the old keys survive, there are now *two*
   screens instead of one, which is worse than before. The config editor must
   not still offer a budget limit that no longer does anything.
5. Drop the `meme_rate_limit_high` boolean rows, superseded by
   `daily_meme_saves`.
6. Backfill any `(tier, feature_key)` combination still missing so the
   invariant "every feature has exactly four rows" holds, and add the guard
   that makes migration `0057`'s failure mode — a feature added later with no
   rows — impossible to repeat.

**Row-state matrix:** *new* key → insert; *existing* key → no-op; *partial*
(some tiers present) → fill gaps only; *retuned by operator* → value preserved
from `admin_config`; *re-run* → no-op throughout. Nothing is destructive
except step 4/5, which delete rows this migration has just superseded — and
both are guarded on the replacement rows existing first, so a partial failure
cannot leave the system with neither.

**Rollback:** the deletions in 4/5 are the only irreversible part, so the
migration writes the pre-deletion `admin_config` values into the migration log
before removing them. A rollback is a new forward migration restoring them
from that record, per the repo's forward-only convention.

Also in the same PR: the `video_generation` seed in `seed.ts` changes from
`DO UPDATE SET enabled = EXCLUDED.enabled` to `DO NOTHING`, matching every
other seeded row, so operator toggles survive a restart.

## Runtime Behavior

- An anonymous request resolves the `unregistered` row-set.
- A registered user resolves their tier's row-set.
- An admin resolves their tier's row-set merged with the admin row-set —
  booleans OR-ed, limits taking the more permissive value.
- **An admin in "view as user" mode resolves their tier's row-set only** —
  including the metered rows, so they genuinely hit a registered user's spend
  cap, upload cap and rate limits (Settled Decision #8). They still reach the
  admin console, and can always leave the mode.
- A grid toggle takes effect within the resolver's 60-second cache TTL, per
  process. **This is a real, stated property, not a bug** — but the admin UI's
  current claim that "changes take effect immediately" is corrected to name
  the window, and the cache is busted on write in the writing process.
- Any resolution failure denies.

**Edge case worth stating:** a user whose paid entitlement lapses mid-session
resolves the lower row-set on their next request, because the principal is
rebuilt from `effectiveTierExpr()` on every request. Unchanged from today.

## Admin/User UX Impact

- **Features console — the main build of this project's UI half.** The page
  becomes the single screen that answers "who is allowed to do what," which is
  the requirement behind Settled Decision #7:
  - Cells render by `value_type`: a checkbox for boolean features, a number
    input with its unit for metered ones, each with an explicit **Unlimited**
    state distinct from both zero and blank. Zero-versus-unlimited must never
    be ambiguous — that distinction is the difference between "denied" and
    "no cap."
  - Rows are grouped by area (Memes, Video, Facts, Uploads, Spend,
    Governance) rather than listed flat, because the metered rows roughly
    triple the row count.
  - The Admin column header states that admin values *add to* — never replace
    — the user's tier, so the union and "more permissive wins" semantics are
    visible rather than folklore.
  - Values migrated out of the config editor carry a note saying this is now
    their only home, and the per-user budget override is named on the page so
    it does not become the next invisible setting.
  - The "changes take effect immediately" copy is corrected to name the
    propagation window.
- **Every user-facing lock becomes truthful.** Controls the server would allow
  stop being hidden, and controls the server would reject stop being offered.
- **View-as-user gains an exit.** A real admin in view-as-user mode sees an
  explanatory panel with a working toggle instead of "Access Denied".
- **No end-user-visible capability changes** except the three accidental
  denials being lifted, all of which affect admins only.

## Security, Permissions, and Validation

- Every gate fails closed; `budgetGate` joins them.
- Operational routes keep `requireRole` on `realUserRole` — unchanged, and now
  enforced consistently at the four sites that read the toggle-aware flag.
- Ownership checks are untouched and explicitly out of the grid. **The sweep
  found that admins can *view* any meme but cannot *act* on one they don't own
  (delete, remove a link, cancel a job) — that asymmetry is preserved and
  documented as deliberate rather than left implicit.**
- The grid editor validates tier identifiers.
- Admin grant/revoke keeps its existing audit trail; the new lockout guards
  return explicit errors rather than silently no-op'ing.
- **No new trust boundary.** The client-visible feature list is a projection
  of a server decision, never an input to one — the server re-resolves on
  every request and never trusts a client-supplied feature claim.

## Testing Plan

Runner commands per `docs/tests/testing-guide.md`:
`pnpm --filter @workspace/api-server test`, `pnpm --filter @workspace/db test`,
`pnpm --filter @workspace/overhype-me test`.

The invariant tests, not just the reported examples:

1. **Union semantics** — for every feature key, an admin on each of the three
   tiers resolves ⊇ what that tier alone resolves. Table-driven over the whole
   grid, so a future key cannot escape it.
2. **The PR #402 regression, generalised** — for every feature key, the set an
   admin resolves is never smaller than a legendary user's, unless the admin
   row is explicitly off. This is the test that would have caught #402, the two
   still-live accidental denials, and the next one.
3. **Every consulted key is reachable** — a test asserting each key referenced
   in code exists in the grid with four tier rows, and each grid key is
   referenced in code (catching both `meme_upload_photo`'s orphaning and
   `engine_experiments`' missing rows).
4. **Fail-closed** — DB error, unknown key, and missing row each deny, for
   every gate including `budgetGate`.
5. **View-as-user** — feature gates drop the admin union; `requireRole`
   admin gates do not; the toggle is reachable in both directions.
6. **Lockout guards** — self-demotion refused; last-admin demotion and deletion
   refused; two concurrent demotions cannot both succeed.
7. **Client/server agreement** — the client's rendered lock state for each
   capability is asserted against the server's answer for the same principal,
   so a future divergence fails CI rather than shipping.
8. **Negative cases throughout** — an unregistered principal, an anonymous
   principal, and a lapsed-legendary principal for each gate.

Manual QA is the UAT doc, covering both the admin and non-admin experience of
each changed surface.

## Implementation Steps

**Ordering note.** Folding the numeric limits in reorders the build. The
client contract now ships *last*, because the payload it sends must carry the
final entitlement shape — booleans and limits together. Defining that payload
before the metered rows exist would mean building it twice. The cost is that
the PR #402 *class* stays technically open until Phase 3; the mitigation is
that Phase 1 makes the server correct and fail-closed, so the residual failure
mode is a visible error rather than a silent one, and the specific privacy
defect from #402 is already fixed on `main`.

**Phase 1 — the resolver and the backend (one PR).**

1. Add `featureAccess.ts` with `resolveFeatures` / `can` / `requireFeature`;
   make `hasFeature` module-private.
2. Migration: new keys, missing rows, corrected description, the
   four-rows-per-feature guard. Fix the `seed.ts` overwrite.
3. Move all six grid call sites and the five `requireLegendary` product routes
   onto `requireFeature` / `can`.
4. Move the hardcoded role-rank product gates (PuLID, captcha bypasses,
   submit-rate bypass) onto the resolver.
5. Move the four mis-railed operational sites onto `realUserRole`.
6. Fix the adjacent defects listed under *Proposed Design*.
7. Lockout guards on `PATCH`/`DELETE /admin/users/:id`.
8. CI guard script + `build.yml` wiring.
9. Tests 1-6, 8.

**Phase 2 — metered limits, and the grid becomes total (one PR).**

10. Schema columns + CHECK + the matching `check()` in the schema file.
11. Migration: metered features and their tier values, read from
    `admin_config` where they live there; delete the migrated config rows and
    the superseded `meme_rate_limit_high` rows.
12. Move the seven numeric consumers onto `limitFor(...)` — `budgetGate`,
    `uploadRateLimit`, the meme save cap, video jobs/day, the fact-submit
    limiter, the pending-submission cap, and `resourceGovernance`'s policy
    table.
13. Rebuild the Features page for mixed cell types, grouping, and the
    explicit Unlimited state.
14. Apply view-as-user faithfully to the metered rows (Settled Decision #8).
15. Tests for merge semantics on limits, zero-vs-unlimited, the config
    migration preserving retuned values, and the two accidental caps lifting.

**Phase 3 — the client contract (one PR).**

16. Add the resolved entitlement set to `AuthUser` at the spec; regenerate;
    verify against codegen immediately per the `lib/api-zod` gotcha.
17. Client `can()` / `limitFor()` reading the payload; delete `roleToTier` and
    the 12 duplicated derivations.
18. Reconcile the three upload rules and the engine dropdown's read/write
    split.
19. Fix the view-as-user re-entry path and the `AdminLayout` panel.
20. Test 7, plus client tests for the reconciled surfaces.

Each phase is independently shippable and independently UAT-able: Phase 1
makes the server correct, Phase 2 makes the grid total and the admin screen
the single answer, Phase 3 makes the client obey rather than guess.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| A capability is missed in the sweep and keeps an inline role check | The CI guard fails the build on any inline role comparison in a product-feature path; the sweep's inventory is the checklist, and tests 2-3 catch unreachable or unreferenced keys |
| The union grants an admin something an operator meant to deny | Union is deliberate (Settled Decision #2); the Admin column is editable, so denial is one toggle away and now actually works |
| A grid misconfiguration disables a capability broadly | Cannot affect console access by construction; every row's migration default reproduces today's behaviour, so day-one risk is zero and later changes are deliberate operator acts |
| The 60s cache makes a toggle look broken | The window is stated in the UI copy; writes bust the cache in the writing process |
| Codegen silently reverts the new `AuthUser` field | Verify against codegen immediately per the `lib/api-zod` gotcha; `check:codegen-drift` is the CI guard |
| A large diff is hard to review | Split into two PRs at a natural seam; Phase 1 is server-only and fully testable |

## Questions for David

All four resolved on 2026-08-10 and folded into *Settled Decisions* — kept
here as the record of what was asked and answered:

1. **The grid matrix** — confirmed as proposed, including all five new boolean
   keys and `profile_photo_avatar`.
2. **Numeric per-tier configuration** — **fold it into the grid.** David
   overrode my recommendation to defer; see Settled Decision #7 for his
   reasoning and the boundary rule it produced.
3. **Does "view as user" drop the numeric exemptions too** — **yes, stay
   faithful.** An override toggle is possible later; not built now.
4. **Admins view but do not act on others' content** — confirmed intended.

No open questions. The remaining judgement calls are engineering ones and are
resolved in this document.

## Definition of Done

- Every product-feature gate in the codebase resolves through
  `featureAccess.ts`; the CI guard proves no others exist.
- The Admin column is live, and toggling any cell changes behaviour.
- The grid contains every tier-specific capability **and every tier-specific
  limit**, and every key is both referenced by code and fully populated across
  four tiers.
- **The Features page is the only screen that answers "who is allowed to do
  what."** No tier-differentiated setting remains in the config editor, and
  the one per-user override that exists is named on the page.
- No client surface derives a permission it was not told.
- An admin cannot demote themselves, cannot be the last admin removed, and can
  always leave view-as-user mode.
- The three accidental admin denials, the fail-open budget gate, the two
  ungated video parameters, the boot-time overwrite, and the silent engine
  discard are all fixed, with tests.
- `docs/ai-context/` updated: a new permissions section (or file) as the
  single source of truth, with `membership-entitlements.md`'s reader-inventory
  caveat, `accounts-and-auth.md`'s role-derivation section,
  `admin-console.md`'s Features entry, and the
  `known-failure-patterns.md` entitlement-gate entry all pointed at it.
- TEST_RUN + UAT docs shipped in the same PRs.
