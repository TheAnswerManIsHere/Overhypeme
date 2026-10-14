# PLAN — Launch Phase 2: the verification build · v5 · APPROVED by David 2026-10-08; amended 2026-10-11 (v4, the second-consumer check) and 2026-10-14 (v5, increment 8)

```plan-oracle
# Oracle — Launch Phase 2: the verification build

Status: the scope below is the approved parent plan's Phase 2 section
(#628, plan sha256 6386aad47e3b29c1504fe0a2c8e908be229da41a4529dec7996357876e324cb0,
approved by David 2026-10-07), quoted, plus David's own words on what the
verification build is for. Nothing here is new scope.

## David's intent, in his words (2026-10-04)

- "I feel like most of this testing is something you can do with Playwright, no?"
- He asked to rethink UAT so that "anything mechanical is truly verified by
  scripting", distinguishing CI checks, one-time scripted proof and human
  judgement, and to minimise his cognitive load and time: he is "by far the
  slowest part" of the system.
- "We will definitely need to build the new UAT functionality we originally
  discussed as a pre-requisite to all the building we're planning for now."
  (2026-10-06)
- "We need to continue to refine the devops so that we can build and support
  multiple apps going forward." (2026-10-06)

## Phase 2, as approved

- **Outcome:** mechanical verification is scripted; David's share of any UAT
  is the human residue only.
- **Scope:** the Playwright sandbox spike (approved) and CI lanes; an
  on-demand acceptance workflow separate from the PR gate; a
  production-configuration auth smoke (register, sign in, recover through the
  real entry points, not the dev-admin login); AI test doubles for enrichment
  and image generation at the provider seam; the Stripe stub (#566, plan to be
  approved); the sanitised legacy fixture from the dev snapshot (scrub design
  first); lane tags in `uat-doc-format.md` enforced by the checker;
  `pr-docs`/`uat` skills updated; ordinary free and paid test accounts as
  fixtures (never admin-only evidence for paid paths); every remaining backlog
  step mapped to one of the four dispositions.
- **Depends on:** Phase 1 (merged, #630).
- **David's batch:** the fixture privacy call (what is scrubbed); the #566 plan.
- **Exit evidence:** the backlog table shows a disposition per step; the
  acceptance workflow runs green on demand; a production-config auth journey
  passes in CI; the Stripe stub plan is approved and merged.
- **Tier:** internal, except the Stripe stub (sensitive: payments seam).
  **Lane:** prerequisite — first after Phase 1; product phases start only
  when it is done. Handbook-shaped parts (lane tags, the acceptance workflow,
  the readiness table as a reusable artefact) land in the handbook so a second
  app inherits them (the one named freeze exception).

## Settled, from the parent plan and the launch definition

- The four-lane model: a CI test for an invariant; a scripted proof with
  evidence, re-runnable on demand; a live check on the deployed origin;
  David's judgement. Only the first enters the per-PR gate.
- Four dispositions per remaining UAT step: automated assertion / recorded
  environment check / launch acceptance journey / deferred with its feature.
  A deferred step is never a pass.
- Paid paths are evidenced with ordinary free and paid test accounts, never
  admin-only evidence (admins are exempt from the budget gate).
- The 2026-08-28 decision's four excluded row classes (sessions and
  environment-bound auth state; non-terminal async jobs; child-safety records;
  live-mode payment obligations) are never copied anywhere.
- The child-safety boundary: no admin viewer for quarantined evidence, ever.
- No new external vendors without David.
- #566's recorded constraints: CI gets no Stripe credential in any form; a
  refusal must be fail-closed on an explicit positive signal, never inferred
  from a value.
```

## Preflight

