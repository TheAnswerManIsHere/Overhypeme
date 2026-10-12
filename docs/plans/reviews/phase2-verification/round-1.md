The direction serves David’s intent, and the split into separate PRs is sensible. I would preserve the ordinary-account fixtures, provider-level doubles, separate acceptance workflow, and privacy approval before extraction. Before this becomes a reliable build plan, it needs a workable production-config auth test and a more concrete definition of what a green acceptance run proves. David’s fixture decision and #566 plan approval remain outstanding; changing the Stripe prerequisite would be a separate decision.

I inspected checkout `31f770b`, which matches the plan’s recorded commit. I treated the reported Playwright spike as supplied evidence and did not rerun it.

**P2-1 — Reconcile the production-config auth smoke with the double prohibition. Resolve before approval.**

The plan requires the auth journey to consume verification/reset messages from a non-production mail sink, while requiring every production boot naming a double to refuse startup. It does not explain how the required production-config journey can run under those rules.

This matters because the existing E2E job explicitly boots `NODE_ENV=development` with dev-admin login enabled. Adding ordinary login steps to that stack would demonstrate ordinary authentication, but would not establish the promised production configuration. Production detection also includes `REPLIT_DEPLOYMENT=1`, through [env.ts](/home/user/Overhypeme/artifacts/api-server/src/lib/env.ts:23).

The mail seam needs a specific decision too. In [email.ts](/home/user/Overhypeme/artifacts/api-server/src/lib/email.ts:121), missing credentials bypass the queue and log the message. Replacing that fallback with a sink could let registration tests pass while leaving the normal queued delivery path unexercised.

My recommended approach is a dedicated auth-test harness that preserves production authentication and browser behavior while substituting only the mail transport through a test-owned mechanism unavailable to the deployment entrypoint. That requires reconciling the plan’s absolute prohibition with the distinction between a deploy-selectable double and test-harness substitution. An alternative is acceptable, but name it and establish its feasibility before leaving this decision to the builder.

The acceptance evidence should demonstrate:

- Registration and verification through the actual frontend and server entry points.
- Cookie-based sign-in, a protected action, and sign-out without injected sessions or Bearer tokens.
- Recovery through the captured email link, successful login with the new password, and rejection of the old password.
- Dev-admin login unavailable under the tested configuration.

This resolves one consequential configuration choice; it does not require an exhaustive auth redesign.

**P2-2 — Define the bounded acceptance suite and connect disposition to evidence. Resolve before approval.**

The plan promises that Phase 2 enables “every journey the launch scope names,” but that scope includes account deletion, rebuilt comments, changed image offerings, and other functionality assigned to later product phases. Conversely, its completion criteria allow a green acceptance workflow without identifying the required journeys or their observable outcomes.

The practical risk is twofold: unnecessary implementation of later features, or a small green suite being presented as evidence for a much larger outcome. Neither requires malicious behavior; both follow naturally from the current wording.

Proposed replacement for the direction:

> Phase 2 delivers reusable verification infrastructure and proves it through a named baseline of currently implemented journeys. Later product phases add their mechanical checks as they implement the corresponding behavior. Existing backlog steps retain an explicit disposition, owner, and evidence status; deferral never supplies passing evidence.

Name that baseline in this plan. It need not enumerate every assertion, but it should identify the current flows that prove the mail, storage, AI, free-account, and paid-account facilities work together. In particular, ordinary paid-account generation should reach a completed, readable stored result; ordinary free-account refusal should demonstrate the relevant gate. Recording a provider call alone does not prove either outcome.

Keep these concepts distinct in the readiness record:

- **Lane:** where/how verification runs.
- **Disposition:** how the backlog obligation is handled.
- **Result:** what actually ran and its evidence, or why it remains outstanding.

Require references from automated backlog steps to their checks, and make missing or skipped required journeys prevent a complete acceptance result. `/uat` should present only the human residue while retaining visibility of unresolved machine/live checks. This extends the existing step-based roll-up in [the UAT skill](/home/user/Overhypeme/.claude/skills/uat/SKILL.md:326), rather than building a second acceptance system.

One repository correction belongs here: I found the five named Playwright specs, with four selected by CI. I did not find two blocked storage Playwright specs to “return.” Identify those artifacts if they exist elsewhere, or describe these as new storage journeys.

**P2-3 — Extend the existing provider seam and account for work around it. Resolve the coverage rule before approval; adapter details during implementation.**

The fal inventory understates existing reuse. [falClient.ts](/home/user/Overhypeme/artifacts/api-server/src/lib/falClient.ts:27) imports and re-exports the shared client, and most inspected callers already use that export. The direct classifier import is an exception. Extending this boundary is a concrete starting point; nine calling modules do not by themselves justify a new abstraction or network-level emulator.

However, replacing client methods is insufficient unless provider availability checks and downstream work are included:

- `ensureFalConfigured()` requires a key before callers reach the client.
- The shared OpenAI client and the separate embeddings client also require credentials.
- Pricing uses a separate HTTP path.
- Image generation downloads returned image URLs before measuring and storing the bytes: [imagePromptJobs.ts](/home/user/Overhypeme/artifacts/api-server/src/lib/imagePromptJobs.ts:362).

These are reachable dependencies of the promised journeys. A nominally selected double can otherwise be bypassed, fail before invocation, or return a result that still requires external access.

Add a bounded rule:

> For each required journey, the selected test provider is available without vendor credentials, supplies the responses and local media needed by that journey, and supports the failure cases its checks exercise. Unconfigured operations fail visibly. Authentication, authorization, orchestration, persistence, and serving remain real.

For the isolated acceptance lane, also choose how unexpected external requests are detected and make them fail the run even if application code catches the error. A call recorded by one double does not establish that no other request escaped. This is particularly useful for background work and fixture-carried media references.

The exact fake response shapes and adapter interfaces can be settled during implementation. A supported success path plus a representative provider-failure path is enough to establish the mechanism; this does not warrant implementing complete vendor simulators or validating AI quality with canned output.

**P2-4 — Preserve the Stripe prerequisite unless David explicitly changes it. Decision for David only if a change is proposed.**

The oracle already says the Stripe stub plan is approved and merged before Phase 2 completes, and product phases start afterward. Running #566 in parallel is compatible with that. Making completion “subject to question 2” leaves the approved prerequisite uncertain.

My recommendation is to retain the existing gate. If Claude recommends allowing product phases to start earlier, present that plainly as a proposed change to David’s sequencing decision, including which payment evidence would remain unavailable. It cannot be settled as a technical scheduling preference.

The plan’s reference to options “in the chat readout” supplies neither the proposed change nor its consequences in this assessment package.

**The fixture decision should remain explicit and separate from engineering defaults.**

The “scrub design approved before any row is extracted” boundary is sound. I would recommend an allowlisted export that preserves representative structural variation and relationships while replacing personal identities, credentials, and media with synthetic equivalents. Which authored content may remain public is David’s privacy decision.

The approval package should contain the actual proposed retention/scrubbing choices, rather than only referring to an unavailable chat readout. The technical design should show how excluded row classes never enter an intermediate export, and how retained media references resolve locally. Detailed transformations can follow in the fixture increment, before extraction.

With those revisions, the plan can remain a compact Phase 2 map. It does not need seven exhaustive child designs, a complete vendor emulator, or another assessment solely to incorporate agreed wording. The useful next work is to resolve the auth configuration, specify the baseline evidence contract, and present David’s concrete privacy and any proposed sequencing choices.