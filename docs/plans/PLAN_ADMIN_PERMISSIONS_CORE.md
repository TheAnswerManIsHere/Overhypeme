# Plan: One resolver, one client contract, no admin lockout

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
qualify has a hand-written exception in application code. The six current
`hasFeature`/`requireLegendary` call sites handle admins several different
ways — some short-circuit correctly, two silently deny admins by accident
(`meme_ai_background`, and the free-tier cap on `meme_rate_limit_high`), one
mixes a role check and a grid check inconsistently.

**The concrete symptom that commissioned this work:** PR #402. The meme
builder mapped `admin → legendary` client-side and offered a Private pill;
`createMemeRecord` resolved the same entitlement from the tier column, found
`registered`, and coerced the meme public. Both surfaces believed they agreed
with the other. A user's privacy choice was silently discarded and the meme
was world-readable at its permalink.

That was one instance of a class. The class is: **two vocabularies, no
chokepoint, and a configuration surface that lies about being the source of
truth.**

## Direction

Serves [`product-direction.md`'s *Permissions direction*](../ai-context/product-direction.md#permissions-direction),
approved and merged in #412. That direction states the end state (one screen
answers who is allowed to do what, for every product entitlement) and ten
settled product decisions; this plan builds the increment that makes the
mechanism true, not the whole grid.

**What this increment makes true:** every product-feature permission check in
the codebase resolves through one function, reading the grid; the grid's
Admin column is live; the client is told its entitlements instead of deriving
them; and an admin cannot be locked out of the console by any sequence of
grid or account edits.

## Sibling plans

Three plans share this direction. Each is independently shippable; none
blocks another's approval.

| | Scope | Status |
|---|---|---|
| **This plan (1a)** | The resolver, the live Admin column, the client contract, lockout guards — **boolean** features only | Under review, PR #421 |
| **1b — grid write boundary** | Making the grid's write-side invariants enforced by the database rather than by the calling code: sanctioned write functions, triggers, the ownership-hardening runbook | Under review, PR #422 — [plan](./PLAN_FEATURE_GRID_WRITE_BOUNDARY.md) |
| **2 — metered limits + tester** | Numeric per-tier limits, the `tester` overlay, retiring the per-user spend override | Not written |
| **3 — engine bands** | Band-based engine access, retiring `engine_experiments` and `tierRequirement` | Not written |

**Plan 1b was split out of this document on 2026-08-12** at David's direction,
after this plan's growth tripwire fired (760 → 1168 lines) across three review
rounds with rising finding counts (10 → 13 → 14) that clustered on
database-hardening mechanics. What remains here is the entitlement work; what
left is the machinery that makes correct writes *unbypassable*. This plan's
own code writes the grid correctly — see *Data Model* — and does not depend on
1b having shipped.

## Product Intent

1. **Every existing product-feature permission check** resolves through one
   function, which consults the Feature Permission Grid and nothing else. No
   `unless admin` exceptions anywhere in application code.
2. **The Admin column in the grid becomes live** — it is read at runtime, and
   toggling it changes what admins can do, with no deploy.
3. **The client stops deriving permissions.** It is told what the user may
   do, for every boolean feature that exists today.
4. **An admin cannot be locked out** by demotion, deletion, deactivation, an
   email change, or the "view as user" toggle, under any sequence including
   concurrent ones.
5. **Every capability currently gated by an inline role check** moves into the
   grid as a boolean feature, so the grid is a complete picture of *boolean*
   entitlements.

## Must Not Change