**Increment test.** The approved Phase 2 bundles seven things that ship and
fail independently: the lane model in the UAT format, the acceptance
workflow, ordinary test accounts, the auth journey, three test doubles
(email, storage, AI), the legacy fixture, and the Stripe fake. One PR for
all of it would be unreviewable, and the Stripe fake alone took five review
rounds before it was split (#566). So this plan is the Phase 2 map: it
fixes the invariants every increment must keep, the order, and what each
proves; each increment ships as its own PR. **The Stripe fake keeps its own
sensitive-tier plan** (#566), because its design history and its payments
blast radius are too large to settle inside a map.

**Affected-surface inventory (oracles run 2026-10-07 at `31f770b`).**

- *External calls a journey can reach.* `git grep -n "fal\.\(subscribe\|queue\|storage\)\|openai\.\|new OpenAI\|fetch(" artifacts/api-server/src` plus a read of each hit: fal is called from nine modules, nearly all through the one shared client `falClient.ts` re-exports (`nsfwClassifier.ts` imports `@fal-ai/client` directly but accepts an injected client); OpenAI through two clients (`getOpenAIClient()` used by `utilityLLM.ts` with eleven importers and `openaiResponses.ts`; a second `new OpenAI` in `embeddings.ts`); plus Pexels, hCaptcha, Arachnid, NCMEC and the fal pricing warm-up. Anthropic's client is imported by nothing in the server.
- *Storage.* `objectStorage.ts:13-15`: the Replit sidecar to Google Cloud Storage is the only backend; `ObjectStorageService` is constructed with `new` at each call site; tests either stop before the storage call (`routes.storage.test.ts:4-8`) or skip without the sidecar (`moderation.quarantine.test.ts:27-29`).
- *Email.* `email.ts:121-134`: with no Resend key the message is logged, not queued; verification tokens are stored only as SHA-256 hashes (`localAuth.ts:62-66`), so a test cannot read a token back from the database.
- *Auth in a non-production boot.* Register needs no captcha (`localAuth.ts:91-211`); fact submission is gated by onboarding captcha (`reviews.ts:142-145`), which any token clears outside production when no secret is set (`captcha.ts:14-20`). The only seeding script mints the bootstrap admin (`scripts/seed-dev-admin.ts`).
- *Paid accounts.* Legendary is granted only through `membership_entitlements` and `recomputeMembership` (`admin.ts:1022`, `membershipSources.ts:616`).
- *Budget gate.* Admins are exempt by database row (`budgetGate.ts:159-166`, `isRealAdminRow`), so admin evidence says nothing about the gate.
- *Browser suites.* Five Playwright specs; four run in CI and all authenticate as the bootstrap admin. The spike ran those four in this container: **22 passed in 5.2 minutes** against a locally booted stack with the preinstalled Chromium. The two upload specs #562 called "blocked" were deleted in #563 (`git log --diff-filter=D`, commit `507ddd4`); storage journeys here are new.
- *Production detection.* `env.ts:23-24`: `isProductionEnv()` is `REPLIT_DEPLOYMENT === "1" || NODE_ENV === "production"`. The CI E2E job boots `NODE_ENV=development` with dev-admin login on, so it proves nothing about a production configuration.
- *fal boundary.* `falClient.ts` configures and re-exports the one shared `fal` client, and most callers import it from there; `ensureFalConfigured()` requires a key before a caller reaches it; `nsfwClassifier.ts` imports the SDK directly but takes an injected client; pricing is a separate HTTP path (`falPricing.ts:43`); image generation downloads the returned URL before storing the bytes (`imagePromptJobs.ts:362-365`, `:624`).
- *UAT backlog.* `ls docs/tests/UAT`: **30 docs** (PRs 213–602). #562's re-disposition table covers 22; five are newer (577, 582, 585, 600, 602) and three were retired but not deleted (213, 214, 394).
- *UAT format.* `scripts/check-uat-format.mjs` enforces filename, title, Setup/Steps/Regression and one Do/Expect per step; it has no notion of lanes or dispositions.

## Problem

David is the slowest part of the system and is currently its main verifier.
Thirty UAT documents hold roughly 230 manual steps nobody has run, most of
them mechanical. They are manual because the things a real user does —
sign up, verify an email, upload a photo, make an image, pay — cannot be
driven by a script without real external services: there is no storage, AI,
email or Stripe double, no ordinary test user, and every browser test signs
in as the admin, who is exempt from the budget gate. Every launch phase after
this one would add to the pile.

## Direction

`launch-definition.md`, *Verification is a prerequisite*: every later phase
ships with its mechanical checks scripted, and David's share of a UAT is the
human residue. Phase 2 delivers reusable verification infrastructure and proves it
through a named baseline of journeys that exist today. Later product phases
add their mechanical checks as they build the corresponding behaviour, on
this infrastructure. Existing backlog steps keep an explicit disposition,
owner and evidence status; deferral never supplies passing evidence.

## Product Intent

When Phase 2 is done:

1. A UAT step is written in one of four lanes, and the checker refuses a
   step without one. Only the human lane reaches David.
2. A Playwright or API test can create an ordinary **free** and an ordinary
   **paid** user, sign in through the real entry points, and run the
   **baseline journeys** below — in CI and in this container, with no
   external credential and no outbound request.
3. An on-demand acceptance run, separate from the per-PR gate, runs the
   baseline and reports green only when every baseline journey ran and
   passed; a skipped or missing journey makes the run incomplete, never
   green.
4. A legacy fixture lets those runs execute against the row shapes the real
   catalogue has, not only against a freshly created database.
5. Every remaining step of the 30 UAT docs carries one of the four
   dispositions; the mechanical ones are scripted or have a named owner
   phase; a deferred step is never a pass.
6. The lane model, the acceptance workflow and the readiness table live in
   the handbook, so a second app inherits them.

## The baseline journeys

These are the journeys that prove the facilities work together. Each names
its observable outcome; a recorded call to a double is never the outcome.

1. **Production-configuration account.** Against a server in production
   mode: register and verify through the real frontend and server entry
   points, following the link from the captured email; cookie-based sign-in;
   a protected action; sign-out; password recovery through the captured
   link; sign-in with the new password succeeds and with the old one is
   refused; the dev-admin login is unavailable.
2. **Free user submits a fact.** Onboarding, submission, and the submission
   appearing in the moderation queue.
3. **Moderation with AI doubles.** An admin takes that submission through
   triage, preparation and test renders to an active fact, with tokenising,
   enrichment and rendering served by the doubles and the renders stored and
   readable.
4. **Free user makes and saves a photo meme.** An ordinary free account
   uploads a synthetic image and uses the existing photo-meme builder to
   save a public meme; its permalink and rendered image are readable. The
   baseline uses the normal free-account permissions. (Building from a
   fact's approved hero renders is Phase 7's offering, not this baseline.)
5. **Free user is refused paid generation** by the gate that applies to
   them, with the refusal the product shows.
6. **Paid user generates and saves an AI image meme.** An ordinary paid
   account reaches a completed, stored, readable generation, with spend
   recorded against that user. It saves a private meme; the owner can read
   its permalink and image, and another ordinary user is refused.
7. **Photo upload.** An ordinary user uploads a photo; it is stored, readable
   by its owner, and not readable by another user.

Journey 1 joins the per-PR E2E job (it is an invariant). Journeys 2–7 form
the acceptance run. A later phase that changes one of these flows updates
its journey in the same PR.

## Must Not Change

- **Production behaviour.** No double is reachable from the deployment
  entrypoint in production. Two mechanisms, kept distinct:
  *deploy-selectable doubles* (storage, AI, and later the Stripe fake) are
  chosen at boot by an explicit positive signal and **refuse to start** in
  a production boot; *test-harness substitution* (the mail transport for
  journey 1) is installed only by a test launcher that imports the app
  itself — the deployment entrypoint has no path to it, so a production-mode
  server can run under test with only its mail transport replaced.
- **No credential in CI**, in any form, for any vendor (#566).
- **No real external effect from a test**: no email delivered, no image
  generated at a vendor, no object written to the real bucket, no Stripe
  call.
- **The child-safety boundary.** No quarantined evidence, NCMEC report or
  safety-ledger row enters a fixture, a log, a test artefact or the
  repository.
- **The four excluded row classes** of the 2026-08-28 decision never enter
  the fixture.
- The per-PR gate's required checks (`Build`, `Test`) and their runtime
  budget: acceptance journeys do not join the PR gate.
- Existing tests keep passing unmodified, except where an increment replaces
  a per-call-site test hook with the shared double and says so.

## Settled Decisions

- **Increments, in order** (each its own PR; later ones assume earlier ones):
  1. **Lanes.** The four lanes and four dispositions written into
     `uat-doc-format.md`; the checker enforces a lane per step; `pr-docs`
     and `uat` skills updated; the remaining-step disposition table for all
     30 docs. Internal; handbook-shaped parts land in the handbook.
  2. **Test accounts and the mail sink.** A seeding path for an ordinary
     free and an ordinary paid user, paid granted through the entitlement
     model (never by setting a tier); a test launcher that boots the real
     app in production mode with only the mail transport replaced, below the
     email queue so the queued delivery path runs; baseline journey 1 in the
     per-PR E2E job. **Sensitive tier** — it touches the auth and email
     path. Its first check is feasibility: that a production-mode server,
     with its real cookie configuration, issues a cookie the test browser
     keeps on a local origin (`unable to verify` until run). A failure comes
     back for reconsideration; authentication is never weakened to pass.
  3. **Storage double.** A local backend behind the storage service, selected
     outside production, so upload, avatar and meme-save paths run without
     the sidecar; new storage journeys (6 and 7).
  4. **AI doubles.** Deterministic stand-ins at the existing provider
     boundaries — the shared fal client (extended, not replaced), the shared
     OpenAI client and the embeddings client — so the journeys run without a
     vendor. **Coverage rule:** for each baseline journey the selected
     double is available without credentials (including the configured-key
     checks in front of the clients), supplies the responses and local media
     the journey needs (including the image a render downloads), and
     supports one representative provider failure; unconfigured operations
     fail visibly; authentication, authorisation, orchestration, persistence
     and serving stay real. The pricing warm-up does not reach out.
     **Shapes come from reality** (David, 2026-10-08): each double's
     responses are built from responses recorded from the real vendor,
     never written from memory, and the recording says when and against
     which client version it was taken.
  5. **Legacy fixture.** The scrub design first (David's privacy call), then
     the fixture and a loader.
  6. **Acceptance workflow.** An on-demand GitHub workflow and a local
     command that run baseline journeys 2–7 against the doubles (and the
     fixture), with evidence uploaded; never a required check. **Any
     unexpected outbound request fails the run**, even when application code
     catches the error — detected outside the app, not by the doubles'
     own records. **A live check** (David, 2026-10-08) runs the same
     journeys against the real vendors with test credentials, on the Repl
     and never in CI, on demand: before each launch stage and whenever a
     vendor client library is upgraded. It is the only evidence that the
     real vendor still accepts our requests in the recorded shape.
  7. **Burn-down.** Each remaining step scripted into the lane its
     disposition names, or explicitly deferred to its owner phase. Run as
     two pull requests, 7a (the reading) and 7b (the checks), on the
     sub-plan `docs/plans/PLAN_PHASE2_INC7_BURN_DOWN.md` (David,
     2026-10-14).
  8. **Capture and read** (David, 2026-10-14, amendment v5: "there are
     tests that I'm still being asked to do that seem like they are simply
     you running the program and taking a screenshot of something … that
     needs to be a piece of what you can accomplish"). A UAT step whose
     `Expect` needs a screen looked at but no product or taste judgement is
     verified by a machine capture that Claude reads, not by David. Increment
     7a counts the class; increment 8 builds the capture run, the lane-model
     change in the handbook (format, checker, `/uat`) and the capture
     scripts, on its own short sub-plan; 7b and 8 land in either order.
  The Stripe fake (#566) runs on its own sensitive plan in parallel with
  increments 2–8. **It gates only Phase 10 (membership)** (David,
  2026-10-08, changing the parent's sequencing: "Gate only Phase 10"):
  Phases 3–9 start once increments 1–8 land; checkout, webhook, cancel,
  refund and dispute evidence waits for Phase 10, which owns it.
- **One selection rule for every double**, so there is one thing to audit:
  a double is chosen only by an explicit environment value naming it; an
  unrecognised value refuses to boot everywhere; any double named in a
  production boot refuses to boot. Nothing is inferred from a key prefix,
  a hostname or a connection string — the lesson of the deleted
  `assertNotProductionDb.ts` (#563).
- **Doubles sit at the seam the production code already crosses**, not at
  each call site: the storage service, the email transport, and — for AI —
  the vendor clients (the shared fal client, extended; the two OpenAI
  clients). The exact adapter shape is the AI increment's technical
  decision, settled there with Astra and recorded with its reason.
- **Ordinary accounts are the evidence for paid paths.** No paid-path step is
  dispositioned "automated" on admin evidence.
- **The acceptance run is evidence, not a gate.** It records what ran, on
  which commit, against which fixture, and what each journey saw.
- **Three records, never merged:** a step's **lane** (where and how it is
  verified), its **disposition** (how the backlog obligation is handled),
  and its **result** (what actually ran and its evidence, or why it is still
  outstanding). An automated step names the check that covers it. `/uat`
  presents only the human residue, and keeps unresolved machine and live
  checks visible beside it.

## Data Model and Migration Impact

None planned. The doubles hold their state outside the product schema
(files, process memory, or tables the double owns in a test database
only). If the mail sink or the storage double needs a table, it is created
only in non-production databases and is named as such; any increment that
finds it needs a product-schema change stops and comes back.

## Security, Permissions, and Validation

- The selection rule above is the security boundary. It is enforced by a
  **construct** — a boot-time refusal — not by convention; each increment
  that adds a double adds its row to that refusal and a test that a
  production boot naming it exits before listening.
- The mail sink stores message bodies that contain live verification and
  reset links. It is reachable only in a non-production boot, never through
  an HTTP route an ordinary user can call, and its contents are never
  uploaded as a CI artefact.
- The storage double never serves an object an ordinary user could not read
  through the real access layer (`objectAccess.ts`); access checks run
  unchanged above it.
- The fixture is published in a public repository: whatever it contains is
  public. Its scrub is designed and approved before any row is extracted.

## Testing Plan

Each increment proves its own invariant, with the negative case:
the double is selected when named, refused when unrecognised, refused in
production; a journey that would reach a vendor reaches the double instead
(asserted by the double recording the call, not by the absence of an
error). The acceptance workflow is run green on demand once before Phase 2
closes. The auth journey joins the per-PR E2E job, because it is an
invariant, not a scenario.

## The legacy fixture: what is designed now, what David decides

Fixed whatever David chooses: the export is an **allowlist** — only named
tables and columns leave the source, so an excluded class (sessions and
auth state, non-terminal jobs, child-safety records, live-mode payment
obligations) never enters even an intermediate file; personal identities,
credentials, emails, IP data and Stripe identifiers become synthetic;
uploaded and generated media become synthetic local placeholders so every
media reference in the fixture resolves locally; relationships and
structural variation (old enrichment versions, waivers, stale renders,
partial states) are preserved. The fixture is extracted only after the
scrub is approved.

## Questions for David

**Answered 2026-10-08:** question 1 — option 1 (shapes only, committed,
approved live fact text kept); question 2 — option 1 (the Stripe fake gates
only Phase 10).

1. **What may the fixture keep?** The repository is public.
   1. *Shapes only, committed; approved live fact text kept* (rejected,
      pending and reported facts get placeholder text). CI runs against it.
      **Recommended:** approved facts are meant to be public, and their real
      wording keeps the grammar and rendering edge cases that have broken
      before.
   2. *Shapes only, committed; all fact text synthetic.* Nothing of the
      catalogue published early; wording-dependent bugs missed.
   3. *A private scrubbed copy on the Repl only.* Closest to real; CI never
      sees it, so CI loses the legacy-fixture coverage this phase promises —
      that option changes the evidence available, not just where a file
      lives.
2. **Proposed change to the approved sequencing: what the Stripe fake
   gates.**
   1. *Only Phase 10 (membership).* Phases 3–9 start once increments 1–7
      land. What is unavailable meanwhile: checkout, webhook, cancel, refund
      and dispute evidence — all Phase 10's own scope. Paid-path journeys
      (6) still run, because paid users are granted through the entitlement
      model, not Stripe. **Recommended by Claude.**
   2. *Keep the approved gate* — no product phase starts until it merges.
      **Recommended by Astra**, as the agreed order.
   3. *Fold it into Phase 10.*

## Definition of Done

The parent's exit evidence, made concrete: every remaining step of the 30
docs has a lane, a disposition and a result (an automated one naming its
check); the acceptance workflow ran journeys 2–7 green on demand with no
unexpected outbound request; journey 1 passes in the per-PR E2E job; the
Stripe fake is not part of Phase 2's exit; it gates Phase 10 (David,
2026-10-08). **And a second-consumer check** (David, 2026-10-11, approving
the amendment proposed from the DojoOS assessment): increment 6 writes the
acceptance-workflow and live-check contracts product-neutral, and Phase 2 is
done only when the handbook-shaped parts (lane tags, the acceptance workflow
shape, the readiness table, the double-selection rule, the test-database
marker, the launcher pattern) are read against DojoOS's planning docs and
either serve it unchanged or name, in #631, the DojoOS-specific piece they
leave to its own harness increment (the two-process async harness, media
probes and generated fixtures, voice and transcription doubles). Journey 6
and the two gaps recorded on #637 (allowlisted boot env, journeys 1 and 7;
`STORAGE_DOUBLE_DIR=/` refusal) are increment 4's and 6's, as their thread
replies say. **And increment 8 has landed** (amendment v5, David,
2026-10-14): no step whose only obligation is a screen looked at is left in
David's share of a UAT.
