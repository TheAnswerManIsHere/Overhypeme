The revision substantially addresses the earlier concerns. One baseline journey still pulls future product behavior into Phase 2 and assigns private-meme success to a free account. Correct that before approval. David’s fixture choice, #566 plan approval, and any change to the approved Stripe sequencing remain his decisions.

I compared the complete revised plan with the preserved first-round version and inspected the relevant code at `31f770b`, matching the plan’s recorded checkout. The reported browser spike remains supplied evidence; I did not rerun it.

**P2-2 — Evidence accounting is addressed; the baseline still needs one scope correction. Resolve before approval.**

The named journeys, separate lane/disposition/result records, and refusal to count missing journeys as green resolve the earlier evidence ambiguity. However, [journey 4](/home/user/Overhypeme/docs/plans/PLAN_PHASE2_VERIFICATION.md:156) describes a free user making a meme from the fact’s existing renders, with owner-only access when private.

That combines two capabilities the proposed ordinary free-account baseline cannot demonstrate as written:

- **Moderation renders are not yet a free-user builder source.** The current wizard offers stock photos, the user’s uploaded photos, and entitled AI styling. Its stock picker reads Pexels images; its photo picker reads the user’s uploads. Publishing approved moderation renders into the builder is explicitly part of [Phase 7’s publication model](/home/user/Overhypeme/docs/plans/PLAN_GET_TO_LAUNCH.md:432). The current source selection is visible in [Step2Image.tsx](/home/user/Overhypeme/artifacts/overhype-me/src/components/meme-builder/wizard/step2-image/Step2Image.tsx:517).
- **Private creation requires the private-visibility entitlement.** The default registered-account permissions do not grant it, and [createMemeRecord.ts](/home/user/Overhypeme/artifacts/api-server/src/lib/createMemeRecord.ts:208) rejects an explicit private request without it. The frontend now follows that same entitlement.

Leaving this unchanged risks pulling Phase 7 into its own prerequisite, or constructing special test inputs that pass without proving the ordinary user journey. The correction is small and reduces implementation scope.

Suggested replacement passages, **not yet incorporated**:

> **Journey 4 — Free user makes and saves a photo meme.** An ordinary free account uploads a synthetic JPEG and uses the existing photo-meme builder to save a public meme. Its permalink and rendered image are readable. The baseline uses the normal free-account permissions.

> **Journey 6 — Paid user generates and saves an AI image meme.** An ordinary paid account reaches a completed, stored, readable generation, with spend recorded against that user. It saves a private meme; the owner can read its permalink and image, while another ordinary user is refused.

Journey 7 can retain its separate assertion that the underlying uploaded photo is owner-only. This keeps storage, generation, saving, and privacy covered without implementing the later hero-image offering. If bringing that offering forward is intentional, that is a scope decision for David.

**The other earlier concerns have the following disposition.**

- **P2-1: addressed at the design level.** Test-launcher mail substitution below the queue resolves the production-mode contradiction without making a deployment-selectable production double. Cookie feasibility remains explicitly unverified. Resolving that as the increment’s first implementation check is reasonable, provided success uses the real cookie configuration and failure returns for reconsideration rather than weakening authentication.
- **P2-3: addressed.** Extending the existing provider boundaries, covering credential checks and downloaded media, and independently detecting unexpected outbound requests provides the needed coverage rule. Adapter details can remain implementation work.
- **P2-4: the documentation concern is addressed; David’s sequencing decision remains open.** The approved Stripe prerequisite now unambiguously stands until he changes it. My recommendation remains to retain that gate.
- **P2-5: the technical export principles are addressed; privacy approval remains open.** The allowlist, excluded classes never entering intermediate exports, synthetic identities/media, and approval before extraction are appropriate. If David selects the Repl-only option, the final plan must explicitly reflect that CI will lack the promised legacy-fixture coverage; that option changes the evidence available, not just where a file lives.

After correcting the baseline, I recommend returning the plan to David with those outstanding choices. The correction does not require another full assessment solely to incorporate the wording, and concluding this technical discussion does not approve implementation.