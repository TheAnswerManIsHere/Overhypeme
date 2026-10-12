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
