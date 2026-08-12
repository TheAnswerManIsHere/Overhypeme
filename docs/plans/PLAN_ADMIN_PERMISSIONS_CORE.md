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
grid or account edits. Numeric per-tier limits, the `tester` overlay, and
engine access by band are **not** built here — they are Plan 2 and Plan 3,
cited below, and this plan is fully correct and independently shippable
without them.

## Product Intent

What this increment delivers, restated from the direction:

1. **Every existing product-feature permission check** resolves through one
   function, which consults the Feature Permission Grid and nothing else. No
   `unless admin` exceptions anywhere in application code.
2. **The Admin column in the grid becomes live** — it is read at runtime, and
   toggling it changes what admins can do, with no deploy.
3. **The client stops deriving permissions.** It is told what the user may
   do, for every boolean feature that exists today.
4. **An admin cannot be locked out** by demotion, deletion, deactivation, or
   the "view as user" toggle, under any sequence including concurrent ones.
5. **Every capability currently gated by an inline role check** (not just the
   ones already in the grid) moves into the grid as a boolean feature, so the
   grid is a complete picture of *boolean* entitlements. Numeric limits stay
   out of scope for this increment — see *Must Not Change*.

## Must Not Change

- **Numeric per-tier limits are not touched.** Spend budgets, upload caps,
  save caps, rate limits, and `resourceGovernance`'s policy table stay exactly
  as they are today, including their existing bugs — those are Plan 2's
  scope, cited under *Direction*. Two of those bugs (the fail-open spend gate,
  two ungated video parameters) are tracked and fixed independently via the
  bugfix lane (#409, #410), not by this plan.
- **`engine_experiments` and `engines.tierRequirement` are not touched.**
  They stay exactly as broken as they are today (dead grid rows, a hardcoded
  admin-only predicate). Plan 3 replaces them with band-based access. This
  plan must not partially fix or partially migrate them.
- **The per-user spend override (`users.monthly_generation_limit_override_usd`)
  is not touched.** It is replaced by the `tester` role in Plan 2, not here.
- **Backend authorization for operational privileges never honours the admin
  "view as user" toggle.** `requireRole`/`requireAdmin` stay on
  `realUserRole`. (Feature gates deliberately *do* honour the toggle — see
  Settled Decisions — but console/admin-route access does not.)
- **`req.user` stays rebuilt from the database on every authenticated
  request.** Role, admin, and membership are never trusted from the session
  blob. (security-model.md invariant #3.)
- **`users.membership_tier` stays derived, never assigned.** This plan does
  not touch the entitlement model — no new writer of that column, and the
  effective-tier expression (`effectiveTierExpr()`) remains the read path.
- **Every gate continues to fail closed.** A missing grid row, a DB error, or
  an unknown feature key denies. No permission check may fail open.
- **The three admin-flag grant paths stay as they are**: the stored
  `users.is_admin` boolean, the `ADMIN_USER_IDS` env allowlist, and the
  `BOOTSTRAP_ADMIN_EMAIL` hardcoded bootstrap.
- **Ownership checks are not permissions in this sense and do not move into
  the grid.** "May I edit *my own* meme" is a resource-ownership question, not
  an entitlement one.
- **No rollout-flag gating.** Per the working rules, this ships as the new
  behavior, not behind a toggle.
- **Impersonation is out of scope** — deferred at the direction level.

## Settled Decisions

Inherited from the direction (#412) and the pre-plan conversation; not
re-litigated here.

1. **Admin resolution is a UNION, never an override.** A user's feature set is
   `features(their tier) ∪ (isAdmin ? features('admin') : ∅)`. An admin who
   also holds a paid Legendary entitlement therefore never *loses* a feature
   by being an admin.
2. **Operational privileges are NOT grid features.** Admin console access,
   user management, moderation actions, config editing, and the grid editor
   itself stay on `requireRole('admin')`. This is what makes admin lockout
   impossible by configuration — nothing that grants console access lives in
   the grid.
3. **"View as user" becomes honest and normalizes to `registered`** — not
   merely "the account's own tier minus the admin overlay." A legendary-
   holding admin previewing as a user genuinely experiences a registered
   account, for every feature this plan covers. Operational privileges
   continue to ignore the toggle, so an admin can never lock themselves out
   of the console mid-preview, and a working re-entry path is added (none
   exists today).
4. **The wrong call must become impossible, not merely discouraged.** A
   tier-keyed `hasFeature(tier, key)` reachable from route code is how the
   PR #402 bug class reproduces. The tier-keyed lookup is confined to the
   resolver module, and a CI guard fails the build if application code calls
   it directly, or if a product route is neither resolver-gated nor
   classified in the allowlist below.
5. **Every product route is classified into exactly one of four rails**:
   entitlement (grid), privilege (role check), identity prerequisite
   (authentication only — commenting, rating, hearts, share intents — not
   configurable, not in the grid), or deliberately public (declared, not
   inferred from an absent gate — browsing without an account is core product
   behaviour). The classification is checked in as an allowlist; the CI guard
   requires an approved form rather than hunting for bad ones.
6. **The client is told its entitlements; it never derives them.** The
   resolved set ships as a typed map, a sibling of the (possibly null) user
   object so anonymous callers get a projection too.
7. **Admins may view any ordinary content but not act on content they don't
   own**, outside their granted moderation privileges — confirmed intended.
   Quarantined/restricted CSAM-abuse evidence is categorically excluded from
   admin viewing regardless of this rule (`legal-safety-moderation.md` wins
   any conflict; not touched by this plan in any case, since it has no admin
   viewer today and this plan adds none).
8. **Queued work is authorized as of submission, not execution** — the
   resolved principal is persisted with the job rather than re-derived at
   completion. Accepted consequence: a feature revoked while a job is
   in-flight still completes that one job.

## Repo Context Inspected

Same three exhaustive sweeps that informed the original combined plan
(backend authorization gates, client-side gates, grid/config data) — see
`docs/ai-context/known-failure-patterns.md`'s entitlement-gate entry and
`membership-entitlements.md`'s reader-inventory section for the durable
record. Additionally re-inspected for this scoped plan:
`artifacts/api-server/src/lib/tierFeatures.ts`, `lib/userRole.ts`,
`middlewares/tierMiddleware.ts`, `middlewares/authMiddleware.ts`,
`lib/createMemeRecord.ts`, `routes/admin.ts` (user PATCH), `routes/auth.ts`
(admin-mode toggle), `lib/db/src/schema/featureFlags.ts`, migrations `0013`/
`0028`/`0029`/`0057`, `artifacts/overhype-me/src/pages/admin/features.tsx`,
`routes/storage.ts:77-90`, `routes/users.ts:524-526` (avatar write paths).

## Current Behavior

### The grid's actual contents (boolean features only — this plan's scope)

| Feature key | unregistered | registered | legendary | admin | Read by code? |
|---|---|---|---|---|---|
| `comment_captcha_bypass` | false | false | true | true | yes |
| `meme_ai_background` | false | false | true | true | yes — **admins wrongly denied** |
| `meme_private_visibility` | false | false | true | true | yes |
| `meme_rate_limit_high` | false | false | true | true | yes — **admins wrongly on the free cap** |
| `meme_upload_photo` | false | true | true | true | **no — fully orphaned** |
| `video_generation` | false | false | true | true | yes — **cannot actually be switched off** |
| `engine_experiments` | no row | no row | no row | no row | no — **out of scope, Plan 3** |

`meme_rate_limit_high` and `meme_ai_background`'s accidental admin denials are
both fixed by this plan's resolver alone — the grid's admin row for each is
already `true`, and today's bug is only that no code path ever queries it. No
numeric work is needed to fix them.

### The backend: role-hierarchy code outside the grid

Roughly a dozen capabilities are gated by an inline role comparison
(`isAtLeastLegendary(role)`, `requireLegendary`, ad hoc `isAdmin` checks) with
no grid row at all: PuLID-stylised memes, fact-submit CAPTCHA bypass,
fact-submit rate-limit bypass, ad-free browsing, and the custom-avatar
capability (see below). Three operational sites — `jobs.ts` ×2,
`affiliate.ts` — accidentally read the toggle-aware `isAdmin` instead of
`realUserRole`, which is the wrong rail for privileges.

### The frontend: the client never learns what it may do

No user-facing API response carries an entitlement; `AuthUser` and
`UserProfile` carry role and tier only. The grid is visible to exactly one
client surface (`/admin/features`), which edits it, never obeys it.
Consequences in this plan's scope: roughly a dozen verbatim
`role === "legendary" || role === "admin"` derivations, the `roleToTier`
function implicated in PR #402, and three contradictory upload-gating rules
across the meme builder generations (registered / legendary / registered).

### The admin lockout is real, and it is live

Confirmed by direct inspection: all three client call sites for
`POST /auth/toggle-admin-mode` are gated on admin mode already being on, so
once an admin turns "view as user" on, no UI anywhere can turn it back off.
`AdminLayout` compounds this by showing a real admin in that state an "Access
Denied" screen. This is the self-reference lockout David anticipated, and it
exists today.

### The custom-avatar entitlement is display-only, not enforced

A tier privilege framed as an upsell (David, 2026-08-11): lower tiers get a
non-configurable generated icon; setting a custom avatar image is meant to be
a paid unlock. Today it is enforced **only** on the client
(`Navbar.tsx:46`) — the write routes, `POST /storage/upload-avatar`
(`routes/storage.ts:77-90`) and `POST /users/me/profile-image`
(`routes/users.ts:524-526`), are authentication-only. A registered user
calling either route directly can set and have served a custom avatar; the
UI simply declines to render it as such. The incentive is decorative until
the write path is gated.

## Source-of-Truth Analysis

| Concept | Source of truth today | Source of truth after |
|---|---|---|
| What boolean features a tier gets | `tier_feature_permissions` (partial — code carries the admin half) | `tier_feature_permissions`, whole |
| What boolean features an admin gets | Scattered application-code exceptions | `tier_feature_permissions` `admin` rows, unioned |
| Whether someone may operate the system | `requireRole('admin')` on `realUserRole` | unchanged |
| A user's membership tier | `effectiveTierExpr()` over entitlement sources | unchanged |
| Whether someone owns a resource | Per-route ownership checks | unchanged |
| What the client believes is permitted | Client-side derivation from role | Server-sent resolved entitlement map |
| Numeric per-tier limits | `admin_config` + code constants | unchanged — Plan 2 |
| Engine access | Hardcoded admin-only predicate | unchanged — Plan 3 |

No new source of truth is created. The grid already exists and already holds
admin rows; this plan makes the existing rows reachable and removes the
shadow copy in application code.

## Proposed Design

### Two rails, kept apart, plus two more that were missing

| | **Entitlement** | **Privilege** | **Identity prerequisite** | **Deliberately public** |
|---|---|---|---|---|
| Answers | "What product features does this account get?" | "What may this account do *to the system*?" | "Are you signed in at all?" | "Nothing — anyone may do this" |
| Source of truth | The grid | `requireRole` on `realUserRole` | `req.isAuthenticated()` | the allowlist entry itself |
| Runtime-editable | Yes, no deploy | No — code | No | No |
| Honours "view as user" | Yes | No | n/a | n/a |
| Examples | private memes, video generation, custom avatar | admin console, user management, moderation | commenting, rating, hearts | `GET /facts`, public meme permalinks |

Keeping entitlements and privileges apart is what makes admin lockout
structurally impossible: nothing that grants console access lives in the
grid, so no grid configuration can lock an admin out.

**Identity prerequisites and deliberately-public routes are a genuine third
and fourth category, not a gap in the first two.** A large set of product
capabilities is gated only by "are you signed in," with no role and no
feature key anywhere near them — commenting, rating, hearts, share intents.
Granting these to `unregistered` is incoherent (they write rows owned by a
user id that would not exist), so they don't belong in the grid, but they
also aren't privileges. Separately, browsing without an account (`GET
/facts`, `GET /hashtags`, public meme permalinks) is core product behaviour
that must stay reachable — the CI guard below would otherwise have to reject
valid routes or force an authentication gate onto public browsing. Both
categories must be **declared** in the allowlist, never inferred from an
absent gate, so an accidentally ungated mutation still fails the guard.

`meme_upload_photo` is resolved into this frame deliberately: it stays a
**grid feature**, because unlike commenting it is a capability David may
genuinely want to withhold from a tier, and the grid already carries the row.
Its authentication-only siblings are recorded as identity prerequisites.

**The allowlist needs a fifth entry, or the CI guard rejects code this plan
deliberately leaves alone** (added — Codex round 1, line 720, verified
against `videos.ts:820`). `GET /engines`'s catalogue filter is an inline
`realUserRole === "admin"` product-feature check today — exactly the pattern
the CI guard exists to catch. But *Must Not Change* is explicit that
`engine_experiments` and engine access stay untouched until Plan 3 replaces
this predicate with band-based access; this plan must not fix it partially
along the way. So the allowlist carries one **named, temporary exception**:
`GET /engines`'s catalogue-filter predicate, tagged as deferred-to-Plan-3,
excluded from the inline-role-check guard specifically and only for that one
site. This is not a general escape hatch — a *new* inline check anywhere
else still fails the build; only this one, already-known, already-scoped-
elsewhere check is grandfathered, and the exception is removed as part of
Plan 3's own implementation, not silently left in the guard forever.

### One resolver

A new module — `artifacts/api-server/src/lib/featureAccess.ts` — is the only
code permitted to read the grid:

```
principal = { tier, isAdmin }   // isTester added by Plan 2; the shape is
                                 // deliberately extensible via this object,
                                 // not a bare tier string, for that reason

resolveEntitlements(principal) -> Map<featureKey, Entitlement>
  = merge( gridRows(principal.tier),
           principal.isAdmin ? gridRows('admin') : ∅ )

Entitlement = { allowed: boolean, limit: number | null }   // limit is always
                                                             // null in this
                                                             // plan — every
                                                             // feature here
                                                             // is boolean

can(principal, featureKey)      -> boolean
limitFor(principal, featureKey) -> number | null            // returns null
                                                             // for every key
                                                             // this plan
                                                             // introduces;
                                                             // Plan 2 is what
                                                             // gives it a
                                                             // non-null case
requireFeature(featureKey)      -> express middleware
```

**The entitlement shape is typed `{allowed, limit}` from the start**, even
though `limit` is always `null` in this plan. A boolean feature is the
degenerate case of a metered one, and defining the type this way now means
Plan 2 extends a working shape instead of migrating one — no redefinition,
no client-side breaking change when metered rows arrive.

- **`principal` construction normalizes the tier explicitly — it does not
  copy `req.user`'s two fields** (corrected — Codex round 1, line 325,
  verified against `authMiddleware.ts:122-140`). `req.user.membershipTier`
  is **never** toggle-aware: view-as-user flips `isAdmin` to `false` but
  leaves `membershipTier` at the account's real paid tier untouched. A naive
  `{ tier: req.user.membershipTier, isAdmin: req.user.isAdmin }` would give a
  legendary-holding admin in preview mode `{tier: "legendary", isAdmin:
  false}` — which still resolves every Legendary feature, silently
  reintroducing the exact bug Settled Decision #3 exists to prevent. This is
  the same defect class the original combined plan's round 2 already caught
  and fixed; it was dropped when this plan was extracted from that one, and
  is restored here as the authoritative statement.

  Principal construction is therefore: `isAdmin = req.user.isRealAdmin &&
  !session.adminModeDisabled` (unchanged), and **`tier =
  session.adminModeDisabled ? 'registered' : req.user.membershipTier`** — an
  explicit override, applied identically wherever a principal is built,
  including the snapshot persisted with queued work below. The anonymous
  principal is `{tier: 'unregistered', isAdmin: false}` when there is no
  session. Taking a principal object rather than a tier string is deliberate
  beyond this fix: it is the seam both Plan 2's `isTester` and any future
  impersonation work slot into without changing every call site's signature
  again.
- **Union**, per Settled Decision #1: `allowed` ORs; since every feature in
  this plan is boolean, there is no limit-merge case to specify yet (Plan 2
  adds "only enabled operands contribute a limit, more permissive wins").
- **One admin predicate.** Every inline check collapses to the principal's
  flag, which is built from `isRealAdmin` in `authMiddleware` (stored column
  **OR** `ADMIN_USER_IDS` **OR** bootstrap email) — so env-granted and
  bootstrap admins stop silently losing entitlements, a defect present today
  in several of the inline checks this plan removes.
- **Fails closed** on a missing row, an unknown key, or a DB error.
- **`hasFeature(tier, key)` stops being exported to application code.** The
  tier-keyed primitive becomes module-private, and a CI guard
  (`scripts/check-permission-chokepoint.mjs`, wired into `build.yml` beside
  the existing `check:docs` / `check:codegen-drift` guards) fails the build
  if any file outside `featureAccess.ts` references it, or if a product
  route is neither resolver-gated nor listed in the four-rail allowlist.

**The principal must travel with the work, not be re-derived at the far
end.** Deriving the principal in `authMiddleware` is necessary but not
sufficient: `createMemeRecord`, `videoPipelineRunner` and `aiMemePipeline`
all take a bare `userId` and re-read the stored admin flag from the database
for the **boolean** gates they own (PuLID, private visibility), which cannot
see the session-scoped view-as-user state. Left alone, an admin previewing
as a registered user would still bypass this plan's boolean gates through
every background path. So the resolved principal becomes an explicit
**snapshot** parameter threaded through those interfaces, and persisted
alongside queued work so an async job resolves against the principal that
enqueued it (Settled Decision #8). Every call site is enumerated in
*Implementation Steps*; none may keep its own user lookup for the boolean
decisions they make.

**`checkBudget` is explicitly excluded from this list** (corrected — Codex
round 1, line 702, verified against `budgetGate.ts:78-101`). Its entire job
is numeric: resolving the effective tier's dollar limit, the admin spend
exemption, and the per-user `monthlyGenerationLimitOverrideUsd` override —
none of which this plan touches, and all of which are explicitly Plan 2's
territory under *Must Not Change*. The `{tier, isAdmin}` principal has no
limit to give it and no boolean entitlement for it to resolve; threading it
in would either drop the per-user override silently or change numeric
budget behaviour this plan is not authorized to change. `checkBudget` stays
completely untouched by this plan, bugs and all — including the fail-open
defect tracked separately in #409.

### One client contract

The resolved entitlement map ships to the client, computed by the **same**
resolver the write paths use:

- **It is a typed entitlement map, not a bare `features: string[]`.** A
  string array can only say "allowed" — it cannot express Plan 2's eventual
  `limit`, so choosing the richer shape now avoids a breaking change later.
- **It is not nested inside the nullable user object.** `/auth/user` returns
  `{ user: null }` when logged out, so entitlements hanging off `AuthUser`
  would leave every anonymous surface deriving or hardcoding, and any future
  `unregistered` grant would be unreachable. Entitlements are a sibling field
  of `user`, populated for authenticated and anonymous callers alike.
- **The client revalidates via a signal it can actually observe — and that
  signal must correlate with the payload it triggers, not just exist.** The
  server resolver's cache has a TTL; the client payload is a snapshot taken
  when `AuthProvider` mounts, with no interval and no invalidation otherwise
  — an open tab could hold a stale lock indefinitely. The client polls a
  dedicated, cacheable `GET /entitlements/version` on a fixed cadence at or
  below the server's cache window, and re-fetches the full entitlement
  payload only when that cheap value moves. (A naive "revalidate when the
  version inside the payload changes" is circular — the client would need to
  re-fetch the payload to notice the version moved — which is why the version
  lives at its own endpoint, not inside the entitlement response.)

  **Observing a new version and then fetching an unversioned payload does
  not prove the two agree** (corrected — Codex round 1, line 379). A second
  process, or the same process between the permission-row commit and its own
  cache bust, can still serve its stale resolver cache to that fetch — the
  version has already moved, so the client never polls again, and it settles
  permanently on a stale lock. The entitlement payload itself therefore
  carries the resolver revision it was computed from; the client compares
  that embedded revision against the version it observed and retries the
  fetch until they agree, rather than trusting a single round-trip.

The client obeys it instead of deriving:

- `roleToTier` (`studioAdapter.ts:45-49`) — the PR #402 function — is
  deleted.
- The dozen verbatim `role === "legendary" || role === "admin"` derivations
  and the three contradictory upload rules collapse into `can('feature_key')`.
- The Features console stops being half-inert: granting `registered` a flag
  now visibly changes the UI, because the UI is reading the grid.
- `AuthUser` (and the new sibling entitlements field) are codegen-owned
  (`lib/api-spec/openapi.yaml` → `lib/api-zod`), added at the spec and
  regenerated — never hand-edited into `lib/api-zod/src/index.ts`, per that
  package's standing codegen-drift gotcha.

**Read gate and write gate must be one expression evaluated once.** Any
future gate that renders a control from one check and validates the
resulting write from a different one recreates PR #402's shape. This plan
introduces no such split; it is stated here as the standing rule the CI guard
and the resolver design both exist to enforce.

### Lockout and self-reference guards

Three guards, none of which exist today:

1. **An admin may not remove their own admin flag** (`PATCH
   /admin/users/:id`).
2. **The effective active-admin count may never reach zero** — by demotion,
   deletion, **or deactivation**. `PATCH /admin/users/:id` also accepts
   `isActive: false`, and `authMiddleware` only resolves users with
   `is_active = true`, so switching off the last admin account removes
   console access without touching the admin flag — a path a narrower guard
   would miss. The guard is stated over the *invariant*: no `PATCH`/`DELETE`
   sequence, including concurrent demotion-plus-deactivation, may reduce the
   count of active admins to zero.

   **A transaction alone does not deliver this.** At Postgres's default
   `READ COMMITTED` isolation, two transactions demoting or deactivating
   *different* admin rows both read a count of two, both conclude they are
   safe, and both commit — leaving zero, since the rows they write don't
   overlap and nothing serializes them. The guard therefore takes an
   explicit **transaction-scoped advisory lock** (`pg_advisory_xact_lock`,
   acquired on the same connection as the count and the write — a
   session-level lock would risk outliving its transaction under this app's
   connection pooling) before counting, so the check and the write are
   serialized regardless of which rows they touch.

   **The check must run before irreversible cleanup starts, not just before
   the final row mutation** (corrected — Codex round 1, line 424, verified
   against `admin.ts:468-575`). Both hard and soft delete run genuinely
   irreversible external work — object storage deletion, Stripe subscription
   cancellation, session revocation — *before* the DB mutation that actually
   removes admin access. A guard attached only to that final write would
   correctly reject the last-admin case, but only after the damage the
   rejection was supposed to prevent has already happened. So the serialized
   check-and-reserve is the **first** action in both the hard-delete and
   soft-delete handlers, inside the same advisory-lock transaction: it
   verifies the operation would not zero the active-admin count and commits
   a durable reservation before any cleanup step runs. Cleanup proceeds only
   once that reservation is committed; a later cleanup-stage failure follows
   the route's existing `currentStage` recovery path unchanged, and does not
   reopen the lockout race, because the reservation — not the final row
   state — is what a concurrent request checks against.
3. **"View as user" gains a re-entry path — and the toggle route itself is
   fixed, not just the UI in front of it** (corrected — Codex round 1, line
   428, verified against `auth.ts:427-435` and `authMiddleware.ts:122`). The
   toggle control is gated on `realRole === 'admin'` rather than the
   effective role, so it is reachable in both directions in the UI —
   `AdminLayout` shows a real admin in view-as-user mode an explanatory
   panel with a working toggle instead of "Access Denied." But
   `POST /auth/toggle-admin-mode`'s own server-side admin check
   (`isRealAdmin = dbUser?.isAdmin || isAdminById(...)`) is missing the
   `isAdminByEmail(...)` clause that `authMiddleware`'s chokepoint already
   includes — so a bootstrap-email-only admin passes every other gate in
   this plan but gets a 403 from the one route that lets them enter or leave
   preview mode, defeating the re-entry guarantee for exactly the account
   this plan's bootstrap carve-out exists to protect. The route is
   corrected to authorize through the same `isRealAdmin`/`realUserRole`
   resolution as everywhere else, and the re-entry test covers all three
   admin-grant mechanisms (stored flag, `ADMIN_USER_IDS`, bootstrap email),
   not just the first two.

### Adjacent defects folded in

Permission checks disagreeing with each other, in this plan's scope:

- `video_generation`'s grid rows stop being force-overwritten on every server
  boot (`seed.ts` changes from `DO UPDATE SET enabled = EXCLUDED.enabled` to
  `DO NOTHING`, matching every other seeded row).
- `videos.ts` and `videoJobs.ts` resolve the `video_generation` boolean
  through one call, so turning the feature off in the grid actually turns it
  off on both routes. (The separate numeric daily-job-count cap is Plan 2's
  scope and is untouched here.)
- `setTierFeature` validates the tier identifier against the real column set.
- `injectMembershipTier` (dead, never mounted) and the unreachable `render.ts`
  PuLID gate (its `imageTransform` parameter is never threaded through, so
  `mode` can never be `"pulid"`) are removed; PuLID access is provided by a
  real, reachable gate instead.
- **Three operational sites move to the privilege rail**: `jobs.ts` ×2 and
  `affiliate.ts` move from the toggle-aware `isAdmin` to `realUserRole`.
  `facts.ts` does **not** join them — its check *is* the
  `comment_captcha_bypass` entitlement decision, which is supposed to honour
  the toggle under Settled Decision #3. It collapses into a single resolver
  call instead.
- `meme_rate_limit_high`'s grid description is corrected (it currently
  claims "100/hour instead of 10/hour"; the real behaviour is a 200-vs-30
  daily save cap) — cosmetic, but wrong copy on the one screen this plan
  makes authoritative should not survive the migration.
- **The custom-avatar write path is gated, not just the display.** Both
  `POST /storage/upload-avatar` and `POST /users/me/profile-image` require
  `can('custom_avatar')` before accepting a client-supplied avatar image;
  the Navbar display check is replaced by reading the same entitlement from
  the client contract instead of deriving from role.

## Grid Intent Review

Every row is a capability the system already has; the question is only what
the grid should say about it. All values reproduce today's real behaviour
except the two marked as fixing an accidental denial.

### Existing keys

| Feature | Current behaviour | Proposed row (u / r / l / **a**) | Change |
|---|---|---|---|
| `comment_captcha_bypass` | legendary + admin skip comment captcha | ✗ / ✗ / ✓ / **✓** | none — admin cell becomes live |
| `meme_private_visibility` | legendary + admin (post-#402) | ✗ / ✗ / ✓ / **✓** | none — admin cell becomes live |
| `meme_rate_limit_high` | legendary only; **admins wrongly on the free cap** | ✗ / ✗ / ✓ / **✓** | **fixes an accidental denial**; description text corrected; stays boolean here, superseded by Plan 2's metered `daily_meme_saves` |
| `meme_ai_background` | legendary via `requireLegendary`; **admins wrongly denied** on the (dead) render gate | ✗ / ✗ / ✓ / **✓** | **fixes an accidental denial**; rewired to the reachable routes |
| `video_generation` | legendary + admin, **cannot actually be switched off** | ✗ / ✗ / ✓ / **✓** | grid toggle starts working; boot overwrite removed |
| `meme_upload_photo` | dead row — upload is authentication-only | ✗ / ✓ / ✓ / **✓** | wired up for the first time, resolving the three-way builder disagreement |

**`engine_experiments` is explicitly untouched** — left exactly as it is
today (no rows, admin-only via a hardcoded predicate). Plan 3 replaces it
entirely with the band features; this plan must not partially migrate it.

### New keys — capabilities that exist but are not in the grid

| Proposed feature | Where it lives today | Proposed row (u / r / l / **a**) |
|---|---|---|
| `meme_pulid_stylize` | `requireLegendary` on `pulidJobs.ts:172` + a role check in `createMemeRecord` | ✗ / ✗ / ✓ / **✓** |
| `fact_submit_captcha_bypass` | legendary/admin short-circuits in `reviews.ts:136`, `ai.ts:336` | ✗ / ✗ / ✓ / **✓** |
| `fact_submit_rate_limit_bypass` | legendary/admin short-circuit in `rateLimit.ts:184` | ✗ / ✗ / ✓ / **✓** |
| `ads_free` | client-only, `AdSlot.tsx:21` — no server gate exists | ✗ / ✗ / ✓ / **✓** |
| `custom_avatar` | client-only display check, `Navbar.tsx:46`; **the selection write is unenforced today** | ✗ / ✗ / ✓ / **✓** |

**The gate sits at the display-selection boundary, not the photo upload**
(corrected — Codex round 1, line 459, verified against `Onboard.tsx:113-139`
and `users.ts:226-310,515-575`). `POST /storage/upload-avatar` and `POST
/users/me/profile-image` are **not** avatar-only routes — they are the
shared onboarding/profile-photo flow, and the resulting image is the
identity photo consumed by PuLID meme and video generation. Gating the
upload itself would break free onboarding for every registered user and
remove a capability that is free today, directly violating this plan's own
"no other end-user-visible capability changes" claim.

The actual paid capability is `usersTable.avatarSource` — `'avatar'`
(generated icon, the default) versus `'photo'` (the uploaded image, shown in
the nav per `Navbar.tsx:49`). Uploading a photo stays entitlement-free, as it
is today; **setting `avatarSource = 'photo'` requires `can('custom_avatar')`**.
Two write paths set it, both gated: `POST /users/me/profile-image`
(`users.ts:563`, which sets it as a side effect of a successful upload) and
`PATCH /users/me` (`users.ts:282-286`, which accepts it directly and was an
unaddressed bypass in the first draft of this row). A registered user may
still upload and store a photo — for onboarding, for identity-meme
generation — they simply cannot select it as their displayed avatar without
the entitlement, matching today's real behaviour on upload and changing only
the one boundary David named as the intended upsell.

Nothing else in this plan changes end-user-visible behaviour except the two
accidental admin denials being lifted.

## Data Model and Migration Impact

### Schema

**No new columns.** `feature_flags` and `tier_feature_permissions` already
have everything a boolean-only grid needs (`key`/`tier`/`feature_key`/
`enabled`). Plan 2 is what adds `value_type`/`unit`/`min_value`/`max_value`/
`limit_value` for metered rows — introducing them here, with nothing to
populate them, would be schema built for a plan that hasn't been approved.

**One genuinely new mechanism: row-set completeness is enforced by the
database, not by callers choosing the right function.** Migration `0057`
added a feature definition with no tier rows, and nothing caught it. A CHECK
constraint cannot require child rows to exist, and a CI seed test cannot
prevent production drift or a direct row deletion.

**A "sanctioned creation function" that coexists with ordinary `INSERT`
privilege on `feature_flags` enforces nothing** (corrected — Codex round 1,
line 521). Nothing about the function's existence stops a caller — a future
migration, a script, an admin tool that grows a second write path — from
inserting a `feature_flags` row directly and recreating `0057`'s exact
failure. Enforced instead by:

- The application's database role's `INSERT` privilege on `feature_flags`
  is **revoked**; the transactional creation function runs as the sole
  grantee (`SECURITY DEFINER`, or an equivalent owner-privilege pattern), so
  there is no direct-insert path left to bypass, not merely a discouraged
  one.
- A **deferred constraint trigger** on `feature_flags`, checked at
  transaction commit rather than immediately after the row insert, asserts
  that a complete four-row `tier_feature_permissions` set exists for the new
  feature. Deferring to commit-time is what makes the creation function's
  own multi-statement insert (parent row, then four child rows) legal without
  the trigger firing prematurely on the parent alone.
- A **deletion-protection trigger** on `tier_feature_permissions` rejects
  removing an individual row for a feature that still exists. Feature
  deletion goes through the creation function's counterpart, removing the
  whole set atomically.
- **`engine_experiments` is the one declared, permanent exception** — its
  incomplete row-set predates this plan and is deliberately left alone (see
  *Grid Intent Review*). The deferred trigger excludes it by feature key
  explicitly, not by a general "some rows are allowed to be incomplete"
  escape hatch that a future feature could also slip through.

Both get matching declarations in `lib/db/src/schema/featureFlags.ts`,
because a raw-SQL constraint living only in a migration has been silently
lost in this repo before.

**A new table stores the grid-mutation audit trail** (added — Codex round 1,
line 613: the plan promised this record but never specified where it lives,
which a repo-wide check of `lib/db/src/schema/` confirms doesn't exist
today). `tier_feature_permission_audit` — append-only, no `UPDATE` or
`DELETE` grant on the application role, matching the pattern
`membership_history` already uses in this schema for the same reason.
Columns: `id`, `actor_id` (FK to `users`, `ON DELETE SET NULL` so a later
account deletion doesn't destroy the historical record), `tier`,
`feature_key` (FK to `feature_flags`), `enabled_before`, `enabled_after`,
`created_at`. The cell write and its audit row commit in the same
transaction — a write that fails leaves no audit row, per the Security
section below.

### Migration

Forward-only, idempotent, nothing destructive:

1. Add the transactional creation function, the deferred completeness
   trigger, the deletion-protection trigger, and the audit table (below);
   revoke direct `INSERT` on `feature_flags`.
2. Insert the five new boolean `feature_flags` rows and their full four-row
   sets via the creation function.
3. Correct `meme_rate_limit_high`'s description text.
4. Backfill any missing `(tier, feature_key)` combination among the
   **existing, non-`engine_experiments`** features, so every feature this
   plan touches has a complete row-set. `engine_experiments`'s missing rows
   are deliberately left as-is — backfilling rows for a feature Plan 3 is
   about to retire is wasted work.

   **Emits observable counts** (corrected — Codex round 1, line 544): rows
   inserted, features already complete (no-op), and `engine_experiments`
   rows explicitly skipped-by-design. A clean re-run reports zero inserted
   and the same skip count, which is the migration's own idempotency
   assertion — a nonzero insert count on a re-run is a bug, not drift to
   shrug off.

Also in the same PR: the `video_generation` seed in `seed.ts` changes from
`DO UPDATE SET enabled = EXCLUDED.enabled` to `DO NOTHING`, matching every
other seeded row, so operator toggles survive a restart.

**Row-state matrix:** *new* key → insert; *existing and complete* → no-op;
*existing and partial* → fill gaps only; *re-run* → no-op throughout. Nothing
is deleted, nothing is destructive, so no backup artifact or rollback plan is
needed beyond the ordinary forward fix.

## Runtime Behavior

- An anonymous request resolves the `unregistered` row-set.
- A registered user resolves their tier's row-set.
- An admin resolves their tier's row-set unioned with the admin row-set —
  booleans OR-ed.
- **An admin in "view as user" mode resolves as `registered`** for every
  feature this plan covers — not merely "their own tier minus admin." A
  legendary-holding admin previewing as a user genuinely sees the registered
  experience. They still reach the admin console, and can always leave the
  mode. (Plan 2 extends this same normalization to numeric limits when those
  exist.)
- A grid toggle takes effect within the resolver's cache TTL, per process —
  a real, stated property, not a bug. The admin UI's current "changes take
  effect immediately" claim is corrected to name the window; writes bust the
  cache in the writing process.
- Any resolution failure denies.

**Edge case worth stating:** a user whose paid entitlement lapses mid-session
resolves the lower row-set on their next request, because the principal is
rebuilt from `effectiveTierExpr()` on every request. Unchanged from today.

## Admin/User UX Impact

- **Features console.** Renders the grid as it looks today — a checkbox per
  (tier, feature) cell — but the Admin column now genuinely changes
  behaviour, and five new rows appear for the boolean capabilities this plan
  surfaces. The column header states that admin values *add to*, never
  replace, the user's tier. (Value-type-aware rendering, grouping by area,
  and the explicit Unlimited state are Plan 2's UI work, needed only once
  metered rows exist — not built here.)
- **Every user-facing lock becomes truthful.** Controls the server would
  allow stop being hidden; controls the server would reject stop being
  offered.
- **View-as-user gains an exit.** A real admin in view-as-user mode sees an
  explanatory panel with a working toggle instead of "Access Denied".
- **The custom-avatar upsell becomes real.** A registered user attempting to
  set a custom avatar now gets a real rejection instead of a silent accept;
  the UI should surface this as an upgrade prompt rather than a bare error
  (implementation detail, not a product decision — the entitlement gate is
  what's being approved here).
- **No other end-user-visible capability changes** except the two accidental
  admin denials being lifted, which affect admins only.

## Security, Permissions, and Validation

- Every gate fails closed.
- Operational routes keep `requireRole` on `realUserRole` — unchanged, and
  now enforced consistently at the three sites that previously read the
  toggle-aware flag by mistake.
- Ownership checks are untouched and explicitly out of the grid. Admins can
  *view* any ordinary meme but cannot *act* on one they don't own (delete,
  remove a link, cancel a job) outside their granted moderation privileges —
  that asymmetry is preserved and documented as deliberate. Quarantined/
  restricted evidence stays categorically excluded from admin viewing,
  unaffected by this plan.
- **Boolean grid mutations are audited.** Today `setTierFeature` records only
  `updated_at` — no actor, no prior value. An append-only audit row per
  mutation captures actor, tier, feature, old and new `enabled`, and
  timestamp. The prior value is read under a row lock (or an optimistic
  version predicate) before being recorded, so two concurrent edits to the
  same cell produce two honest transitions rather than both recording the
  same stale "before" value. Failed writes produce no audit row.
- The grid editor validates the tier identifier and feature existence
  server-side; client-side constraints are not treated as a control, since
  the API is reachable directly.
- Admin grant/revoke keeps its existing audit trail; the lockout guards
  return explicit errors rather than silently no-op'ing.
- **No new trust boundary.** The client-visible entitlement map is a
  projection of a server decision, never an input to one — the server
  re-resolves on every request and never trusts a client-supplied claim.

## Testing Plan

Runner commands per `docs/tests/testing-guide.md`:
`pnpm --filter @workspace/api-server test`, `pnpm --filter @workspace/db test`,
`pnpm --filter @workspace/overhype-me test`.

The invariant tests, not just the reported examples:

1. **Union semantics** — for every boolean feature key, an admin resolves ⊇
   what their own tier alone resolves. Table-driven over the whole grid.
2. **The PR #402 regression, generalised — as own-tier monotonicity.** Adding
   the admin overlay never makes an account worse off than that same account
   without it. PR #402 itself is kept as a named regression case.
3. **Every consulted key is reachable** — every feature key referenced in
   code exists in the grid with a complete four-row set, and every grid key
   (except `engine_experiments`, explicitly excluded) is referenced in code.
4. **Fail-closed** — DB error, unknown key, and missing row each deny, for
   every gate.
5. **View-as-user** — feature gates drop to `registered`; `requireRole`
   admin gates do not; the toggle is reachable in both directions.
6. **Lockout guards** — self-demotion refused; the active-admin count cannot
   reach zero via any single or concurrent combination of demotion,
   deactivation, and deletion; a deterministic concurrent test proves two
   operations against *different* admin rows cannot both commit.
7. **Client/server agreement** — the client's rendered lock state for each
   capability is asserted against the server's answer for the same
   principal, so a future divergence fails CI rather than shipping.
8. **Negative cases throughout** — an unregistered principal, an anonymous
   principal, and a lapsed-legendary principal for each gate.
9. **View-as-user reaches the background paths** — end-to-end through each
   pipeline and queued-job path, not merely at the route boundary, proving an
   admin previewing as registered is treated as registered by background
   work too. Run separately for a registered-admin and a legendary-admin.
10. **Row-set integrity** — inserting a feature without its full row-set, and
    deleting an individual required row, are both rejected by the database.
11. **Grid-editor safety** — invalid direct API writes leave the cell
    unchanged; every successful change is attributed in the audit trail and
    every rejected one writes nothing.
12. **Client contract completeness** — logged-out clients consume every
    `unregistered` value without fabricating a user; an open client
    converges on a grid change within the advertised window without a
    reload.
13. **The custom-avatar entitlement gate is at the selection boundary, not
    the upload.** A registered user can upload and store a photo via both
    routes without any entitlement; the same user's attempt to set
    `avatarSource = 'photo'` via either `POST /users/me/profile-image`'s
    side effect or a direct `PATCH /users/me` is rejected; a legendary or
    admin account's selection succeeds via either path; the existing
    display-only client check is fully replaced, not left running alongside
    the new server check.
14. **The active-admin lockout guard blocks before cleanup, not after.** A
    last-admin hard-delete and soft-delete attempt are both rejected before
    any object-storage deletion or Stripe cancellation call is made — proven
    by asserting no such call occurs, not merely that the final row is
    unchanged. A concurrent last-admin deletion and a routine non-last-admin
    deletion don't interfere with each other.
15. **The revoked `INSERT` privilege and the deferred completeness trigger**
    — a direct `INSERT` into `feature_flags` bypassing the creation function
    is rejected by privilege, not merely discouraged by convention; a
    creation-function call that would leave an incomplete row-set is
    rejected at commit.
16. **Entitlement payload/version correlation** — a client that observes a
    version bump but receives a payload computed from the prior revision
    retries rather than accepting the stale result; the retry converges once
    a payload actually carrying the observed revision is served.

Manual QA is the UAT doc, covering both the admin and non-admin experience of
each changed surface.

## Implementation Steps

One PR — this plan does not itself split into phases; a phase boundary here
would be a further plan split, not an implementation detail, and nothing
below is independently shippable on its own.

1. Add `featureAccess.ts` with `resolveEntitlements` / `can` / `limitFor` /
   `requireFeature`; make `hasFeature` module-private.
2. **Classify every product route** into entitlement / privilege / identity
   prerequisite / deliberately public, and check the classification in as
   the allowlist the CI guard reads.
3. Migration: revoke direct `INSERT` on `feature_flags`, add the
   transactional creation function, the deferred completeness trigger, the
   deletion-protection trigger, the audit table, the five new boolean
   features and their row-sets, the description-text fix, the row backfill
   excluding `engine_experiments` (with observable counts). Fix the
   `seed.ts` `video_generation` overwrite.
4. Move all six existing grid call sites and the five `requireLegendary`
   product routes onto `requireFeature` / `can`; collapse `facts.ts`'s
   role-OR-grid expression into one resolver call. Add the one named,
   temporary CI-guard exception for `GET /engines`'s deferred-to-Plan-3
   predicate.
5. Move the hardcoded role-rank product gates (PuLID, the two fact-submit
   bypasses, ad-free) onto the resolver; add `custom_avatar`, gating both
   write paths to `avatarSource = 'photo'` (`users.ts:282-286,563`) — never
   the underlying photo-upload routes, which stay entitlement-free.
6. Move the three genuinely mis-railed operational sites (`jobs.ts` ×2,
   `affiliate.ts`) onto `realUserRole`. Fix `POST /auth/toggle-admin-mode`'s
   admin check to include the `isAdminByEmail` path.
7. **Thread the principal snapshot** through `createMemeRecord`,
   `videoPipelineRunner` and `aiMemePipeline` for the boolean gates they own,
   persisting it with queued work; delete their internal user lookups.
   `checkBudget` is explicitly untouched — its numeric resolution is Plan 2's
   scope.
8. Fix the adjacent defects listed under *Proposed Design*.
9. Lockout guards: the advisory-lock-serialized active-admin invariant,
   with the check-and-reserve step running before any irreversible cleanup
   in both the hard- and soft-delete handlers; the view-as-user re-entry
   path and the `AdminLayout` panel.
10. **The client contract**: typed entitlement map as a sibling of `user`,
    populated for anonymous callers too, with the version-polling
    revalidation. Added at the spec, regenerated, verified against codegen
    immediately per the `lib/api-zod` gotcha. Delete `roleToTier` and the
    duplicated derivations; reconcile the three upload rules.
11. Grid-mutation audit trail and locked-read cell writes.
12. CI guard script + `build.yml` wiring.
13. Tests 1-13.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| A capability is missed and keeps an inline role check | The CI guard fails the build on any inline role comparison in a product-feature path, or any unclassified route; the sweep's inventory is the checklist, and tests 3 catches unreachable or unreferenced keys |
| The union grants an admin something an operator meant to deny | Union is deliberate (Settled Decision #1); the Admin column is editable, so denial is one toggle away for any feature where the account's own tier doesn't already grant it |
| A grid misconfiguration disables a capability broadly | Cannot affect console access by construction; every row's migration default reproduces today's behaviour, so day-one risk is zero |
| The cache window makes a toggle look broken | The window is stated in the UI copy; writes bust the cache in the writing process |
| Codegen silently reverts the new `AuthUser` sibling field | Verify against codegen immediately per the `lib/api-zod` gotcha; `check:codegen-drift` is the CI guard |
| Scope creep back toward the combined plan | This document's *Must Not Change* section names every excluded piece explicitly; a reviewer finding scope drift back into Plan 2/3 territory is a Required Revision, not a nice-to-have |

## Questions for David

None. Every decision this plan needs was settled in the direction (#412) or
the original PR #404 conversation. The scope boundary itself (what's in this
plan vs. Plan 2 vs. Plan 3) was David's own call, made explicitly after the
growth tripwire fired.

## Definition of Done

- Every existing product-feature permission check resolves through
  `featureAccess.ts`; the CI guard proves no others exist and every route is
  classified.
- The Admin column is live for every boolean feature, and toggling a cell
  changes behaviour for any principal for whom that overlay is decisive
  (an admin whose own tier already grants a feature sees no change from
  toggling Admin off for it — that's the union working correctly, not a
  bug).
- The grid contains every capability that was previously gated by an inline
  role check, as a boolean row, fully populated across all four columns.
- No client surface derives a permission it was not told; the entitlement
  payload is the sole input to every lock/unlock decision in scope.
- An admin cannot demote themselves, cannot be the last admin removed by any
  sequence including concurrent ones, and can always leave view-as-user
  mode.
- The custom-avatar write path is enforced server-side, matching its
  display-side gate.
- `docs/ai-context/` updated: `membership-entitlements.md`'s reader-inventory
  caveat, `accounts-and-auth.md`'s role-derivation section,
  `admin-console.md`'s Features entry, and the `known-failure-patterns.md`
  entitlement-gate entry all point at `featureAccess.ts` as the chokepoint.
- TEST_RUN + UAT docs shipped in the same PR.
- **Explicitly not done here, by design:** numeric limits, the `tester`
  overlay, engine bands, and the two standalone bugfixes (#409, #410) — all
  tracked separately, none blocking this plan's approval or merge.