- **Numeric per-tier limits are not touched.** Spend budgets, upload caps,
  save caps, rate limits, and `resourceGovernance`'s policy table stay exactly
  as they are today, including their existing bugs — Plan 2's scope. Two of
  those bugs (the fail-open spend gate, two ungated video parameters) are
  tracked and fixed independently via the bugfix lane (#409, #410).
- **`engine_experiments` and `engines.tierRequirement` are not touched.**
  They stay exactly as broken as they are today (dead grid rows, a hardcoded
  admin-only predicate). Plan 3 replaces them. This plan must not partially
  fix or partially migrate them.
- **The per-user spend override (`users.monthly_generation_limit_override_usd`)
  is not touched.** Plan 2 replaces it with the `tester` role.
- **The grid's write-side enforcement is Plan 1b's**, not this plan's. This
  plan writes the grid correctly through its own code paths; it does not add
  functions, triggers, privilege revokes, or an ownership runbook.
- **Backend authorization for operational privileges never honours the admin
  "view as user" toggle.** `requireRole`/`requireAdmin` stay on
  `realUserRole`. (Feature gates deliberately *do* honour the toggle — see
  Settled Decisions — but console/admin-route access does not.)
- **`req.user` stays rebuilt from the database on every authenticated
  request.** Role, admin, and membership are never trusted from the session
  blob. (security-model.md invariant #3.)
- **`users.membership_tier` stays derived, never assigned.** No new writer of
  that column; `effectiveTierExpr()` remains the read path.
- **Every gate continues to fail closed.** A missing grid row, a DB error, or
  an unknown feature key denies.
- **The three admin-flag grant paths stay as they are**: the stored
  `users.is_admin` boolean, the `ADMIN_USER_IDS` env allowlist, and the
  `BOOTSTRAP_ADMIN_EMAIL` hardcoded bootstrap.
- **The identity photo stays available to the studio.** Gating the *display*
  of a custom avatar must not remove the stored photo that PuLID meme and
  video generation consume.
- **Ownership checks are not permissions in this sense and do not move into
  the grid.** "May I edit *my own* meme" is a resource-ownership question.
- **No rollout-flag gating.** This ships as the new behavior, not behind a
  toggle.
- **Impersonation is out of scope** — deferred at the direction level.

## Settled Decisions

Inherited from the direction (#412) and the pre-plan conversation; not
re-litigated here.

1. **Admin resolution is a UNION, never an override.** A user's feature set is
   `features(their tier) ∪ (isAdmin ? features('admin') : ∅)`. An admin who
   also holds a paid Legendary entitlement never *loses* a feature by being an
   admin.
2. **Operational privileges are NOT grid features.** Admin console access,
   user management, moderation actions, config editing, and the grid editor
   itself stay on `requireRole('admin')`. This is what makes admin lockout
   impossible by configuration — nothing that grants console access lives in
   the grid.
3. **"View as user" normalizes to `registered`** — not merely "the account's
   own tier minus the admin overlay." A legendary-holding admin previewing as
   a user genuinely experiences a registered account. Operational privileges
   continue to ignore the toggle, so an admin can never lock themselves out
   mid-preview, and a working re-entry path is added (none exists today).
4. **The wrong call must become impossible, not merely discouraged.** A
   tier-keyed `hasFeature(tier, key)` reachable from route code is how the
   PR #402 bug class reproduces. The tier-keyed lookup is confined to the
   resolver module, and a CI guard fails the build if application code calls
   it directly, or if a product route is neither resolver-gated nor
   classified in the allowlist.
5. **Every product route is classified into exactly one of four rails**:
   entitlement (grid), privilege (role check), identity prerequisite
   (authentication only), or deliberately public (declared, not inferred from
   an absent gate). The classification is checked in as an allowlist; the CI
   guard requires an approved form rather than hunting for bad ones.
6. **The client is told its entitlements; it never derives them.** The
   resolved set ships as a sibling of the (possibly null) user object, so
   anonymous callers get a projection too.
7. **Admins may view any ordinary content but not act on content they don't
   own**, outside their granted moderation privileges. Quarantined/restricted
   CSAM-abuse evidence is categorically excluded from admin viewing regardless
   (`legal-safety-moderation.md` wins any conflict; untouched here, since no
   admin viewer exists today and this plan adds none).
8. **Queued work is authorized as of submission, not execution** — the
   resolved principal *and* the resolved boolean decision for the features
   that job type gates are persisted with the job, rather than re-derived at
   completion. Accepted consequence: a feature revoked while a job is
   in-flight still completes that one job.

## Repo Context Inspected

Three exhaustive sweeps informed the original combined plan (backend
authorization gates, client-side gates, grid/config data) — see
`known-failure-patterns.md`'s entitlement-gate entry and
`membership-entitlements.md`'s reader-inventory section for the durable
record. Re-inspected directly for this plan: `lib/tierFeatures.ts`,
`lib/userRole.ts`, `middlewares/tierMiddleware.ts`,
`middlewares/authMiddleware.ts`, `lib/createMemeRecord.ts`, `routes/admin.ts`,
`routes/auth.ts`, `routes/users.ts`, `routes/storage.ts`, `routes/facts.ts`,
`lib/videoPipelineRunner.ts`, `lib/aiMemePipeline.ts`, `lib/budgetGate.ts`,
`lib/seed.ts`, `lib/db/src/schema/featureFlags.ts`, `lib/db/src/migrate.ts`,
migrations `0013`/`0028`/`0029`/`0057`, `pages/admin/features.tsx`,
`pages/Profile.tsx`, `components/layout/Navbar.tsx`, `Onboard.tsx`, and
`docs/ai-context/meme-and-video-studio.md`.

## Current Behavior

### The grid's actual contents (boolean features only)

| Feature key | u | r | l | a | Read by code? |
|---|---|---|---|---|---|
| `comment_captcha_bypass` | ✗ | ✗ | ✓ | ✓ | yes |
| `meme_ai_background` | ✗ | ✗ | ✓ | ✓ | yes — **admins wrongly denied** |
| `meme_private_visibility` | ✗ | ✗ | ✓ | ✓ | yes |
| `meme_rate_limit_high` | ✗ | ✗ | ✓ | ✓ | yes — **admins wrongly on the free cap** |
| `meme_upload_photo` | ✗ | ✓ | ✓ | ✓ | **no — fully orphaned; this plan deletes it** |
| `video_generation` | ✗ | ✗ | ✓ | ✓ | yes — **cannot be switched off** |
| `engine_experiments` | no rows | | | | no — **out of scope, Plan 3** |

The two accidental admin denials are fixed by the resolver alone: each
feature's admin row is already `true`, and today's bug is only that no code
path queries it. No numeric work is involved.

### The backend: role-hierarchy code outside the grid

Roughly a dozen capabilities are gated by an inline role comparison
(`isAtLeastLegendary(role)`, `requireLegendary`, ad hoc `isAdmin` checks) with
no grid row at all: PuLID-stylised memes, fact-submit CAPTCHA bypass,
fact-submit rate-limit bypass, ad-free browsing, and the custom-avatar
capability. Five operational sites read the toggle-aware `isAdmin` where they
should read `realUserRole` — see *Adjacent defects*.

### The frontend: the client never learns what it may do

No user-facing API response carries an entitlement; `AuthUser` and
`UserProfile` carry role and tier only. The grid is visible to exactly one
client surface (`/admin/features`), which edits it and never obeys it.
Consequences: roughly a dozen verbatim `role === "legendary" || role ===
"admin"` derivations, the `roleToTier` function implicated in PR #402, and
three contradictory upload-gating rules across the meme builder generations.

### The admin lockout is real, and it is live

All three client call sites for `POST /auth/toggle-admin-mode` are gated on
admin mode already being *on*, so once an admin turns "view as user" on, no UI
anywhere can turn it back off. `AdminLayout` compounds this by showing a real
admin in that state an "Access Denied" screen. This is the self-reference
lockout David anticipated, and it exists today.

### The custom-avatar entitlement is unenforced, in both directions

A tier privilege framed as an upsell (David, 2026-08-11): lower tiers get a
non-configurable generated icon; a custom avatar image is meant to be a paid
unlock. Today:

- **The write is ungated.** `POST /users/me/profile-image` (`users.ts:563`)
  sets `avatarSource = 'photo'` as a side effect of upload, and `PATCH
  /users/me` (`users.ts:282-286`) accepts it directly. Neither checks
  anything beyond authentication.
- **The read is inconsistent, and leaks more than the upsell.**
  `Navbar.tsx:49` and `Profile.tsx:383` honour `avatarSource` but check no
  entitlement. Worse, `facts.ts:47,58` (submitter avatars) and
  `facts.ts:431,445` and `:502` (comment author avatars) project
  `profileImageUrl` **without reading `avatarSource` at all** — so a user who
  uploads an identity photo for meme generation and never selects it as their
  avatar still has that photo shown publicly beside their submissions and
  comments. That is a pre-existing defect independent of entitlements, and it
  sits on the same projection this plan has to fix anyway.

## Source-of-Truth Analysis

| Concept | Today | After |
|---|---|---|
| What boolean features a tier gets | `tier_feature_permissions` (partial — code carries the admin half) | `tier_feature_permissions`, whole |
| What boolean features an admin gets | Scattered application-code exceptions | `tier_feature_permissions` `admin` rows, unioned |
| Whether someone may operate the system | `requireRole('admin')` on `realUserRole` | unchanged |
| A user's membership tier | `effectiveTierExpr()` | unchanged |
| Whether someone owns a resource | Per-route ownership checks | unchanged |
| What the client believes is permitted | Client-side derivation from role | Server-sent resolved entitlement map |
| Which avatar image is public | Each call site decides, inconsistently | One server-derived effective-avatar projection |
| Numeric per-tier limits | `admin_config` + code constants | unchanged — Plan 2 |
| Engine access | Hardcoded admin-only predicate | unchanged — Plan 3 |

No new source of truth is created. The grid already exists and already holds
admin rows; this plan makes those rows reachable and removes the shadow copy
in application code.

## Proposed Design

### Four rails, kept apart

| | **Entitlement** | **Privilege** | **Identity prerequisite** | **Deliberately public** |
|---|---|---|---|---|
| Answers | "What product features does this account get?" | "What may this account do *to the system*?" | "Are you signed in at all?" | "Nothing — anyone may do this" |
| Source of truth | The grid | `requireRole` on `realUserRole` | `req.isAuthenticated()` | the allowlist entry itself |
| Runtime-editable | Yes, no deploy | No — code | No | No |
| Honours "view as user" | Yes | No | n/a | n/a |
| Examples | private memes, video generation, custom avatar | admin console, user management, moderation | commenting, rating, hearts | `GET /facts`, public meme permalinks |

Keeping entitlements and privileges apart is what makes admin lockout
structurally impossible: nothing that grants console access lives in the grid,
so no grid configuration can lock an admin out.

**Identity prerequisites and deliberately-public routes are genuine
categories, not gaps in the first two.** A large set of capabilities is gated
only by "are you signed in" — commenting, rating, hearts, share intents.
Granting these to `unregistered` is incoherent (they write rows owned by a
user id that would not exist), so they don't belong in the grid, but they
aren't privileges either. Separately, browsing without an account (`GET
/facts`, `GET /hashtags`, public meme permalinks) is core product behaviour
that must stay reachable. Both categories are **declared** in the allowlist,
never inferred from an absent gate, so an accidentally ungated mutation still
fails the guard.

**One named, temporary allowlist exception.** `GET /engines`'s catalogue
filter (`videos.ts:820`) is an inline `realUserRole === "admin"`
product-feature check — exactly the pattern the CI guard exists to catch. But
*Must Not Change* keeps engine access untouched until Plan 3. So the allowlist
grandfathers that one site, tagged deferred-to-Plan-3. A *new* inline check
anywhere else still fails the build, and Plan 3's implementation removes the
exception.

**`meme_upload_photo` is retired as a vestigial row, not wired up** (David,
2026-08-12, answering the question `meme-and-video-studio.md:268-275` raised
before this plan existed and Codex round 2 caught this plan answering on its
own). No route reads the row today — a repo-wide grep finds only the
migrations that seeded and later flipped it. Photo-upload meme creation is
therefore reclassified as an **identity prerequisite**, matching what the
code actually does.

The reasoning, recorded because the row looks superficially like it belongs:
its values are ✗/✓/✓/✓, so the only distinction it encodes is
unregistered-versus-registered — and that is already enforced one layer down,
since an upload needs an account to own the stored file and unregistered
users cannot save memes at all. Wiring it up would add a deny branch that is
unreachable in practice, and leave a checkbox on the grid that either does
nothing or, if anyone unchecked `registered`, would silently gut the core
personalization loop from the one screen whose whole promise is that it is
safe to configure at runtime. Every row in this grid should be a real dial.

This is the *consistent* outcome rather than an exception to it: commenting,
rating, and hearts are all gated registered-versus-unregistered and are
deliberately identity prerequisites for exactly this reason. Keeping the row
would have been the inconsistency.

**Left open deliberately:** if photo-upload memes ever become a Legendary
upsell, that is a real product decision with its own enforcement boundary to
design (covering direct `POST /storage/upload-meme` calls and reuse of
already-stored uploads, not just the client rule) — and adding the row back
is then one call to Plan 1b's creation function plus the gate. Retiring it
now forecloses nothing.

### One resolver

A new module — `artifacts/api-server/src/lib/featureAccess.ts` — is the only
code permitted to read the grid:

```
principal = { tier, isAdmin }   // isTester added by Plan 2; a principal
                                 // object rather than a bare tier string is
                                 // the seam Plan 2 and any future
                                 // impersonation work slot into

resolveEntitlements(principal) -> Map<featureKey, Entitlement>
  = merge( gridRows(principal.tier),
           principal.isAdmin ? gridRows('admin') : ∅ )

Entitlement = { allowed: boolean, limit: number | null }

can(principal, featureKey)      -> boolean
limitFor(principal, featureKey) -> number | null
requireFeature(featureKey)      -> express middleware
```

**`limit` is always `null` in this plan** — every feature here is boolean. The
shape is typed this way from the start because a boolean feature is the
degenerate case of a metered one, so Plan 2 extends a working shape instead of
migrating one, with no client-side breaking change when metered rows arrive.

**The `Map` is server-internal; the wire format is a plain object.**
`res.json()` serializes a native `Map` as `{}`, so the client contract
converts to `Record<FeatureKey, Entitlement>` at the HTTP boundary, and the
OpenAPI spec declares the field as an object with `additionalProperties: {
$ref: '#/components/schemas/Entitlement' }`.

**Principal construction normalizes the tier explicitly — it does not copy
`req.user`'s two fields.** `req.user.membershipTier` is never toggle-aware:
view-as-user flips `isAdmin` to `false` but leaves `membershipTier` at the
account's real paid tier (`authMiddleware.ts:122-140`). A naive `{ tier:
req.user.membershipTier, isAdmin: req.user.isAdmin }` would give a
legendary-holding admin in preview mode `{tier: "legendary", isAdmin: false}`
— which still resolves every Legendary feature, defeating Settled Decision #3.
So:

```
isAdmin = req.user.isRealAdmin && !session.adminModeDisabled
tier    = session.adminModeDisabled ? 'registered' : req.user.membershipTier
```

applied identically **everywhere** a principal is built, including the
snapshot persisted with queued work. The anonymous principal is `{tier:
'unregistered', isAdmin: false}`.

Also:

- **Union**, per Settled Decision #1: `allowed` ORs. No limit-merge case
  exists yet; Plan 2 adds "only enabled operands contribute a limit, more
  permissive wins."
- **One admin predicate.** Every inline check collapses to the principal's
  flag, built from `isRealAdmin` (stored column **OR** `ADMIN_USER_IDS` **OR**
  bootstrap email) — so env-granted and bootstrap admins stop silently losing
  entitlements, a defect present today in several of the checks being removed.
- **Fails closed** on a missing row, an unknown key, or a DB error.
- **`hasFeature(tier, key)` stops being exported.** It becomes module-private,
  and a CI guard (`scripts/check-permission-chokepoint.mjs`, wired into
  `build.yml` beside `check:docs` / `check:codegen-drift`) fails the build if
  any file outside `featureAccess.ts` references it, or if a product route is
  neither resolver-gated nor listed in the four-rail allowlist.

### The authorization snapshot for queued work

Deriving the principal in `authMiddleware` is necessary but not sufficient.
`createMemeRecord` and `videoPipelineRunner` take a bare `userId` and re-read
the stored admin flag for the **boolean** gates they own (PuLID, private
visibility), which cannot see session-scoped view-as-user state. Left alone,
an admin previewing as a registered user would bypass this plan's gates
through every background path.

**What travels must be the resolved decision, not only the principal.**
Persisting `{tier, isAdmin}` and calling `can()` at execution time still
resolves against whatever the grid says *then* — the opposite of Settled
Decision #8. So at enqueue time the caller resolves the specific feature
key(s) that job type gates and persists the **resolved boolean decision** for
each, alongside the principal. The background path reads the persisted
decision; it never calls `can()` again for a gate already decided at enqueue.

**The snapshot needs durable storage, and today's persistence is
best-effort.** `videoPipelineRunner.ts:482-509` wraps its `video_jobs` insert
in a `try`/`catch` that logs a warning and **proceeds with in-memory state
only** on failure. Adding the decision to in-memory `JobState` therefore
guarantees nothing: a restart loses it, and a job can run having never
recorded what authorized it. So:

- The snapshot is a column on `video_jobs` —
  `authorization_snapshot jsonb NOT NULL` — holding `{tier, isAdmin,
  decisions: {<featureKey>: boolean}, resolvedAt}`. It is part of the row, not
  a sidecar, so it cannot be written separately or partially.
- **Successful persistence becomes a precondition for starting the job**, not
  a best-effort side task. The existing `catch` that proceeds in-memory is
  replaced by a failure: no row, no job. This is a deliberate behaviour change
  to that path and is called out in *Runtime Behavior*.
- `createMemeRecord`'s equivalent decisions are resolved before the insert and
  written in the same statement as the meme row, which is already
  transactional.

**`aiMemePipeline` is NOT in this list.** A repo-wide check confirms it has no
feature gate and no stored-admin lookup — its only `usersTable` read is
`nsfwModeEnabled` (`aiMemePipeline.ts:37-41`), a **safety preference**, not an
authorization lookup. An earlier draft of this plan told the implementer to
thread decisions through all three modules and "delete their internal user
lookups," which applied literally would have deleted an NSFW safety read for
no reason. `aiMemePipeline` is untouched by this plan.

**`checkBudget` is also excluded.** Its entire job is numeric — the effective
tier's dollar limit, the admin spend exemption, and the per-user
`monthlyGenerationLimitOverrideUsd` override (`budgetGate.ts:78-101`) — all
explicitly Plan 2's territory. The `{tier, isAdmin}` principal has no limit to
give it and no boolean entitlement to resolve; threading it in would drop the
per-user override or change numeric behaviour this plan is not authorized to
change. It stays untouched, including its fail-open defect (tracked in #409).

### One client contract

The resolved entitlement map ships to the client, computed by the **same**
resolver the write paths use.

- **A typed map, not a bare `features: string[]`.** A string array can only
  say "allowed" — it cannot express Plan 2's `limit`.
- **Not nested inside the nullable user object.** `/auth/user` returns `{user:
  null}` when logged out, so entitlements hanging off `AuthUser` would leave
  every anonymous surface deriving or hardcoding, and any future
  `unregistered` grant would be unreachable. Entitlements are a **sibling
  field** of `user`, populated for authenticated and anonymous callers alike.

**Revalidation, and why it takes three pieces.** The server resolver's cache
has a TTL and the client payload is a snapshot taken at `AuthProvider` mount,
so an open tab could hold a stale lock indefinitely. The client polls a cheap
`GET /entitlements/version` and re-fetches the full payload when it moves. But
a bare version is not enough:

1. **The version must be durable and atomically advanced.** A new singleton
   table, `entitlement_grid_revision`, is incremented in the **same
   transaction** as every grid cell write. The resolver loads a feature's
   row-set and the current revision from **one snapshot**, so the two can
   never come from different instants; the cache entry and the payload are
   both stamped from that load. (Enforcing that no writer can skip the bump is
   Plan 1b's.)

2. **The version must also move when the *principal* changes.** A lapsing
   Legendary entitlement or an admin grant/revoke changes nothing about the
   grid, so a grid-only revision never tells an open client its own tier
   changed. `GET /entitlements/version` therefore returns `{gridRevision,
   principalFingerprint}`. The fingerprint is derived from the same `req.user`
   the handler already rebuilds from the database every request — no extra
   query — using the identical `{tier, isAdmin}` normalization the resolver
   applies.

3. **The payload must be correlated with *both* halves of that pair.**
   Stamping it with `gridRevision` alone leaves a real race: if the principal
   changes A → B during the fetch and back to A before the next poll, the
   pair looks unchanged and the client keeps entitlements computed for the
   transient principal indefinitely. So the payload carries **both**
   `gridRevision` and `principalFingerprint`, read from the same resolution,
   and the client retries until both match what it observed.

**The version endpoint is per-principal and must never be shared-cached.** It
varies by tier, admin grant, and session-scoped view-as-user state, so a
proxy or CDN caching it by URL could serve one principal's fingerprint to
another — and the second client, seeing a fingerprint it doesn't recognize as
its own change, may never converge. It is served `Cache-Control: private,
no-store` with `Vary: Cookie, Authorization`. "Cheap" here means a small
response and no grid query beyond the already-loaded revision, not
proxy-cacheable.

The client obeys the contract instead of deriving:

- `roleToTier` (`studioAdapter.ts:45-49`) — the PR #402 function — is deleted.
- The dozen verbatim `role === "legendary" || role === "admin"` derivations
  and the three contradictory upload rules collapse into `can('feature_key')`.
- The Features console stops being half-inert: granting `registered` a flag
  visibly changes the UI, because the UI reads the grid.
- `AuthUser` and the new sibling field are codegen-owned
  (`lib/api-spec/openapi.yaml` → `lib/api-zod`), added at the spec and
  regenerated — never hand-edited into `lib/api-zod/src/index.ts`, per that
  package's standing codegen-drift gotcha.

**Read gate and write gate must be one expression evaluated once.** Any gate
that renders a control from one check and validates the resulting write from
another recreates PR #402's shape. This plan introduces no such split; the
rule is stated because the CI guard and the resolver both exist to enforce it.

### The effective-avatar projection

The custom-avatar upsell needs a *read* answer as well as a write gate,
because the write gate alone leaves every existing selected photo and every
lapsed entitlement still on public display — and because three public
projections ignore `avatarSource` entirely today.

**One server-derived field, computed in one place:**

```
effectiveAvatarUrl(user) =
    user.avatarSource === 'photo'
    && user.profileImageUrl != null
    && can(principalOf(user), 'custom_avatar')
  ? user.profileImageUrl
  : generatedIconUrl(user.avatarStyle, user.id)
```

Three consequences worth stating:

- **It resolves the *subject's* entitlement, not the requester's.** Whose
  avatar is shown is governed by whether *that account* may have a custom one.
  Batch projections (`facts.ts`'s submitter and comment-author maps) resolve
  entitlements for the batch of user ids they already fetch, in one query, not
  per row.
- **`profileImageUrl` stays a private field.** It remains available to the
  studio and PuLID paths as the identity photo. What changes is that no
  *public* projection emits it directly — they emit `effectiveAvatarUrl`.
- **Lapse is handled for free, and no backfill is needed.** Because the
  projection is computed live, a user who selected a photo and later lapses
  reverts to the generated icon on the next read. No migration touches
  existing `avatarSource = 'photo'` rows.

Every public consumer moves to this field: `Navbar.tsx:49`,
`Profile.tsx:383`, `facts.ts:47,58` (submitter), `facts.ts:431,445` and
`:502` (comment author). The `facts.ts` sites gain an `avatarSource` check
they never had, which is the pre-existing leak noted under *Current
Behavior* being closed on the way past.

### Lockout and self-reference guards

Three guards, none of which exist today.

**1. An admin may not remove their own admin flag** (`PATCH
/admin/users/:id`).

**2. The effective active-admin count may never reach zero.** Stated over the
invariant, not over a list of endpoints: no `PATCH`/`DELETE` sequence,
including concurrent ones, may reduce the count of accounts that can actually
reach the console to zero.

*What counts as an admin, and what counts as removing one.* Both halves have
to match `authMiddleware`'s real predicate or the guard protects a different
population than the one that can log in:

- **The count is over all three grant mechanisms** — the stored `is_admin`
  column **OR** `ADMIN_USER_IDS` **OR** `BOOTSTRAP_ADMIN_EMAIL` — restricted
  to `is_active = true`. Today's admin listing query counts
  `eq(usersTable.isAdmin, true)` (`admin.ts:457`), the stored flag alone,
  which would undercount env- and bootstrap-granted admins and let the guard
  pass while zeroing the real population.
- **An email change is an admin-removing mutation.** `PATCH /admin/users/:id`
  accepts `email` (`admin.ts:272`), and `authMiddleware` derives real-admin
  status partly *from* the email. Changing the last bootstrap-email-only
  admin's address removes their admin status without touching `isAdmin` or
  `isActive` — invisible to a guard scoped to demotion, deactivation, and
  deletion. The guard therefore also runs for any email change that crosses
  the bootstrap boundary in either direction.
- **Deactivation counts too.** `authMiddleware` only resolves users with
  `is_active = true`, so switching off the last admin removes console access
  without touching the admin flag.

*Serialization.* A transaction alone does not deliver this. At `READ
COMMITTED`, two transactions demoting or deactivating *different* admin rows
both read a count of two, both conclude they are safe, and both commit,
leaving zero — the rows they write don't overlap, so nothing serializes them.
The guard takes a **transaction-scoped advisory lock**
(`pg_advisory_xact_lock`, on the same connection as the count and the write; a
session-level lock could outlive its transaction under this app's connection
pooling) before counting.

*Ordering — the check must run before irreversible cleanup, not just before
the final row write.* Both hard and soft delete run genuinely irreversible
external work — object-storage deletion, Stripe cancellation, session
revocation — *before* the DB mutation that removes admin access
(`admin.ts:468-650`). A guard on the final write would reject the last-admin
case correctly but only after the damage it exists to prevent.

*The reservation is a concrete early mutation.* It is `users.is_active =
false` on the target row, written inside the same advisory-lock transaction as
the count, before any cleanup step. That is the same column
`authMiddleware`'s query and the active-admin count already filter on, so a
concurrent request against a *different* admin immediately observes the
reduced count and can itself be rejected. Soft-delete's existing `deactivate`
stage already performs this write; the fix reorders it to run **first**, ahead
of `stripe`/`sessions`. Hard-delete gains a new first stage, `reserve`,
performing the identical write before `collect`/`membership`/`nullify`/
`delete`.

*Post-reservation failure must be resumable, and `currentStage` is not a
recovery mechanism.* It only labels the 500 response; nothing consumes it.
Once the reservation commits, a failure in any later stage leaves a
deactivated, partially-cleaned account, and a naive retry hits soft-delete's
`where(and(eq(id), eq(isActive, true)))` (`admin.ts:642-643`) — matching zero
rows and reporting 404 for an operation that is genuinely half-done. So:

- **An already-reserved target is a resumable operation, not a 404.** Both
  handlers treat "row exists and `is_active = false`" as *reservation present,
  continue cleanup* rather than "not found."
- **Re-running the guard on retry is safe by construction** — the count reads
  live `is_active`, and the target is already excluded, so a retry cannot
  double-decrement.
- **Each cleanup stage is idempotent**: object deletion tolerates a missing
  object, Stripe cancellation tolerates an already-cancelled subscription,
  session revocation tolerates no sessions. Where a stage is not already
  idempotent it is made so.
- Acceptance is a failure-injection test that fails each post-reservation
  stage in turn and retries the operation to completion.

**3. "View as user" gains a re-entry path — and the toggle route itself is
fixed, not just the UI.** The toggle control is gated on `realRole ===
'admin'` rather than the effective role, so it is reachable in both
directions, and `AdminLayout` shows a real admin in preview mode an
explanatory panel with a working toggle instead of "Access Denied." But
`POST /auth/toggle-admin-mode`'s own server-side check (`auth.ts:427-435`) is
`dbUser?.isAdmin || isAdminById(...)` — missing the `isAdminByEmail(...)`
clause `authMiddleware` already includes. A bootstrap-email-only admin passes
every other gate in this plan and then gets a 403 from the one route that lets
them leave preview mode, defeating the guarantee for exactly the account the
bootstrap carve-out protects. The route authorizes through the same resolution
as everywhere else, and the re-entry test covers all three grant mechanisms.

### Adjacent defects folded in

- `videos.ts` and `videoJobs.ts` resolve the `video_generation` boolean
  through one call, so turning the feature off in the grid turns it off on
  both routes. (The numeric daily-job-count cap is Plan 2's and is untouched.)
- `setTierFeature` validates the tier identifier against the real column set.
- `injectMembershipTier` (dead, never mounted) and the unreachable `render.ts`
  PuLID gate (its `imageTransform` parameter is never threaded through, so
  `mode` can never be `"pulid"`) are removed; PuLID access gets a real,
  reachable gate instead.
- **Five operational sites move to the privilege rail**: `jobs.ts` ×2,
  `affiliate.ts`, `GET /users/me`'s admin-notification projection
  (`users.ts:178-202`), and `PATCH /users/me/notifications`
  (`users.ts:372-385`) all move from re-reading `users.is_admin` directly to
  the canonical `isRealAdmin`/`realUserRole` resolution. Without this,
  `ADMIN_USER_IDS`- and bootstrap-granted admins can neither see nor change
  their own admin notification preferences — the same three-mechanism gap as
  the toggle route, at a second site. `facts.ts` does **not** join them: its
  check *is* the `comment_captcha_bypass` entitlement decision, which is
  supposed to honour the toggle under Settled Decision #3, so it collapses
  into a resolver call instead.
- `meme_rate_limit_high`'s grid description is corrected (it claims "100/hour
  instead of 10/hour"; the real behaviour is a 200-vs-30 daily save cap) —
  cosmetic, but wrong copy on the one screen this plan makes authoritative.

## Grid Intent Review

Every row is a capability the system already has; the question is only what
the grid should say about it. All values reproduce today's real behaviour
except the two accidental denials.

### Existing keys

| Feature | Current behaviour | Row (u/r/l/**a**) | Change |
|---|---|---|---|
| `comment_captcha_bypass` | legendary + admin skip comment captcha | ✗/✗/✓/**✓** | none — admin cell becomes live |
| `meme_private_visibility` | legendary + admin (post-#402) | ✗/✗/✓/**✓** | none — admin cell becomes live |
| `meme_rate_limit_high` | legendary only; **admins wrongly on free cap** | ✗/✗/✓/**✓** | **fixes an accidental denial**; description corrected; superseded by Plan 2's metered `daily_meme_saves` |
| `meme_ai_background` | legendary; **admins wrongly denied** on the dead render gate | ✗/✗/✓/**✓** | **fixes an accidental denial**; rewired to reachable routes |
| `video_generation` | legendary + admin, **cannot be switched off** | ✗/✗/✓/**✓** | grid toggle starts working; boot overwrite removed |
| `meme_upload_photo` | dead row — upload is authentication-only | **row deleted** | **retired** (David, 2026-08-12) — reclassified as an identity prerequisite; the row encoded only the registered-vs-unregistered distinction that authentication already enforces. No behaviour changes for anyone. |

**`engine_experiments` is explicitly untouched** — no rows, admin-only via a
hardcoded predicate. Plan 3 replaces it entirely.

### New keys

| Feature | Where it lives today | Row (u/r/l/**a**) |
|---|---|---|
| `meme_pulid_stylize` | `requireLegendary` on `pulidJobs.ts:172` + a role check in `createMemeRecord` | ✗/✗/✓/**✓** |
| `fact_submit_captcha_bypass` | legendary/admin short-circuits in `reviews.ts:136`, `ai.ts:336` | ✗/✗/✓/**✓** |
| `fact_submit_rate_limit_bypass` | legendary/admin short-circuit in `rateLimit.ts:184` | ✗/✗/✓/**✓** |
| `ads_free` | client-only, `AdSlot.tsx:21` — no server gate exists | ✗/✗/✓/**✓** |
| `custom_avatar` | client-only display checks; the selection write is unenforced | ✗/✗/✓/**✓** |

### How `custom_avatar` is enforced

**The gate is the display selection, never the photo upload.** `POST
/storage/upload-avatar` and `POST /users/me/profile-image` are not avatar-only
routes — they are the shared onboarding/profile-photo flow
(`Onboard.tsx:125-139` calls the latter to finish free photo onboarding), and
the resulting image is the identity photo PuLID meme and video generation
consume. Gating the upload would break free onboarding for every registered
user and remove a capability that is free today.

The paid capability is `usersTable.avatarSource` — `'avatar'` (generated icon,
the default) versus `'photo'`. **Uploading and storing a photo stays entirely
entitlement-free and the upload endpoint always succeeds.** The two write
paths that set `avatarSource` are gated differently, because one is bundled
with free onboarding and the other is a standalone request:

| Path | Unentitled caller | Why |
|---|---|---|
| `POST /users/me/profile-image` (`users.ts:551-565`) | **Succeeds**, photo stored, `avatarSource` left unchanged — the flip is silently skipped | The endpoint atomically bundles the upload with the flip, and `Onboard.tsx` calls it for free onboarding. A 403 here would fail onboarding for every non-paying registered user. |
| `PATCH /users/me` (`users.ts:282-286`) | **403** | A standalone, explicit selection request with no onboarding riding on it. |

Reading is governed by the effective-avatar projection above, so a user who
already has `avatarSource = 'photo'` without the entitlement — whether from
today's ungated writes or from a later lapse — simply stops being *shown*
that way, with no data migration.

Nothing else in this plan changes end-user-visible behaviour except the two
accidental admin denials being lifted, and the `facts.ts` avatar leak being
closed.

## Data Model and Migration Impact

### Schema

**`feature_flags` and `tier_feature_permissions` are unchanged** —
`key`/`tier`/`feature_key`/`enabled` already cover a boolean-only grid. Plan 2
adds `value_type`/`unit`/`min_value`/`max_value`/`limit_value` for metered
rows; introducing them here with nothing to populate them would be schema
built for an unapproved plan.

**Three new tables**, all small, all declarable in Drizzle:

1. **`tier_feature_permission_audit`** — the grid-mutation audit trail, which
   does not exist today (`setTierFeature` records only `updated_at`: no actor,
   no prior value). Columns: `id`, `actor_id` (FK to `users`, `ON DELETE SET
   NULL` so a later account deletion doesn't destroy the record), `tier`,
   `feature_key`, `enabled_before`, `enabled_after`, `created_at`.

   **`feature_key` is plain text with no foreign key**, deliberately. A live
   FK would either block feature deletion once any audit row referenced it
   (`NO ACTION`) or delete the history with the feature (`CASCADE`) — both
   wrong for an append-only history table. It is a denormalized historical
   fact, the same reasoning `actor_id`'s `SET NULL` applies to the actor: the
   record must survive its referent.

2. **`entitlement_grid_revision`** — the client contract's version source.
   `id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1)` and `revision bigint NOT
   NULL DEFAULT 0`, so a second row is rejected by the primary key and a
   wrong-keyed row by the check. Initialized `INSERT ... ON CONFLICT (id) DO
   NOTHING`, so clean install, re-run, and already-populated all converge. The
   bump is `UPDATE ... SET revision = revision + 1 WHERE id = 1 RETURNING
   revision`, issued inside each grid write's transaction; being a single-row
   update, concurrent writers serialize on the row lock and cannot produce the
   same revision.

3. **`feature_permissions_migration_log`** — the backfill's observable
   outcome; see *Migration*.

**`video_jobs` gains `authorization_snapshot jsonb NOT NULL`**, per *The
authorization snapshot for queued work*. Existing rows are backfilled with a
snapshot recording that they predate this plan, so the column can be `NOT
NULL` without a nullable interim state.

**Write-side enforcement is Plan 1b's, not this plan's.** This plan's code
writes the audit row and the revision bump in the same transaction as the cell
change. What it does *not* do is make that unbypassable — no sanctioned
functions, no triggers, no privilege revokes, no ownership runbook. Until 1b
ships, those invariants hold because this plan's code is the only writer, which
is a convention rather than a boundary. That is stated plainly rather than
overclaimed; closing it is exactly 1b's scope.

### Migration

Forward-only and idempotent. **One destructive step** — see below.

1. Create the three new tables and the `video_jobs` column; initialize the
   revision row; backfill existing `video_jobs` snapshots.
2. Insert the five new boolean `feature_flags` rows and their full four-row
   tier sets.
3. Correct `meme_rate_limit_high`'s description text.
4. **Delete `meme_upload_photo`** — its four `tier_feature_permissions` rows
   first, then the `feature_flags` parent, guarded by `IF EXISTS` so a re-run
   and an already-clean database both no-op. This is the only destructive
   statement in the plan.
5. Backfill any missing `(tier, feature_key)` combination among the
   remaining, non-`engine_experiments` features. `engine_experiments`'s
   missing rows are deliberately left alone — backfilling a feature Plan 3
   is about to retire is wasted work.

**The deletion is safe to do with plain SQL only because this migration
precedes Plan 1b's.** Once 1b ships, its deletion-protection trigger rejects
removing an individual `tier_feature_permissions` row for a feature that
still exists, and `delete_feature_flag` becomes the only sanctioned path.
That ordering already holds — 1b's migration fails fast if this plan's tables
are absent (see [1b's *Data Model*](./PLAN_FEATURE_GRID_WRITE_BOUNDARY.md)) —
but it is now load-bearing in a second way, so it is stated here rather than
left implicit. If for any reason 1b lands first, this step must go through
`delete_feature_flag` instead.

**The backfill's counts go to a durable table, not a channel the runner
discards.** The canonical runner (`lib/db/src/migrate.ts`) ignores statement
result rows, installs no notice handler, and skips an already-applied
migration by hash rather than re-executing it — so an in-migration `SELECT` or
`RAISE NOTICE` is invisible on a normal run, and a real re-run never happens.
Instead the backfill writes one row into
`feature_permissions_migration_log`, with **three separate counts**, because
the three outcomes answer different questions and a combined number answers
neither:

| Column | Answers |
|---|---|
| `inserted_count` | How much drift was actually repaired |
| `already_complete_count` | Whether the database was clean going in |
| `engine_experiments_skipped_count` | Whether the deliberate exception was honoured |

Plus `id`, `migration_name`, `ran_at`, and `deleted_rows jsonb` (the
`meme_upload_photo` rows captured before deletion, per *On the one deletion*
below). Idempotency is proved by an integration
test that calls the backfill's exported function **twice** in one test —
bypassing the runner's skip-by-hash gate, which a normal deploy never does —
asserting the second call logs `inserted_count = 0` while the other two are
unchanged.

**`seed.ts:531-545`'s startup `INSERT`s for `video_generation` are deleted
outright.** They are redundant with the grid rows this migration guarantees,
and one of them (`DO UPDATE SET enabled = EXCLUDED.enabled`) actively
overwrites operator toggles on every boot, which is why `video_generation`
cannot be switched off today. Deleting both steps is the fix; changing one to
`DO NOTHING` would leave a second competing write path into the tables this
architecture is giving exactly one.

**Row-state matrix:** *new* key → insert; *existing and complete* → no-op;
*existing and partial* → fill gaps only; *`meme_upload_photo`* → delete
(children then parent, `IF EXISTS`); *already-deleted* → no-op; *re-run* →
no-op throughout.

**On the one deletion.**
[`migrations-and-backfills.md:120-121,153`](../engineering/migrations-and-backfills.md)
requires that anything destructive carry an explicit recovery/rollback
description, so here it is. The five rows removed belong to a feature no code
reads, so nothing can regress from their absence. **Recovery is a single
forward insert** re-creating the parent and its four tier rows — and to make
that answerable from the database rather than from this document, the
migration captures the five rows into a `deleted_rows jsonb` field on this
run's `feature_permissions_migration_log` row *before* deleting them. No
separate backup artifact is warranted at five rows of configuration.

## Runtime Behavior

- An anonymous request resolves the `unregistered` row-set.
- A registered user resolves their tier's row-set.
- An admin resolves their tier's row-set unioned with the admin row-set.
- **An admin in "view as user" mode resolves as `registered`** for every
  feature this plan covers. They still reach the admin console and can always
  leave the mode.
- A grid toggle takes effect within the resolver's cache TTL, per process — a
  real, stated property. The admin UI's current "changes take effect
  immediately" copy is corrected to name the window; writes bust the cache in
  the writing process.
- Any resolution failure denies.
- **A video job whose authorization snapshot cannot be persisted does not
  start.** This replaces today's behaviour, where a failed `video_jobs` insert
  logs a warning and the job proceeds in memory. It is the one place this plan
  makes a previously-tolerant path strict, and it is deliberate: a job running
  with no record of what authorized it is exactly what Settled Decision #8
  exists to prevent.

**Edge case:** a user whose paid entitlement lapses mid-session resolves the
lower row-set on their next request, because the principal is rebuilt from
`effectiveTierExpr()` every request. Their avatar reverts on the same request,
via the effective-avatar projection. Both unchanged from today's tier
behaviour.

## Admin/User UX Impact

- **Features console.** Renders as today — a checkbox per (tier, feature) cell
  — but the Admin column genuinely changes behaviour, five new rows appear,
  and one dead row (`meme_upload_photo`) disappears. The column header states
  that admin values *add to*, never replace, the user's tier.
  (Value-type-aware rendering, grouping, and the Unlimited state are Plan 2's
  UI work.)
- **Every user-facing lock becomes truthful.** Controls the server would allow
  stop being hidden; controls the server would reject stop being offered.
- **View-as-user gains an exit** — an explanatory panel with a working toggle
  instead of "Access Denied."
- **The custom-avatar upsell becomes real.** An unentitled user's standalone
  selection is rejected with an upgrade prompt rather than a bare error; their
  onboarding upload still succeeds silently.
- **Submitter and comment avatars become correct.** Users who uploaded an
  identity photo without selecting it as their avatar stop having it shown
  publicly beside their submissions and comments.
- **No other end-user-visible capability changes** except the two accidental
  admin denials being lifted, which affect admins only.

## Security, Permissions, and Validation

- Every gate fails closed.
- Operational routes keep `requireRole` on `realUserRole`, now enforced
  consistently at the five sites that previously read the toggle-aware flag.
- Ownership checks are untouched and explicitly out of the grid. Admins may
  *view* any ordinary meme but not *act* on one they don't own outside their
  granted moderation privileges. Quarantined/restricted evidence stays
  categorically excluded from admin viewing.
- **Grid mutations are audited** — actor, tier, feature, old and new
  `enabled`, timestamp. The prior value is read under a row lock before being
  recorded, so two concurrent edits to the same cell produce two honest
  transitions rather than both recording the same stale "before." Failed
  writes produce no audit row.
- The grid editor validates the tier identifier and feature existence
  server-side; client-side constraints are not a control, since the API is
  reachable directly.
- The lockout guards return explicit errors rather than silently no-op'ing.
- **No new trust boundary.** The client-visible entitlement map is a
  projection of a server decision, never an input to one — the server
  re-resolves every request and never trusts a client-supplied claim.
- **The entitlement version endpoint is never shared-cached** (`private,
  no-store`), so one principal's state cannot be served to another.

## Testing Plan

Runner commands per `docs/tests/testing-guide.md`:
`pnpm --filter @workspace/api-server test`, `pnpm --filter @workspace/db test`,
`pnpm --filter @workspace/overhype-me test`.

The invariant tests, not just the reported examples:

1. **Union semantics** — for every boolean key, an admin resolves ⊇ what their
   own tier alone resolves. Table-driven over the whole grid.
2. **The PR #402 regression, generalised as own-tier monotonicity.** Adding
   the admin overlay never makes an account worse off. PR #402 itself is kept
   as a named regression case.
3. **Every consulted key is reachable, and no orphans remain** — every key
   referenced in code exists in the grid with a complete four-row set, and
   every grid key (except `engine_experiments`) is referenced in code. This
   is the test that would have caught `meme_upload_photo` originally, and it
   now fails if any future migration reintroduces an unread row. Includes an
   explicit assertion that `meme_upload_photo` and its four tier rows are
   gone, and that a re-run of the deletion no-ops.
4. **Fail-closed** — DB error, unknown key, and missing row each deny, for
   every gate.
5. **View-as-user** — feature gates drop to `registered`; `requireRole` gates
   do not; the toggle is reachable in both directions, for all three
   admin-grant mechanisms.
6. **Lockout guards, over the real admin population.** Self-demotion refused.
   The active-admin count cannot reach zero via any single or concurrent
   combination of demotion, deactivation, deletion, **or an email change that
   crosses the bootstrap boundary** — run for each of the three grant
   mechanisms, including an account that is an admin *only* by
   `ADMIN_USER_IDS` and one *only* by bootstrap email. A deterministic
   concurrent test proves two operations against *different* admin rows
   cannot both commit.
7. **Client/server agreement** — the client's rendered lock state for each
   capability is asserted against the server's answer for the same principal,
   so a future divergence fails CI rather than shipping.
8. **Negative cases throughout** — unregistered, anonymous, and
   lapsed-legendary principals for each gate.
9. **View-as-user reaches the background paths** — end-to-end through each
   pipeline and queued-job path, proving an admin previewing as registered is
   treated as registered by background work. Run for a registered-admin and a
   legendary-admin.
10. **Row-set completeness at the application level** — the migration leaves
    every non-`engine_experiments` feature with four rows, and the resolver
    denies for a feature whose row-set is incomplete. (That the *database*
    rejects an incomplete write is Plan 1b's test.)
11. **Grid-editor safety** — invalid direct API writes leave the cell
    unchanged; every successful change is attributed in the audit trail and
    every rejected one writes nothing.
12. **Client contract completeness** — logged-out clients consume every
    `unregistered` value without fabricating a user; an open client converges
    on a grid change within the advertised window without a reload.
13. **The custom-avatar gate is at the selection boundary, and the two write
    paths fail differently by design.** A registered user uploads and stores a
    photo via both upload routes without any entitlement, every time. Their
    `POST /users/me/profile-image` returns 200 with the photo stored and
    `avatarSource` unchanged. Their direct `PATCH /users/me {avatarSource:
    'photo'}` returns 403. A legendary or admin account succeeds via both.
14. **The effective-avatar projection covers every public consumer.** A user
    with `avatarSource = 'photo'` but no entitlement — a legacy row and a
    lapsed account, tested separately — shows the generated icon in the
    navbar, on their profile, as a fact submitter, and as a comment author. A
    user with a stored photo but `avatarSource = 'avatar'` shows the generated
    icon in all four places (the pre-existing `facts.ts` leak). An entitled
    user with a selected photo shows the photo in all four. `profileImageUrl`
    remains readable by the studio path throughout.
15. **The lockout guard blocks before cleanup, and post-reservation failure
    resumes.** A last-admin hard-delete and soft-delete are both rejected
    before any object-storage or Stripe call — asserted by observing no such
    call, not merely an unchanged row. A failure injected into each
    post-reservation stage in turn is retried to completion, with the
    already-reserved target recognized as resumable rather than 404, and the
    active-admin count not double-decremented.
16. **Entitlement payload/version correlation, over the full pair.** A client
    that observes a version bump but receives a payload computed from the
    prior revision retries and converges. A principal that changes A → B
    during the fetch and returns to A before the next poll does **not** leave
    the client holding B's entitlements — the payload's own fingerprint
    mismatches and forces a retry.
17. **Principal-change invalidation** — a tier lapsing, an admin
    grant/revoke, and a view-as-user toggle each change `principalFingerprint`
    though the grid does not move; an open client observes it and refetches.
18. **The version endpoint cannot cross principals** — two concurrent
    sessions with different principals each receive their own fingerprint, and
    the response carries `private, no-store`.
19. **The authorization snapshot is durable, or the job does not start.** A
    `video_jobs` insert failure starts no job (replacing today's proceed-in-
    memory behaviour); a persisted job keeps its submission-time decision and
    completes even after the grid revokes the feature; and a restart between
    enqueue and execution preserves the decision.
20. **Migration observability** — the backfill logs all three counts; a second
    direct invocation logs `inserted_count = 0` with the other two unchanged.

Manual QA is the UAT doc, covering the admin and non-admin experience of each
changed surface.

## Implementation Steps

One PR. Nothing below is independently shippable on its own; a phase boundary
here would be a further plan split, not an implementation detail.

1. Add `featureAccess.ts` with `resolveEntitlements` / `can` / `limitFor` /
   `requireFeature`; make `hasFeature` module-private.
2. **Classify every product route** into the four rails and check the
   classification in as the allowlist the CI guard reads.
3. Migration: the three new tables, the `video_jobs.authorization_snapshot`
   column and its backfill, the revision row's initialization, the five new
   boolean features and their row-sets, the description fix, and the row
   backfill excluding `engine_experiments` with its three logged counts, and
   the `meme_upload_photo` deletion (children then parent, captured into
   `deleted_rows` first). Delete `seed.ts:531-545` outright.
4. Move all six existing grid call sites and the five `requireLegendary`
   product routes onto `requireFeature` / `can`; collapse `facts.ts`'s
   role-OR-grid expression into one resolver call. Add the named, temporary
   CI-guard exception for `GET /engines`.
5. Move the hardcoded role-rank product gates (PuLID, the two fact-submit
   bypasses, ad-free) onto the resolver. Add `custom_avatar`: `PATCH
   /users/me` rejects an unentitled `avatarSource: 'photo'`; `POST
   /users/me/profile-image` stores the photo and skips the flip. Neither
   upload route is gated. Classify photo-upload meme creation as an identity
   prerequisite in the allowlist — no gate is added for it.
6. Add the effective-avatar projection and move all five public consumers onto
   it (`Navbar.tsx`, `Profile.tsx`, `facts.ts` ×3), with batch resolution for
   the two `facts.ts` maps.
7. Move the five mis-railed operational sites (`jobs.ts` ×2, `affiliate.ts`,
   `GET /users/me`'s notification projection, `PATCH
   /users/me/notifications`) onto `realUserRole`. Fix
   `POST /auth/toggle-admin-mode` to include the `isAdminByEmail` path.
8. **Thread the principal and resolved decisions** through `createMemeRecord`
   and `videoPipelineRunner`, persisting them with queued work and making
   persistence a precondition for starting a job. **`aiMemePipeline` and
   `checkBudget` are untouched** — see *The authorization snapshot*.
9. Fix the adjacent defects listed under *Proposed Design*.
10. Lockout guards: the advisory-lock-serialized active-admin invariant over
    all three grant mechanisms and all four mutation kinds; the reservation
    ordering and resumable post-reservation cleanup; the view-as-user re-entry
    path and `AdminLayout` panel.
11. **The client contract**: `Record<FeatureKey, Entitlement>` as a sibling of
    `user`, populated for anonymous callers, carrying both `gridRevision` and
    `principalFingerprint`; `/entitlements/version` returning the pair with
    `private, no-store`; the client retrying until both match. Added at the
    spec, regenerated, verified against codegen immediately per the
    `lib/api-zod` gotcha. Delete `roleToTier` and the duplicated derivations;
    reconcile the three upload rules.
12. Grid-mutation audit trail, locked-read cell writes, and the revision bump
    in the same transaction.
13. CI guard script + `build.yml` wiring.
14. Tests 1-20.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| A capability is missed and keeps an inline role check | The CI guard fails the build on any inline role comparison in a product-feature path, or any unclassified route; test 3 catches unreachable or unreferenced keys |
| The union grants an admin something an operator meant to deny | Union is deliberate (Settled Decision #1); the Admin column is editable, so denial is one toggle away for any feature the account's own tier doesn't already grant |
| A grid misconfiguration disables a capability broadly | Cannot affect console access by construction; every row's migration default reproduces today's behaviour, so day-one risk is zero |
| The cache window makes a toggle look broken | The window is stated in the UI copy; writes bust the cache in the writing process |
| Codegen silently reverts the new `AuthUser` sibling field | Verify against codegen immediately per the `lib/api-zod` gotcha; `check:codegen-drift` is the CI guard |
| Making video-job persistence strict rejects jobs that would have run | Deliberate (see *Runtime Behavior*); the failure it replaces is a job running unauthorized-of-record, and test 19 covers both directions |
| The effective-avatar projection adds a per-row query to fact listings | Batch-resolved per request over the user ids already fetched, not per row; test 14 covers correctness and the existing listing tests cover shape |
| Grid invariants hold only by convention until Plan 1b ships | Stated plainly rather than overclaimed; this plan's code is the only writer, and 1b (PR #422) is what makes it a boundary |
| Scope creep back toward the combined plan | *Must Not Change* names every excluded piece; a reviewer finding drift into Plan 1b/2/3 territory is a Required Revision |

## Questions for David

**None.** The one that stood — `meme_upload_photo`'s classification — was
answered on 2026-08-12: retire the row, reclassify photo-upload meme creation
as an identity prerequisite. The reasoning is recorded under *Proposed
Design*, including what would reopen it (making photo-upload memes a
Legendary upsell, which is a separate product decision with its own
enforcement boundary).

Everything else was settled in the direction (#412) or the original PR #404
conversation. The scope boundaries — Plan 1b, Plan 2, Plan 3 — were David's
own calls.

## Definition of Done

- Every existing product-feature permission check resolves through
  `featureAccess.ts`; the CI guard proves no others exist and every route is
  classified.
- The Admin column is live for every boolean feature, and toggling a cell
  changes behaviour for any principal for whom that overlay is decisive (an
  admin whose own tier already grants a feature sees no change from toggling
  Admin off — the union working correctly, not a bug).
- The grid contains every capability previously gated by an inline role check,
  as a boolean row, fully populated across all four columns — and contains no
  row that no code reads (`meme_upload_photo` deleted; `engine_experiments`
  the one declared, Plan-3-owned exception).
- No client surface derives a permission it was not told; the entitlement
  payload is the sole input to every lock/unlock decision in scope, and stays
  correlated with both halves of the version pair.
- An admin cannot demote themselves, cannot be the last admin removed by any
  sequence — including an email change and including concurrent ones — and can
  always leave view-as-user mode.
- Every public avatar consumer reads the effective-avatar projection; the
  identity photo remains available to the studio.
- Queued work carries a durably-persisted authorization decision, or does not
  start.
- `docs/ai-context/` updated: `membership-entitlements.md`'s reader-inventory
  caveat, `accounts-and-auth.md`'s role-derivation section, `admin-console.md`'s
  Features entry, and `known-failure-patterns.md`'s entitlement-gate entry all
  point at `featureAccess.ts` as the chokepoint.
- TEST_RUN + UAT docs shipped in the same PR.
- **Explicitly not done here, by design:** the grid's write-side enforcement
  (Plan 1b), numeric limits and the `tester` overlay (Plan 2), engine bands
  (Plan 3), and the two standalone bugfixes (#409, #410) — all tracked
  separately, none blocking this plan's approval or merge.
