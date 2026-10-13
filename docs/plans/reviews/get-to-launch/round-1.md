The phased approach serves the agreed outcome, and it incorporates the substantive S2–S5 changes. I would revise the soft-launch gates before presenting it for approval. One external constraint also needs David’s decision: Stripe’s supported testing approach conflicts with the oracle’s literal requirement for a complete live-mode rehearsal.

**S6 — The soft-launch table introduces unapproved reductions in readiness.**  
*Resolve before approval; any deliberate reduction is David’s decision.*

The [readiness table](/home/user/Overhypeme/docs/plans/PLAN_GET_TO_LAUNCH.md:588) makes security review a “should” for soft launch and reduces compliance to “pages live.” Phase 18 likewise depends on Phase 14’s pages, while Phase 15 is explicitly gated only on full launch.

Those are consequential choices. Friends will create durable accounts, submit content and upload photographs; public shared pages remain accessible outside the invited group. Test-mode payments do not remove those exposures. Published policies also cannot substitute for an operational safety procedure: the current [reporting implementation](/home/user/Overhypeme/artifacts/api-server/src/lib/moderation/ncmec.ts:1) still records a report and sends an administrative email without filing it.

S1 settled the invitation boundary and requested explicit evidence timing. Its recorded decision does not authorize accepting unresolved high security findings or an unfinished safety capability.

My proposed replacement principle is:

> Soft launch opens with the full agreed feature build, the security review completed with no open highs, and the operational compliance controls needed for real accounts, contributions and uploads. If the selected NCMEC path is manual, its counsel-confirmed procedure must already be usable. The invited trial then supplies the 50 approved facts, real-data verification and friend-operated test-mode payment evidence. Full-launch-only obligations remain explicitly outstanding.

The complete admin offering belongs in that full build. Phase 13’s dashboard, moderation rebuild and user help currently have no explicit dependency leading into either launch; include its completion in the soft-launch gate.

Distinguish **opening the trial**, **completing its evidence**, and **opening full launch**. That preserves the useful timing distinction without lowering the protections silently. If Claude intends the weaker security or compliance bar, present the specific exception and its practical consequences to David.

**S7 — Replace the unsupported live Stripe rehearsal with an explicit evidence decision.**  
*Decision for David; resolve before approval.*

[Phase 19](/home/user/Overhypeme/docs/plans/PLAN_GET_TO_LAUNCH.md:574) requires a real purchase, failed payment, refund, dispute and failure-recovery scenarios in live mode. This faithfully repeats the oracle, but current Stripe documentation says testing with real payment details in live mode is prohibited; its supported simulated declines and disputes use test credentials and test payment methods. [Stripe testing documentation](https://docs.stripe.com/testing)

This is an oracle problem, not something the builder should silently reinterpret. Manufacturing a live dispute is not an appropriate prerequisite for opening the service.

I recommend this evidence split:

- Prove the monthly lifecycle and adverse-event handling using Stripe test mode, including duplicate/out-of-order delivery, interrupted processing and the reconciliation runbook.
- Demonstrate that retained soft-launch test purchases cannot grant live-mode benefits when production switches modes.
- Verify the deployed live account, monthly price, credentials, webhook configuration and boot guard; observe genuine live payments under the launch watch.

**David’s decision:** may the readiness criterion use that supported evidence split instead of requiring every adverse event to occur in live Stripe before launch? I recommend yes. The accepted limitation would be explicit: live configuration is verified, but every adverse payment outcome has not occurred against real money before the first genuine customer payment.

If approved, update the oracle deliberately and align Phases 10/19 and readiness row 3. Calling test-mode evidence “live” because the application is deployed would not resolve this.

**S8 — Geography blocking needs a deployment-boundary proof.**  
*Resolve during implementation of the programme, in the compliance/security child planning and before enabling the geographic restriction.*

Phase 14 chooses Cloudflare enforcement. The checkout also explicitly allows a separate Replit origin in [.replit](/home/user/Overhypeme/.replit:166). The [Express Origin checks](/home/user/Overhypeme/artifacts/api-server/src/app.ts:212) do not establish that traffic passed through Cloudflare.

That does **not** prove a currently reachable bypass: my attempt to inspect the alternate origin could not establish its live reachability. It does identify the smallest useful investigation. Establish which production origins serve the application and API, then ensure the geographic rule cannot be bypassed through an alternate public origin.

Add that deployment proof to the phase’s acceptance evidence. The precise mechanism can remain with the child plan; inability to enforce the agreed boundary would require reconsideration rather than treating a successful Cloudflare rule configuration as completion.

For the same practical reason, Phase 6’s crawler fixture should be supplemented by a deployed check that retrieves both the OG shell and its advertised image through the real domain. The [existing Worker](/home/user/Overhypeme/cloudflare/og-router/src/index.ts:12) specifically handles platform-injected cookies and edge delivery, which an origin-only fixture cannot establish.

**Disposition of the earlier concerns**

- **S2: addressed in the parent plan.** Phase 3 owns bootstrap, legacy upgrade, DB/media restore and excluded-data checks; the reset precedes invited contributions.
- **S3: addressed in the parent plan.** Publication assets are distinguished from personal media, and candidate-engine evaluation is recognized as implementation work. Aspect ratios and waiver fallback remain properly reserved for the image-phase decisions.
- **S4: addressed in the parent plan.** Phase 11 separates service exposure from customer allowances and requires concurrency, retry, restart, pricing-failure and accounting-failure evidence.
- **S5: addressed in the parent plan.** Deletion is staged and resumable, preserves safety records and retains unresolved billing obligations; published-contribution fate remains David’s decision.

These dispositions concern the proposed work, not proof that the capabilities already exist. I would preserve those choices and the four-lane verification model. The next useful action is to correct the soft-launch handoff and bring David the concrete Stripe evidence decision; detailed schemas and algorithms can remain with the child plans.