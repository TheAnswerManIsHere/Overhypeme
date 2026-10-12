# Oracle — PR #630, Launch Phase 1 (Documentation class)

The decisions the prose records, quoted. The reviewed head is `971a97cc`.

1. **Plan approval (David, 2026-10-07):** "Approved. Mythos 5.1" — on the
   parent plan whose Phase 1 reads: "`product-direction.md`,
   `current-roadmap.md` and a new `docs/ai-context/launch-definition.md`
   carry the launch scope, the cuts, the readiness criteria with their
   per-stage and payment-mode columns, and the per-item decisions; the UAT
   backlog (#562) is re-dispositioned against the scope (deferred steps
   marked deferred, never passed). Scope: docs only. Also: `is_tester`
   removed from the docs; the video and OG-preview reversals and the
   hero-images-as-hard-gate decision recorded in `decisions.md` with David's
   words; the moderation docs' 'review tools, not hard gates' line updated
   for the hero scenario." Plan digest
   6386aad47e3b29c1504fe0a2c8e908be229da41a4529dec7996357876e324cb0.
2. **Hero hard gate (David, 2026-10-06):** "I don't think there's any concept
   of a no-hero fallback on a fact. We should define a successful fact
   moderation as having confirmed, approved hero images. Without them, the
   fact cannot go live."
3. **Stages and the bar (David, 2026-10-06):** "Seed -> Soft Launch -> Full
   Launch (US only) -> Full Launch (Global)"; "Hold the full bar prior to
   seed. There's no reason to seed prior."; "Seed should be able to make
   memes too".
4. **Retired features (David, 2026-10-06):** "any features/functions that we
   delete are still in the repository … don't want to throw the baby out
   with the bathwater."
5. **Key rotation (David, 2026-10-07):** "We should probably also rotate all
   keys." **Mythos:** "For Phase 15, I now have access to Mythos. I'd like to
   use it for defensive testing." Mythos 5.1 is the same model as Fable 5.1
   without the cyber-capability safeguards (anthropic.com/claude/fable).
6. **Geography (David, 2026-10-07):** "I'm happy to have users from anywhere
   other than GDPR and OFAC countries."
7. **Feature walk (David, 2026-10-05), as recorded per item in
   `docs/ai-context/launch-feature-inventory.md`** — including: "Sharing by
   email is critical. Any modality for sharing should be supported because
   growth is what will make the site valuable."; video deleted ("build the
   video pipeline from the ground up on top of the image pipeline");
   "Everything is test data" (monthly only); "super locked down and defined
   before we launch so that there's no runaway cost"; "I really want every
   fact attributable to a real user who isn't me"; `is_tester` removed from
   the docs; Pexels, templates, stock photos, merch, Debug mode and PuLID cut.

What the pass checks: that every prose change records one of these decisions
faithfully, contradicts no other live doc, and adds no decision David did not
make.
