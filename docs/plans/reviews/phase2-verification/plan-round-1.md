# PLAN — Launch Phase 2: the verification build · v1

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

- *External calls a journey can reach.* `git grep -n "fal\.\(subscribe\|queue\|storage\)\|openai\.\|new OpenAI\|fetch(" artifacts/api-server/src` plus a read of each hit: fal is called from nine modules with no shared call seam (`falClient.ts` only configures it; `nsfwClassifier.ts` imports `@fal-ai/client` directly); OpenAI through two clients (`getOpenAIClient()` used by `utilityLLM.ts` with eleven importers and `openaiResponses.ts`; a second `new OpenAI` in `embeddings.ts`); plus Pexels, hCaptcha, Arachnid, NCMEC and the fal pricing warm-up. Anthropic's client is imported by nothing in the server.
- *Storage.* `objectStorage.ts:13-15`: the Replit sidecar to Google Cloud Storage is the only backend; `ObjectStorageService` is constructed with `new` at each call site; tests either stop before the storage call (`routes.storage.test.ts:4-8`) or skip without the sidecar (`moderation.quarantine.test.ts:27-29`).
- *Email.* `email.ts:121-134`: with no Resend key the message is logged, not queued; verification tokens are stored only as SHA-256 hashes (`localAuth.ts:62-66`), so a test cannot read a token back from the database.
- *Auth in a non-production boot.* Register needs no captcha (`localAuth.ts:91-211`); fact submission is gated by onboarding captcha (`reviews.ts:142-145`), which any token clears outside production when no secret is set (`captcha.ts:14-20`). The only seeding script mints the bootstrap admin (`scripts/seed-dev-admin.ts`).
- *Paid accounts.* Legendary is granted only through `membership_entitlements` and `recomputeMembership` (`admin.ts:1022`, `membershipSources.ts:616`).
- *Budget gate.* Admins are exempt by database row (`budgetGate.ts:159-166`, `isRealAdminRow`), so admin evidence says nothing about the gate.
- *Browser suites.* Five Playwright specs; four run in CI and all authenticate as the bootstrap admin. The spike ran those four in this container: **22 passed in 5.2 minutes** against a locally booted stack with the preinstalled Chromium.
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
human residue. This increment makes that possible: after it, a script can
drive an ordinary user through every journey the launch scope names, with no
credential and no network, and every existing UAT step has a stated lane.

## Product Intent

When Phase 2 is done:

1. A UAT step is written in one of four lanes, and the checker refuses a
   step without one. Only the human lane reaches David.
2. A Playwright or API test can create an ordinary **free** and an ordinary
   **paid** user, sign in through the real entry points, and complete the
   journeys a real user takes, including email verification, password
   recovery, photo upload and image generation — in CI and in this
   container, with no external credential.
3. An on-demand acceptance run, separate from the per-PR gate, drives those
   journeys end to end and reports green or red with evidence.
4. A legacy fixture lets those runs execute against the row shapes the real
   catalogue has, not only against a freshly created database.
5. Every remaining step of the 30 UAT docs carries one of the four
   dispositions; the mechanical ones are scripted or have a named owner
   phase; a deferred step is never a pass.
6. The lane model, the acceptance workflow and the readiness table live in
   the handbook, so a second app inherits them.

## Must Not Change

- **Production behaviour.** No double can be selected in production. Every
  double is chosen at boot by an explicit positive signal outside
  production, and a production boot that names one **refuses to start**
  rather than ignoring it.
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
     model (never by setting a tier); an email sink selected outside
     production that records outgoing messages so a test can follow a
     verification or reset link. The production-configuration auth journey
     (register, verify, sign in, sign out, recover) runs in CI. **Sensitive
     tier** — it touches the auth and email path.
  3. **Storage double.** A local backend behind the storage service, selected
     outside production, so upload, avatar and meme-save paths run without
     the sidecar; the two blocked Playwright specs return.
  4. **AI doubles.** Deterministic stand-ins for the AI and image providers
     so enrichment, tokenising, the visual pipeline and image generation run
     without a vendor.
  5. **Legacy fixture.** The scrub design first (David's privacy call), then
     the fixture and a loader.
  6. **Acceptance workflow.** An on-demand GitHub workflow and a local
     command that run the journeys against the doubles (and the fixture),
     with evidence uploaded; never a required check.
  7. **Burn-down.** Each remaining step scripted into the lane its
     disposition names, or explicitly deferred to its owner phase.
  The Stripe fake (#566) runs on its own sensitive plan in parallel; see
  the question for David below on what it gates.
- **One selection rule for every double**, so there is one thing to audit:
  a double is chosen only by an explicit environment value naming it; an
  unrecognised value refuses to boot everywhere; any double named in a
  production boot refuses to boot. Nothing is inferred from a key prefix,
  a hostname or a connection string — the lesson of the deleted
  `assertNotProductionDb.ts` (#563).
- **Doubles sit at the seam the production code already crosses**, not at
  each call site: the storage service, the email transport, and — for AI —
  the vendor clients. Where no single seam exists (fal is called from nine
  modules), the increment either creates one or substitutes at the network
  boundary; which is the AI increment's technical decision, settled there
  with Astra, recorded with its reason.
- **Ordinary accounts are the evidence for paid paths.** No paid-path step is
  dispositioned "automated" on admin evidence.
- **The acceptance run is evidence, not a gate.** It records what ran, on
  which commit, against which fixture, and what each journey saw.

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

## Questions for David

1. **The legacy fixture's privacy call.** Recommendation and options are in
   the chat readout.
2. **What the Stripe fake gates.** Recommendation and options are in the chat
   readout.

## Definition of Done

The parent's exit evidence: the backlog table shows a disposition per step
for all 30 docs; the acceptance workflow runs green on demand; a
production-configuration auth journey passes in CI; the Stripe fake plan is
approved and merged (subject to question 2).
