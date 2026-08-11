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

6. **Admin-only creation knobs are admin TOOLS — but *engine access* is an
   entitlement, and the original wording conflated the two (corrected
   2026-08-10, Codex round 1 finding at line 154).** Two different things were
   filed under "engine selection":
   - **Pointing a render at an arbitrary model endpoint to debug it** — an
     operator dial. Stays role-gated, out of the grid. So do the model,
     duration, resolution and aspect overrides.
   - **Which engines a tier is allowed to use** — a customer entitlement.
     David: *"The purpose of that setting is to give Legendary users access to
     more/better rendering engines… I wanted to give Legendary users the
     ability to spend more on higher quality engines."*

   `engine_experiments` was pointing at the second thing under a name that
   described the first, which is why the original decision mis-sorted it.

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

8. **"View as user" normalizes the principal to `registered` — it does not
   merely drop the admin union (corrected 2026-08-10, Codex round 1 finding at
   line 680).** The original wording said an admin previewing as a user would
   "genuinely hit a registered user's caps." That was false for the most
   likely admin: one who personally holds Legendary keeps every Legendary
   limit, so the preview never exercises registered-tier enforcement at all —
   while claiming to. David's decision: **drop to `registered`**, so the
   preview is what a free signed-in user actually experiences, and label the
   mode with the tier being previewed rather than a bare "view as user."
   Operational privileges still ignore the toggle, so the console stays
   reachable. An override toggle for other tiers can come later; not built
   now.

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
11. **Engine access is granted by BAND, not per engine (David, 2026-08-10).**
    One grid row per engine cannot survive the release cadence David
    described — every new FLUX/Seedance/Veo model would add a row. Instead
    each engine carries a **band** (`standard` / `premium` / `experimental`),
    and the grid grants bands to tiers. A new model is labelled on the engines
    page and is immediately available to whoever holds that band — no grid
    change, no deploy. **Multiple engines per band is the expected case**, not
    an edge one (David confirmed).

    Consequences: `engines.tierRequirement` — today a permission-shaped column
    nothing enforces — is **repurposed as the band label** rather than
    deleted, so engine *classification* stays with the engine (where metadata
    belongs) while engine *permission* lives in the grid (where permission
    belongs). Band access covers all four modalities (i2i, t2i, i2v, t2v)
    because the band is a property of the engine, not the pipeline. Band
    access and the spend budget **compose**: holding `premium` says which
    engines you may pick, `ai_generation_budget` still says how much you may
    spend, which is the intended shape when premium engines cost more per
    render.

    **Default selection is separate from access.** The system default engine
    per kind is unchanged; holding a band lets a user *choose* among engines
    in bands they hold. This is what resolves the silent-discard defect: the
    picker lists engines the principal may use and the save path accepts
    exactly that set — one expression evaluated once, per *Proposed Design*.

12. **The per-user spend override is replaced by a `tester` role (David,
    2026-08-10).** Its purpose was giving test users more spend during
    testing. A per-user dollar value on one person's edit page is invisible
    from the permissions screen — the exact failure mode Settled Decision #7
    exists to remove. A `tester` flag, orthogonal like `isAdmin`, gets its own
    grid column, composes through the same union, and is revocable with one
    toggle. **Two limits of this, accepted with David:** a role cannot express
    a one-off per-person amount (all testers share one allowance), and it does
    not expire — so an unrevoked tester keeps elevated spend indefinitely.
    Expiring grants are noted as follow-up work, not built here; the role is
    still strictly better than the override on visibility, which is the
    problem being solved.


13. **A queued job is authorized as of when it was submitted, not when it
    runs (David, 2026-08-11).** Codex asked whether a job sitting in the queue
    should use the entitlements captured at enqueue or re-resolve the current
    grid at execution. David: *"Do whatever is easier because that situation
    has an infinitesimal chance of happening."* Easier and already half-built
    is the snapshot — the principal is persisted with the job regardless, so
    the entitlement values and engine band ride along with it. Accepted
    consequence, stated rather than discovered later: a feature revoked while
    a job is queued still completes that one job. Jobs here are short and the
    exposure is a single render. **Not built:** an immediate-cancel path for
    abuse revocation, which is the one case where the money genuinely needs to
    stop — noted as follow-up, deliberately out of scope on the same
    rarity grounds.

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

### A third category the first draft left unnamed: identity prerequisites

Codex round 1 (line 831) found the real hole in the "exhaustive" claim, and it
is a classification hole rather than a missed file. A large set of product
capabilities — rating a fact, commenting, hearts, share intents, activity feed
— is gated **only** by "are you signed in," with no role and no feature key
anywhere near them. They contain none of the tokens the sweep searched for, so
no amount of searching for role comparisons would have surfaced them, and the
proposed CI guard could not have proved its own invariant.

