Yes—this programme should exist, and the agreed feature set provides a useful boundary. The repository supports detailed parent planning now; it does not support treating this as a final cleanup pass. Several launch requirements change how content is published, access is granted and money is spent. I would keep the approved scope and make those dependencies explicit.

One product choice needs David before the parent plan is approved: **what the soft-launch invite gate blocks**. Other unresolved product details can stay in the agreed batches at phase boundaries.

**S1 — Define the invite boundary and when launch evidence is required.**  
*Decision for David; resolve before parent approval.*

The existing sharing path deliberately serves anonymous visitors and social crawlers. The [Cloudflare worker](/home/user/Overhypeme/cloudflare/og-router/src/index.ts) routes crawlers to public meme previews. A gate covering every page and image would therefore change what the soft launch can demonstrate about sharing and Open Graph.

David’s practical choice is:

- **Public shared-page previews and OG cards, with invitations required for registration and participation.** My recommendation: it permits a realistic share-loop rehearsal while controlling who joins.
- **Everything behind invitations.** This keeps the trial closed, but some public sharing evidence must be obtained separately before full launch.

Neither interpretation is settled by “invite gate”; the plan should not choose silently.

The same readiness list can serve both launches, but it needs explicit timing and payment mode for each piece of evidence. Distinguish opening the invited trial from completing its real-data verification, and distinguish checks on the deployed application from Stripe **live-mode** checks. A full-launch requirement awaiting execution must remain visibly outstanding rather than become a soft-launch “pass.”

**S2 — Put the durable-data boundary before invited users contribute.**  
*Resolve before parent approval; this follows an existing decision.*

The [2026-08-28 decision](/home/user/Overhypeme/docs/ai-context/decisions.md:323) expires when real user accounts, content, payments or safety records exist—not merely when the public gate comes off. Friends submitting the first 50 facts cross that boundary.

Consequently, the production reset and launch rehearsal belong before collecting those contributions. Any preliminary invited seeding must already receive the preservation guarantees intended for soft launch. A second reset between soft and full launch cannot be assumed.

The fresh-build prerequisite is real: [migration 0001](/home/user/Overhypeme/lib/db/migrations/0001_soft_delete_facts_users.sql) starts by altering existing tables. The current test setup uses schema push followed by migrations, so a passing integration suite alone will not demonstrate the proposed production bootstrap.

The parent should give one phase responsibility for:

- Building an empty environment from code, including required configuration and database protections.
- Proving the upgrade path using the sanitised legacy fixture.
- Rehearsing database **and media** restoration.
- Applying the four excluded-data-class checks before replacing existing production.

These are complementary proofs. They need not become a general migration-tooling rewrite.

**S3 — Plan the image offering as a connected publication change, including a bounded eval extension.**  
*Reserve the work in the parent; resolve consequential design before image-phase approval.*

The repository confirms that approved hero options are not simply an existing gallery awaiting a new label. In [imagePromptJobs.ts](/home/user/Overhypeme/artifacts/api-server/src/lib/imagePromptJobs.ts:403), moderation renders deliberately skip the shared gallery. Ordinary generations can instead be appended to `facts.aiMemeImages`, alongside separate ownership records.

The phase must establish the distinction between **published, moderator-approved fact assets** and **a user’s own uploads or generations**. That boundary must reach the wizard, preview/save/render paths, personal library, refresh workflow and deletion behaviour. Merely exposing test-render paths or filtering the current gallery in the UI would not achieve the oracle.

The engine-evaluation premise also needs a correction in the workload estimate. The [existing eval runner](/home/user/Overhypeme/artifacts/api-server/src/lib/eval/evalRunJobs.ts) evaluates the current pipeline, and the [render worker](/home/user/Overhypeme/artifacts/api-server/src/lib/imagePromptJobs.ts:328) selects Nano Banana 2 directly. Comparing candidate engines through that dashboard requires an extension; it is not currently an operator-only comparison exercise.

Reuse the dashboard, attempts, catalogue and planner/compiler separation. Sequence candidate-engine support and evaluation before preset tuning and representative-render acceptance. Keep aspect-ratio handling and the missing/waived-hero experience as explicit image-phase product decisions; neither templates nor unapproved renders may quietly become the fallback.

**S4 — Keep spend hardening distinct from the customer allowance.**  
*Resolve the coverage and enforcement approach before spend-phase approval.*

The dedicated spend phase is justified by code, not just precaution:

- [checkBudget](/home/user/Overhypeme/artifacts/api-server/src/lib/budgetGate.ts) compares proposed cost with **completed, recorded spend**, without reserving capacity for concurrent work.
- Administrators are exempt from that check.
- [resourceGovernance.ts](/home/user/Overhypeme/artifacts/api-server/src/lib/resourceGovernance.ts) holds its accounting in process memory.
- The inspected asynchronous image worker calls the provider without using that budget/ledger mechanism.

A monthly face-render meter therefore cannot by itself establish “no runaway cost.” The phase should cover the retained provider-call paths, including moderation, evaluation and automated work, and distinguish account entitlements from the service’s overall spending ceiling and emergency stop.

Its completion evidence should demonstrate a bounded financial exposure under simultaneous requests, retries, restart, unavailable pricing and failed accounting. The precise reservation/reconciliation mechanism belongs in that phase’s plan. Deleting video reduces the coverage required; it does not remove the remaining problem.

**S5 — Account deletion crosses billing, media and safety boundaries.**  
*Resolve before account-lifecycle phase approval; batch the product decisions there.*

The inventory’s suggestion that self-service deletion can reuse admin deletion needs qualification. The [current hard-delete route](/home/user/Overhypeme/artifacts/api-server/src/routes/admin.ts:582) continues after storage or Stripe cancellation failures, then removes the user and cascading entitlement records. It also leaves shared content in place with author references nulled.

That is evidence for reusing useful primitives, not exposing the existing operation through a new button. Otherwise a cancellation failure can leave an external billing obligation after its local recovery information has disappeared.

The phase needs an explicit outcome for partial deletion, recoverable external obligations and retained safety records. David should decide the user-visible fate of published contributions in the scheduled account/compliance batch; “self-service account deletion” alone does not settle that. The existing [safety boundary](/home/user/Overhypeme/docs/ai-context/legal-safety-moderation.md) remains binding, including the prohibition on an evidence viewer.

Beyond these concerns, there is substantial machinery worth retaining: the moderation state machine, permission resolver, membership derivation, reaction storage, email transport and queue. For example, [Fact of the Day](/home/user/Overhypeme/artifacts/api-server/src/jobs/factOfTheDay.ts) already sends personalised facts; the launch change is its consent-based audience, links and unsubscribe behaviour. The approved dashboard and moderation UX rebuilds can sit over retained domain mechanisms.

I recommend that Claude’s parent plan map the 222 decisions to bounded phases, dependencies, batched decisions and observable exit evidence. Keep the four verification lanes, ordinary free/paid accounts and the afternoon-sized human acceptance pass. Bound cleanup to the agreed cuts and their dependencies; keep future-tier and adult-content design from becoming premature feature implementation.

This assessment establishes that planning is warranted and identifies consequential dependencies from source inspection. It does not establish live readiness, restore success or compliance. The next useful artifact is the parent plan with the invite choice exposed and these boundaries incorporated—not another broad discovery exercise.