Worse, the first draft was **inconsistent** about them: it moved
`meme_upload_photo` — equally authentication-only — into the grid while
leaving its siblings unclassified. Either that is a permission or it is not.

So the model gains an explicit third rail:

| | **Identity prerequisite** | **Deliberately public** |
|---|---|---|
| Answers | "Are you a signed-in account at all?" | "Nothing — anyone may do this" |
| Source of truth | `req.isAuthenticated()` — deliberately not configurable | the allowlist entry itself |
| Why not in the grid | Granting these to `unregistered` is incoherent: they write rows owned by a user id that would not exist | there is nothing to grant; the capability is already universal |
| Examples | commenting, rating, hearts, share intents | `GET /facts`, `GET /hashtags`, `GET /memes/templates`, public meme permalinks |

**The public category is not a loophole — it is the point of the allowlist**
(added 2026-08-11, Codex round 2). Browsing without an account is core product
behaviour stated in the product brief, and a three-category model would have
forced the CI guard either to reject those routes or to demand a gate on them.
But "public" must be *declared*, never inferred from the absence of a gate —
inferring it is exactly how an accidentally ungated mutation would pass. So
the allowlist distinguishes a route explicitly marked public from one that is
merely unclassified, and the guard rejects the second.

**Every product route is classified into exactly one of the four rails, and
the classification is checked in** as an allowlist the CI guard reads. A route
that is not resolver-gated, privilege-gated, or listed as an identity
prerequisite or deliberately public fails the build. That is what makes the
exhaustiveness claim provable rather than asserted — the guard stops looking
for *bad* patterns and starts requiring an *approved* one.

`meme_upload_photo` is resolved into this frame rather than left ambiguous: it
stays a **grid feature**, because unlike commenting it is a capability David
may genuinely want to withhold from a tier, and the grid already carries the
row. Its siblings are recorded as identity prerequisites. Any of them can
later be promoted to the grid by adding a row and moving one line in the
allowlist.

### One resolver

A new module — `artifacts/api-server/src/lib/featureAccess.ts` — is the only
code permitted to read the grid:

```
principal = { tier, isAdmin, isTester }

resolveEntitlements(principal) -> Map<featureKey, Entitlement>
  = merge( gridRows(principal.tier),
           principal.isAdmin  ? gridRows('admin')  : ∅,
           principal.isTester ? gridRows('tester') : ∅ )

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

**`merge` is "more permissive wins" — but only ENABLED operands contribute a
limit** (corrected 2026-08-10, Codex round 1 finding at line 454). The
original spec combined `allowed` and `limit` independently, which is wrong in
both directions: a disabled row carrying `NULL` would win as "unlimited," and
a disabled row carrying a stale number could enlarge the active allowance. In
either case an operator-visible **denial** silently becomes a runtime
**grant** — the worst possible direction for this bug to point. Corrected
rule:

```
allowed = OR over all operands
limit   = if no operand is allowed        -> denied (no limit needed)
          else if any ALLOWED operand is unlimited -> unlimited
          else max(limit of ALLOWED operands only)
```

A disabled cell never contributes its stored number, in either the tier or the
admin position. Zero and unlimited stay distinct throughout: zero is an
enabled allowance of nothing, unlimited is an enabled allowance with no
ceiling, and disabled is neither.

**The principal must travel with the work, not be re-derived at the far end**
(added 2026-08-10, Codex round 1 finding at line 463). Deriving the principal
in `authMiddleware` is necessary but nowhere near sufficient: `checkBudget`,
`createMemeRecord`, `videoPipelineRunner` and `aiMemePipeline` all take a bare
`userId` and re-read the stored admin flag from the database, which cannot see
the session-scoped view-as-user state. Left alone, an admin previewing as a
registered user would still get unlimited spend through every background path
— Settled Decision #8 would be true only at the route boundary and false
everywhere the money is actually spent. So the resolved principal becomes an
explicit **snapshot** parameter threaded through those interfaces, and
persisted alongside queued work so an async job resolves against the principal
that enqueued it. Every one of those call sites is enumerated in
*Implementation Steps*; none may keep its own user lookup.

**Anonymous callers get a projection too** (added 2026-08-10, Codex round 1
finding at line 482). The resolver already supports the `unregistered`
row-set, so the client contract must be able to carry it — see *One client
contract*.

- **`principal`** is derived from `req.user` — carrying the *effective* tier,
  the *toggle-aware* admin flag, and the tester flag — or the anonymous
  principal (`tier: 'unregistered'`, both flags false) when there is no
  session. Taking a principal rather than a tier string is the whole point: it
  is the seam impersonation later slots into (Settled Decision #5).
- **Three overlay sources, not two** (corrected 2026-08-11, Codex round 2).
  The first revision added the `tester` role to *Settled Decisions* and the
  grid but left the resolver merging only tier and admin — so the role that
  replaced the per-user spend override would have granted nothing, which is
  strictly worse than the override it replaced. The grid therefore has **five
  columns** (`unregistered`, `registered`, `legendary`, `admin`, `tester`),
  the row-set integrity rule is **five rows per feature**, and every
  every column statement in this document means five. The grid tables below
  show the four **base** columns; the `tester` overlay's values are specified
  once, in *The `tester` column*, because it is deliberately sparse.
- **Union**, per Settled Decision #2, extended over all three overlays.
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

The resolved entitlement set ships to the client, computed by the **same**
resolver the write paths use. Three corrections from Codex round 1:

- **It is a typed entitlement map, not `features: string[]`** (line 482). A
  string array can only say "allowed," so zero and unlimited collapse into the
  same present-or-absent bit and the client would have to fetch limits from
  somewhere else — recreating the split authority this plan exists to remove.
  The payload carries `{ allowed, limit }` per key, with an explicit unlimited
  sentinel, and both `can()` and `limitFor()` read it.
- **It is not nested inside the nullable user object** (line 482). `/auth/user`
  returns `{ user: null }` when logged out, so entitlements hanging off
  `AuthUser` would leave every anonymous surface deriving or hardcoding —
  and any future `unregistered` grant would be unreachable. Entitlements
  become a sibling field of `user`, populated for authenticated and anonymous
  callers alike.
- **The client must revalidate, and needs a signal it can actually observe**
  (line 684, reopened in round 2). The 60-second window is the *server*
  resolver's cache; the client payload is a snapshot taken when
  `AuthProvider` mounts, with no interval and no invalidation, so an open tab
  could hold a stale lock indefinitely. The first fix — "revalidate when the
  grid version changes" — was **circular**: the version lives inside the very
  payload the client would have to re-fetch to notice it changed, and window
  focus does nothing for a tab that never loses focus. Corrected: the client
  **polls a dedicated, cacheable `GET /entitlements/version`** on a fixed
  cadence at or below the advertised window, and re-fetches the full
  entitlement payload only when that cheap value moves. Window focus stays as
  an additional trigger, not the mechanism. Acceptance is a continuously
  focused tab converging on both a grant and a revoke with no reload and no
  local write.

The client obeys it instead of deriving:

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
2. **The effective active-admin count may never reach zero** — by demotion,
   deletion, **or deactivation** (Codex round 1, line 506). The original pair
   of guards missed that `PATCH /admin/users/:id` also accepts
   `isActive: false`, and `authMiddleware` only resolves users with
   `is_active = true` — so switching off the last admin account removes
   console access without touching the admin flag, walking straight past both
   guards into the lockout they exist to prevent. The guard is therefore
   stated over the *invariant* rather than over the two operations that first
   came to mind: no `PATCH` or `DELETE` sequence, including concurrent
   demotion-plus-deactivation, may reduce the count of active admins to zero.

   **A transaction alone does not deliver this** (corrected 2026-08-11, Codex
   round 2). At Postgres's default `READ COMMITTED`, two transactions
   demoting or deactivating *different* admin rows both read a count of two,
   both conclude they are safe, and both commit — leaving zero. The rows they
   write don't overlap, so nothing serializes them. The guard therefore needs
   an explicit shared serialization point: **every demotion, deactivation and
   deletion path takes the same advisory lock** (or equivalently locks a
   singleton guard row) before counting, so the check and the write are
   serialized against each other regardless of which rows they touch.
   Acceptance is a deterministic concurrent test where two operations against
   *different* admin rows cannot both commit.
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
- **Three — not four — operational sites reading the toggle-aware `isAdmin`
  move to the privilege rail: `jobs.ts` ×2 and `affiliate.ts`** (corrected
  2026-08-10, Codex round 1 finding at line 528). `facts.ts` was wrongly on
  that list. Its toggle-aware check *is* the `comment_captcha_bypass`
  decision — a grid entitlement, which under Settled Decision #4 is **supposed
  to** honour the toggle. Moving it to `realUserRole` would have hardwired an
  unconditional admin CAPTCHA bypass that ignores its own grid cell and makes
  view-as-user unfaithful — introducing the exact class of defect this plan
  removes, in the plan meant to remove it. Instead `facts.ts`'s whole
  role-OR-grid expression collapses into a single resolver call like every
  other entitlement.

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
| `daily_video_jobs` ⚠ | code constant 3 — see the warning below | ✗ | 3 | 3 | **∞** ² |
| `fact_submits_per_minute` | code constant 5/60s | ✗ | 5 | ∞ | **∞** |
| `pending_fact_submissions` | code constant 10, flat | ✗ | 10 | 10 | **∞** ³ |
| `governance_daily_spend` (USD) | `resourceGovernance.POLICIES` | 0 | 3 | 20 | **200** |
| `governance_monthly_spend` (USD) | same | 0 | 25 | 250 | **2000** |
| `governance_requests_per_day` | same | 0 | 25 | 250 | **2000** |
| `governance_concurrent_jobs` | same | 0 | 1 | 3 | **10** |
| `governance_max_duration_sec` | same | 0 | 8 | 30 | **120** |
| `governance_max_payload_mb` ⁴ | same | 0 | 1.5 | 8 | **25** |

¹ **fixes the accidental denial** — admins are currently on 30/day.
² admins are currently exempt in code; ∞ makes that visible.
³ **fixes the accidental cap** — admins are currently held to 10 like everyone
else, unlike the sibling rate limiter which exempts them.

⚠ **`daily_video_jobs` does not describe one existing behaviour, and the grid
must not pretend it does** (Codex round 1, line 570 — verified). Today the
3-per-24h check exists only on `POST /videos/generate`, and it counts rows by
**IP address**, not by account; the wizard path `POST /memes/video-jobs` has
**no daily cap at all**. So a grid row advertising a per-account allowance
would be doubly false: bypassable by changing network, and unapplied on the
path most users take. This row therefore ships with a **behaviour change, not
a lift-and-shift**: one shared, account-scoped limiter enforced atomically
across both creation routes, replacing the IP-based check. Called out
explicitly because everything else in this plan reproduces today's behaviour
on migration day and this one deliberately does not — an anonymous caller with
no account is denied video generation outright (the `unregistered` row is ✗),
so removing IP-scoping loses nothing.

**"Atomic" is not a specification — the limiter needs a durable reservation**
(Codex round 2). Counting `video_jobs` rows cannot enforce the cap for two
reasons: a count-then-insert lets concurrent requests both pass the check, and
`startVideoJob` currently **catches a failed insert and proceeds with an
in-memory job**, so vendor work can run having never been counted. Specified
instead: both creation routes go through one **reservation transaction**
against a durable per-account counter, keyed idempotently on the request, which
must commit before any vendor call is made. If the reservation cannot persist,
the job does not start — no uncounted spend, ever. Release semantics on
failure are part of the same transaction. Acceptance is concurrent cross-route
testing at the cap boundary plus a forced insert failure that launches nothing.

### Engine bands

Per Settled Decision #11. The band is a label on the engine; these rows grant
bands to tiers. Adding a new model never adds a row here.

| Proposed feature | u | r | l | **a** |
|---|---|---|---|---|
| `engines_standard` | ✗ | ✓ | ✓ | **✓** |
| `engines_premium` | ✗ | ✗ | ✓ | **✓** |
| `engines_experimental` | ✗ | ✗ | ✗ | **✓** |

This reproduces today's effective behaviour (non-admins get the default engine
only; admins see everything) while giving David the lever he described:
opening a better class of engine to Legendary is one cell. `engine_experiments`
is retired in favour of these three; `engines.tierRequirement` becomes the band
label rather than being dropped.

**The legacy-to-band migration has to be explicit, or every engine
disappears** (added 2026-08-11, Codex round 2). All 20 engines currently carry
`tierRequirement: "legendary"`, which is not one of the three bands — so a
literal implementation would leave every engine in no granted band and empty
both the picker and the submission path. Specified instead:

- **Every existing engine is assigned a band by name in the migration**, not
  by a blanket rule: the current default engines become `standard`, the four
  engines that carried `engine_experiments` become `experimental`, and the
  remainder become `premium`. The per-engine mapping is enumerated in the
  migration so it is reviewable rather than inferred.
- **The column is constrained to the three band values** at the database and
  API layers, and the engine-editor UI offers exactly those.
- **Unknown or null bands fail closed** — such an engine is invisible to
  everyone except through the admin override path, rather than defaulting into
  a band someone holds.
- Boot reconciliation must not silently reintroduce a legacy value; an engine
  definition carrying one fails startup validation rather than being coerced.

Tested with an empty band, a null band, and a boot reconciliation pass.

### The `tester` column

Per Settled Decision #12, the grid gains a fifth column. It composes exactly
like the admin column — union with the account's tier, more permissive wins —
and it replaces `users.monthly_generation_limit_override_usd`, which is
**removed**, not merely documented: leaving it would preserve a per-account
permission outside the grid, which is the thing Settled Decision #7 forbids.

**Its seed values, stated in full so the grid is fully determined** (the
tables above show the four base columns; this is the fifth):

| Row group | `tester` seed value | Why |
|---|---|---|
| Every boolean feature | **off** | A tester is a spend allowance, not a feature grant. Anything they should also *see* is granted through their real tier, so testing stays representative. |
| `ai_generation_budget` | **on, unlimited** | The whole purpose of the role, and the only cell that reproduces what the removed override was used for. |
| `governance_daily_spend` / `governance_monthly_spend` | **on, unlimited** | Otherwise the resource governor cancels out the budget grant and the role does nothing. |
| Every other metered row | **off** | Contributes no limit under the merge rule, so a tester keeps their own tier's caps for everything except spend. |

The sparseness is deliberate: a tester should experience the product as their
tier does, differing only in what they are allowed to spend while doing it. A
tester who is also an admin gets the admin overlay too, by the same merge.

⁴ **Units are canonicalised at the boundary, explicitly** (Codex round 1, line
578). The operator-facing value is megabytes (1.5 / 8 / 25) because that is
what a human should type; `enforceGovernance` compares against
`opts.payloadBytes`. A literal "replace the policy table with `limitFor()`"
would compare bytes to megabytes and reject essentially every upload. The
stored unit is **whatever the row's `unit` column declares**, and conversion
happens once, at the resolver/consumer boundary, never scattered through
callers. The same rule covers currency rows (stored as decimal USD, compared
as USD) and duration (seconds). Threshold tests sit immediately below, at, and
above each configured value.

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

**No per-user exception survives.** An earlier revision of this section
retained `users.monthly_generation_limit_override_usd` as a documented
carve-out; that text contradicted Settled Decision #12, the schema section,
and the Definition of Done, all of which drop it (Codex round 2 — correctly
flagged as a live contradiction an implementer could have followed either way
round). The override is **removed**: no schema column, no API field, no UI
control, no runtime reader. Its purpose is served by the `tester` column,
which is visible on the very screen this plan makes authoritative.

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

Plus `users.is_tester` (Settled Decision #12), and
`users.monthly_generation_limit_override_usd` is **dropped**.

**Two integrity rules, neither of which a CHECK constraint can express**
(Codex round 1, lines 629 and 653 — both correct, and both were impossible as
originally specified):

1. *A boolean feature must not carry a number.* The discriminator
   (`value_type`) lives on `feature_flags` and the value (`limit_value`) on
   `tier_feature_permissions`; **Postgres CHECK cannot read another table**, so
   the constraint as first written could never have been created. Enforced
   instead by a `BEFORE INSERT OR UPDATE` **trigger** on
   `tier_feature_permissions` — the same mechanism the entitlement schema
   already uses to freeze source identity, so it is an established pattern
   here rather than a new one.
2. *Every feature has exactly one row per tier column.* A CHECK cannot require
   the existence of child rows, and a CI seed test cannot prevent production
   drift or a direct delete. Enforced by a **single transactional creation
   API** that inserts a feature and its full row-set together, plus a
   **deletion-protection trigger** so removing an individual row is rejected
   rather than silently leaving the gap that migration `0057` left. Feature
   deletion goes through the same API and removes the whole set.

Both triggers get matching declarations in
`lib/db/src/schema/featureFlags.ts`, because a raw-SQL constraint living only
in a migration has been silently lost in this repo before.

### Migration

Forward-only, idempotent, in this order:

**Ordering correction (Codex round 2).** The previous list created an empty
backup table in step 1, deleted the old configuration in step 4, and copied
"pre-deletion" values in step 5 — producing an empty recovery artifact while
claiming to back up before deleting. The copy now happens **before any
destructive statement**, and its observed row count is verified before the
migration is allowed to proceed to cleanup.

0. Create `feature_config_backup` and **copy every key this migration will
   retire into it, with counts logged and verified non-zero** where source
   rows exist. Nothing destructive runs until this has succeeded.
1. Add the columns and the triggers.
2. Insert the new boolean `feature_flags` rows and their full row-sets via the
   transactional creation API; retire `engine_experiments` in favour of the
   three band rows.
3. Insert the metered features and their rows, **resolving each value from its
   real current source** — see *Value resolution* below, which is where two
   round-1 findings landed.
4. **Retire the old sources — all of them, not just the rows** (Codex round 1,
   line 647 — verified, and the most serious finding of the round). Deleting
   `admin_config` rows is **not sufficient**: `seed.ts`'s `ensureSchema()`
   re-inserts `budget_limit_registered_usd` and `budget_limit_legendary_usd`
   on **every server boot** (lines 409-419), and `config.tsx` still lists both
   keys in its Budget section (lines 20-21). The migration alone would be
   undone by the next restart, leaving exactly the two-screen state it exists
   to remove — the *same* defect this plan documents in `video_generation`,
   reproduced in my own migration. So this step deletes the rows **and**
   removes the boot-time seeds **and** removes the Config-page key handling,
   verified by a repo-wide search plus a restart test proving none of the
   migrated keys is recreated, read, or rendered.
5. **Backfill `users.is_tester` from the override before dropping it**
   (Codex round 2). The accounts carrying a non-null
   `monthly_generation_limit_override_usd` *are* today's test accounts —
   dropping the column without converting them silently strips the elevated
   budget the `tester` role exists to preserve. Every account with a non-null
   override becomes a tester; their original per-account values go to
   `feature_config_backup` alongside the config keys; matched / migrated /
   skipped counts are reported. Null, zero and positive overrides are each
   tested, and the migration is rerun-safe.
6. Drop the `meme_rate_limit_high` rows, superseded by `daily_meme_saves`.
7. Backfill any missing combination so every feature has a complete
   **five-column** row-set.

The `monthly_generation_limit_override_usd` **column drop does not happen
here** — see *Rollout staging* below.

### Rollout staging — expand, then contract

Added 2026-08-11 (Codex round 2), and it changes the shape of Phase 2. The
previous plan dropped the override column and deleted config keys in the same
rollout that removed their readers. During a rolling deploy both generations
run at once, so a surviving old instance would query a dropped column, and an
old instance restarting after the migration would re-seed retired keys through
`ensureSchema()` — re-creating exactly what step 4 removed, which is the same
boot-time-recreation defect this plan already documents twice.

So the destructive half is staged:

- **Expand.** Ship code that reads the grid, tolerates both schemas, and stops
  every old read, write and seed of the retired sources —
  `budgetGate.ts:82`, `routes/admin.ts:282-288`, `pages/admin/users.tsx`, and
  the `seed.ts` entries. Data migrates; nothing is dropped.
- **Drain.** All old instances retire.
- **Contract.** Only then drop `monthly_generation_limit_override_usd` and
  delete the retired `admin_config` rows.

Acceptance: an old-server/new-schema and a new-server/old-schema compatibility
test, plus a rolling-restart test proving no retired key is recreated.

### Value resolution — the part that was underspecified

**Existing target rows are reconciled, not skipped** (Codex round 1, line
660). The original row-state rules contradicted each other: "existing row →
no-op" versus "preserve the operator's retuned value." If a metered row
already exists holding a default or stale number, a plain
`ON CONFLICT DO NOTHING` leaves it alone *and* step 4 still deletes the
authoritative config value — silently downgrading a limit the operator had
raised. Replaced by a **preflight** that compares every replacement cell
against its source and **refuses the destructive cleanup on mismatch**, so the
migration fails loudly rather than quietly discarding an operator's setting.

**Debug overrides are resolved explicitly, never accidentally** (Codex round
1, line 641 — verified). `admin_config` carries both `value` and
`debug_value`, and every numeric getter prefers `debug_value` while
`debug_mode_active` is true (`adminConfig.ts:63-68`). The grid has no debug
column. Copying `value` alone changes live limits at cutover if a debug
override is active; copying the effective debug value silently overwrites the
operator's real setting. Resolution: **the grid always receives `value`, the
standing setting** — never the debug override — and the migration **fails
loudly if `debug_mode_active` is true**, rather than guessing which the
operator meant while a temporary override is in force. Debug overrides on
migrated keys are reported and dropped with their keys; the debug mechanism
itself is untouched for the keys that remain in `admin_config`.

**Row-state matrix:** *new* key → insert; *existing and matching* → no-op;
*existing and mismatched* → preflight refuses, migration aborts before any
deletion; *partial* → fill gaps only; *debug mode active* → abort; *re-run* →
no-op throughout. The only destructive steps are 4 and 6, both guarded on the
replacement rows existing and the backup being written first, so a partial
failure can never leave the system with neither source.

Also in the same PR: the `video_generation` seed in `seed.ts` changes from
`DO UPDATE SET enabled = EXCLUDED.enabled` to `DO NOTHING`, matching every
other seeded row, so operator toggles survive a restart.

## Runtime Behavior

- An anonymous request resolves the `unregistered` row-set.
- A registered user resolves their tier's row-set.
- An admin resolves their tier's row-set merged with the admin row-set —
  booleans OR-ed, limits taking the more permissive value.
- **An admin in "view as user" mode resolves as `registered`** — not merely
  "their own tier minus admin" (Settled Decision #8, corrected). Including the
  metered rows, so a legendary-holding admin genuinely hits the registered
  spend cap, upload cap and rate limits rather than silently keeping their
  own. This holds through background and queued work too, because the
  principal snapshot travels with the job. They still reach the admin console,
  and can always leave the mode.
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
- **Every grid mutation is audited** (Codex round 1, line 730). Today
  `setTierFeature` records only `updated_at` — no actor, no prior value. That
  was tolerable for a handful of booleans; it is not once a single cell can
  grant unlimited vendor spend, raise concurrency, or bypass CAPTCHA. An
  append-only audit row per mutation captures actor, tier column, feature,
  old and new `enabled`, old and new `limit_value`, and timestamp. Failed
  writes produce no audit row. **The prior state must be read under a lock**
  (Codex round 2): at `READ COMMITTED`, two concurrent edits to one cell can
  both read the same old value and both record it, so the audit trail would
  show two transitions from the same origin and lose the real intermediate
  state — which is precisely what makes it useless for reconstruction. The
  cell row is locked (or guarded by an optimistic version predicate) before
  the prior state is read, and the cell write and its audit row commit in that
  same transaction. Two concurrent edits either serialize into two honest
  transitions or one fails visibly.
- **A cell is written atomically and validated server-side** (Codex round 1,
  line 700). `enabled` and `limit_value` are coupled state: written
  separately, the intermediate enabled-with-no-value state means *unlimited*
  and takes effect immediately — a transient unlimited spend grant produced by
  ordinary use of the admin UI. One PATCH carries the whole cell. Server-side
  validation covers feature existence, the tier/role column being real, value
  type, finiteness, integer-versus-decimal shape, declared bounds, and the
  explicit unlimited sentinel — client-side `min`/`max` attributes are not a
  control, since the API is reachable directly.
- Admin grant/revoke keeps its existing audit trail; the lockout guards return
  explicit errors rather than silently no-op'ing.
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
2. **The PR #402 regression, generalised — as own-tier monotonicity, not a
   cross-account comparison** (corrected per Codex round 1, line 749). The
   first draft asserted that an admin resolves at least what a *legendary*
   account does. That is not what the union guarantees and would fail CI on a
   configuration the operator is entitled to set: an enabled Admin cell with a
   metered value **below** the Legendary value is perfectly valid, and
   `max(own tier, admin)` is still correct. The real invariant is that adding
   the admin overlay never makes an account **worse off than that same
   account** without it — which is exactly what #402 violated. PR #402 itself
   is kept as a concrete named regression case on top of the property test.
3. **Every consulted key is reachable** — a test asserting each key referenced
   in code exists in the grid with a complete five-column row-set, and each grid key is
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

Added in response to round 1:

9. **Disabled cells never contribute a limit** — both directions of
   off/null + on/number and off/number + on/number, plus zero and unlimited,
   asserting a disabled cell can neither win as unlimited nor raise the
   active allowance.
10. **View-as-user reaches the background paths** — end-to-end through each
    pipeline and queued-job path, not merely at the route boundary, proving an
    admin previewing as registered is actually charged against the registered
    budget. Run separately for a **registered-admin and a legendary-admin**,
    since the latter is the case Settled Decision #8 originally got wrong.
11. **Unit thresholds** — immediately below, at, and above each configured
    value for every metered row, which is what catches an MB/bytes inversion.
12. **Migration safety** — starting from conflicting existing rows (preflight
    aborts, operator value preserved), with debug mode active (aborts), and a
    restart test proving no retired key is recreated by boot-time seeding or
    still rendered by the config page.
13. **Backup restorability** — a fresh process with only database state can
    reconstruct the exact pre-migration keys and values.
14. **Grid-editor safety** — no edit sequence exposes a transient unlimited
    grant; invalid direct API writes leave the cell unchanged; every
    successful change is attributed in the audit trail and every rejected one
    writes nothing.
15. **Lockout invariant** — no `PATCH`/`DELETE` sequence, including concurrent
    demotion and deactivation, drives the active-admin count to zero.
16. **Row-set integrity** — inserting a feature without its full row-set, and
    deleting an individual row, are both rejected.
17. **Engine bands** — every principal who can see an engine can submit it,
    and no principal outside the granted bands can do either; a newly added
    engine inherits its band's access with no grid change.
18. **Client contract completeness** — logged-out clients consume every
    `unregistered` value without fabricating a user; the generated client
    distinguishes denied, zero, finite, and unlimited; an open client
    converges on a grid change within the advertised window without a reload.

Manual QA is the UAT doc, covering both the admin and non-admin experience of
each changed surface.

## Implementation Steps

**Two phases, not three — the client ships with the first server cutover**
(restructured per Codex round 1, line 825). The previous split deferred the
client to a third PR and claimed each phase was independently shippable. It
wasn't: for the whole interval, granting a tier a feature would leave its
control hidden and revoking one would leave the control offered but rejected,
so the rebuilt admin page could not be "the single truthful answer" while the
UI still derived from role. The reason for deferring — not wanting to define
the client payload twice — evaporated once the payload became a typed
`{allowed, limit}` map, since a boolean is just `limit: null` in that shape.
So the contract is defined once, up front, and both sides move together.

**Phase 1 — the resolver and the contract (one PR).**

1. Add `featureAccess.ts` with `resolveEntitlements` / `can` / `limitFor` /
   `requireFeature`; make `hasFeature` module-private. Merge semantics per
   *Proposed Design*, including the enabled-operands-only rule.
2. **Classify every product route** into entitlement / privilege / identity
   prerequisite, and check the classification in as the allowlist the CI guard
   reads.
3. Migration: **add `value_type` / `unit` / `min_value` / `max_value` and
   `limit_value` here, in Phase 1**, then the two integrity triggers, then new
   boolean keys and full row-sets via the transactional creation API;
   `engine_experiments` retired. Fix the `seed.ts` `video_generation`
   overwrite.

   *Why the columns move earlier (Codex round 2):* the boolean-value trigger
   reads `feature_flags.value_type` and `tier_feature_permissions.limit_value`,
   which the previous split did not create until Phase 2 — so Phase 1 could
   not have created its own promised trigger, and its row-integrity tests
   could not have passed. Adding the columns in Phase 1 keeps each phase
   applicable on its own from the preceding production schema; Phase 2 then
   *populates* metered rows rather than introducing the shape.
4. Move all six grid call sites and the five `requireLegendary` product routes
   onto `requireFeature` / `can`; collapse `facts.ts`'s role-OR-grid
   expression into one resolver call.
5. Move the hardcoded role-rank product gates (PuLID, captcha bypasses,
   submit-rate bypass) onto the resolver.
6. Move the three genuinely mis-railed operational sites (`jobs.ts` ×2,
   `affiliate.ts`) onto `realUserRole`.
7. **Thread the principal snapshot** through `checkBudget`,
   `createMemeRecord`, `videoPipelineRunner` and `aiMemePipeline`, persisting
   it with queued work; delete their internal user lookups.
8. Fix the adjacent defects listed under *Proposed Design*.
9. Lockout guards stated over the active-admin invariant, covering demotion,
   deletion and deactivation; view-as-user re-entry path and the
   `AdminLayout` panel.
10. **The client contract**: typed entitlement map as a sibling of `user`,
    populated for anonymous callers too, with grid-version revalidation. Added
    at the spec, regenerated, verified against codegen immediately per the
    `lib/api-zod` gotcha. Delete `roleToTier` and the duplicated derivations;
    reconcile the three upload rules.
11. Grid-mutation audit trail and atomic, server-validated cell writes.
12. CI guard script + `build.yml` wiring.
13. Tests 1-11, 14-16, 18.

**Phase 2 — metered limits, and the grid becomes total (one PR).**

14. `users.is_tester` and `feature_config_backup`. **The tester assignment
    path ships with the flag, not after it** (Codex round 2): a toggle on the
    Users page replacing the per-user override control, `PATCH
    /admin/users/:id` extended with server-side boolean validation, and
    actor-attributed grant/revoke history — otherwise the role exists with no
    way to assign it and the override it replaces is already gone. The column
    drop is deferred to *Rollout staging*'s contract step, not done here.
15. Migration with the preflight reconciliation and the debug-mode abort;
    **retire every old source** — rows, boot-time seeds, and Config-page key
    handling together — verified by repo-wide search and a restart test.
16. Move the numeric consumers onto `limitFor(...)` — `budgetGate`,
    `uploadRateLimit`, the meme save cap, the fact-submit limiter, the
    pending-submission cap, and `resourceGovernance`'s policy table — with
    unit conversion at the boundary.
17. **Replace the video-job limiter** with one shared, account-scoped,
    atomic limiter across both creation routes (the one deliberate behaviour
    change in this plan).
18. Engine bands: `tierRequirement` repurposed as the band label, band rows
    wired into `loadActiveEngines`, and the picker/save paths unified onto one
    expression.
19. Rebuild the Features page: mixed cell types, grouping, the explicit
    Unlimited state, the tester column, and copy naming the propagation
    window.
20. Extend view-as-user normalization to the metered rows.
21. Tests 12, 13, 17, plus the metered half of 9-11.

Each phase is independently shippable **and internally truthful**: Phase 1
moves server and client together, so a grid change is honestly reflected on
both sides from the first merge; Phase 2 widens what the grid can express
without ever leaving the two sides disagreeing.

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
  all five columns.
- **The Features page is the only screen that answers "who is allowed to do
  what."** No tier-differentiated setting remains in the config editor, no
  boot-time seed recreates one, and no per-account permission survives outside
  the grid — the per-user spend override is removed in favour of the `tester`
  column.
- Engine access is granted by band from the grid; no engine confers access
  from its own row, and no unenforced permission-shaped field remains on the
  engines surface.
- Every grid mutation is attributed in an audit trail, and no edit sequence
  can expose a transient unlimited grant.
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
