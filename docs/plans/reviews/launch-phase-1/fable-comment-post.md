## Fable — round 1

*Assessed at `971a97cc86a8ed739e2ef6bd8768651d1ad9ff9f` · documentation pass over `58f38c891410802954cf6f74048d75607d109cad..971a97cc86a8ed739e2ef6bd8768651d1ad9ff9f` · expected `claude-fable-5-1` · instructed alias `fable` · definition effort `xhigh`*

Oracle met at this head: yes
_Running as: Claude Fable 5.1 (claude-fable-5-1) at unable to name._

## Readout for David

The documents say what you decided, and I checked that against the plan text you approved rather than against the builder's summary: the plan file sitting in the checkout hashes to exactly the digest pinned on #628, and the four stages, the readiness table, the cut list, the feature list and all seven new decision entries match it. The UAT backlog (#562) was re-dispositioned on the issue itself on 2026-10-07, with deferred steps marked deferred and none passed. The tester role is gone from every live document, and every copy of the old "review tools, not hard gates" rule was found and updated. Nothing in the prose adds a decision you did not make.

One correction is worth making before this merges, and it is the only one I would write for. The moderation docs, the glossary and the Manual now talk about "the hero scenario" as though the moderation pipeline already had one and the waiver currently covered it. It does not: the code has five render scenarios and none is a hero. "Hero renders" is a new idea — the approved moderation renders offered to free users — that the image phase will design, and "hero" already means two other things in this product (the home-page billboard fact, and the example media on the meme builder's first step). A moderator reading the admin Help, or the session that plans the image phase, would go looking for something that does not exist. A short glossary entry and three clause edits fix it. Two one-line edits ride along (D2, D3); neither would justify a batch on its own, and I say so below rather than pretending otherwise.

Also for you to know: the pull request's head is now one commit past the revision I was given. That commit regenerates the admin console's in-app Help from the Manual chapter this PR edits — CI requires the two to match, so a Manual edit is never "docs only" in this repository. I looked at it; it is the compiled chapter and nothing else. The PR body's line "No product code changed" is no longer literally true and should say what happened, and the D1 edit to the Manual will need the same regeneration.

## Scope of this assessment

- **What I assessed:** the diff `58f38c8..971a97c`, read in full, against the oracle and the approved plan. All conclusions below are from my own inspection of the checkout unless marked otherwise.
- **The head moved while both assessors were running.** The package was composed at 01:06 UTC; `git reflog` shows `4a66e30` committed at 01:08:00 ("Regenerate the help content from the Manual chapter 3 change"), and the REST read of PR #630 gives `head.sha = 4a66e30…`. That commit changes only `artifacts/overhype-me/src/generated/help/content/3-moderation.ts` and `searchIndex.ts` (`git show --stat`); its changed lines are the compiled chapter-3 HTML and the search-index text for the edited bullet. CI enforces the sync (`.github/workflows/build.yml:240-241`, `check:help-content`), so the commit was forced by the Manual edit, not optional. The ship-gate line above is for `971a97c`; the docs are byte-identical at both commits, so nothing below changes at `4a66e30`. I do not claim to have assessed the generated files beyond reading their changed lines.
- **The plan is in the checkout and digest-matches.** `docs/plans/PLAN_GET_TO_LAUNCH.md` is gitignored (`docs/plans/.gitignore:19`), present, and `sha256sum` gives `6386aad47e3b29c1504fe0a2c8e908be229da41a4529dec7996357876e324cb0` — the digest in the oracle and the PR body. Every "matches the plan" claim below rests on that file.

## Concerns

### D1 — "The hero scenario" names a render scenario the checkout does not have; the Manual and glossary state the decided gate as present behaviour

**Recommendation: correct it, in this batch.**

**What the checkout says.** The shared scenario vocabulary is `lib/api-zod/src/renderScenarios.ts:27-33`:

```ts
export const RENDER_SCENARIO_KEYS = [
  "generic_t2i",
  "i2i_male_default",
  "i2i_female_default",
  "i2i_nonhuman_animal",
  "i2i_nonhuman_object_vehicle",
] as const;
```

No hero. The approval gate in `artifacts/api-server/src/routes/reviews.ts:474-497` runs `requiredScenarioProblems(...)` and accepts a waiver naming any problematic *required* scenario — so at runtime the waiver covers the three required scenarios, and there is no hero concept in moderation at all. "Hero" in the code today means two other things: the weighted-random billboard fact (`GET /api/facts/hero`, `HeroFactResponse`, `lib/api-client-react/src/generated/api.ts:685-714`) and the curated builder examples (`lib/db/src/schema/heroExamples.ts:17`, table `hero_examples`). The glossary's own *Render scenario* entry (`glossary.md:617-621`) lists the real keys and no hero.

**What the docs now say.** `moderation-workflow.md:206-209`: *"The waiver is retired for the hero scenario. (Until #628's image phase lands this in code, the waiver still covers the hero scenario at runtime …)"* — a runtime claim about a scenario that does not exist. `glossary.md:369-371` (*Waiver*): *"The hero scenario is a hard gate … a fact cannot go live without approved hero images, and no waiver covers it"* — present tense, no entry anywhere in the glossary under which "hero" resolves (grep: the only "hero" lines in the file are these). `docs/manual/3-moderation.md:288-290`: *"A fact cannot go live without confirmed, approved hero renders"* — the Manual is human-facing ("how the system works") and is compiled into the admin console's Help tab; a moderator cannot check it against the code and will believe approval is blocked without hero renders. It is not, and will not be until Phase 7.

**Where the wording came from.** The phrase "the hero scenario" is the approved plan's own (oracle amendment 6, `PLAN_GET_TO_LAUNCH.md:19-21`; Phase 7, lines 441-445), so the builder carried David's approved wording faithfully — this is not a fabricated decision. But the plan defines what hero renders *are* only by reference ("test renders saved as the approved options", line 112; the publication model, lines 437-440) and explicitly leaves *which* renders and the approval minimum to Phase 7's batch for David (lines 452-453). The system docs turned that forward-looking phrase into a present-tense description of the pipeline.

**Bounded failure class.** A term used in the system-description docs (glossary, moderation-workflow, Manual) that resolves to nothing in the code, carrying a runtime claim about it. Reachable readers: the session planning Phase 7 or Phase 13, which reads these docs before the inventory; every reader of the glossary (a term-lookup file where "hero" now has three meanings and zero entries); a moderator in the admin Help. Credible path: the Phase 7 planner reads "the waiver still covers the hero scenario at runtime", searches for it, finds nothing, and either stalls or maps "hero" onto the three required scenarios and plans the hard gate on all of them — a stricter rule than David's, caught at plan review but only after the work. Recoverable each time; the cost is the recurring one, because the glossary is loaded on term lookup by every session.

**Correction scope (prose only; no mechanism):**

1. A glossary entry — `### Hero render` or similar — saying: the moderation-approved renders of a fact, published as the fact's own image assets and offered to free users as the base of their memes (launch-definition, *What ships → Image memes*); decided 2026-10-06 as a hard gate on going live; **not a render scenario in the code today** — which scenarios' renders become a fact's heroes, and the approval minimum, are #628 Phase 7's decisions; distinct from the home-page hero fact (`/api/facts/hero`) and the wizard's hero examples (`hero_examples`).
2. `moderation-workflow.md` parenthetical reworded to what is true: no scenario is designated hero today; the waiver covers every required scenario at runtime; the hard gate lands with Phase 7's publication model.
3. `glossary.md` *Waiver* and `docs/manual/3-moderation.md`: "the hero scenario" → "the hero renders", and the bullet states present behaviour first (test renders are review aids today, waiver recorded) and the decided gate second, with when it lands.
4. Regenerate the help content (`pnpm --filter @workspace/overhype-me run generate:help`); CI will fail otherwise.

Leave `launch-definition.md`, `decisions.md` and `product-direction.md` as they are: they carry the approved wording as a decision, not as a description of the pipeline, and a reader of those knows they are reading direction.

**Observable acceptance.** `grep -n "hero scenario" docs/ai-context/glossary.md docs/ai-context/moderation-workflow.md docs/manual/3-moderation.md` returns nothing; `grep -n "^### Hero" docs/ai-context/glossary.md` returns one entry; `check:help-content` passes on the corrected head.

### D2 — The inventory still records "two launches", under names the four-stage decision reassigned

**Recommendation: one parenthetical; include it in the batch, would not raise it alone.**

`launch-feature-inventory.md:155`: *"Two launches: soft launch = full build behind an invite gate, 50 approved facts, friends as first users …; full launch = gate off."* and `:298`: *"Invites (soft-launch gate)"*. The 2026-10-06 decision (`decisions.md`, *Four launch stages*) split this into Seed → Soft → Full US → Full Global, and what the inventory calls "soft launch" is now **Seed** (invite gate, 50 facts, friends), while "Soft launch" is a different, wider stage. The inventory header says *"Decisions here are settled"* and the definition says it wins on conflict — so a careful reader reconciles — but the definition also says a phase plan "reads [the inventory] when it needs the decision on a specific item", and the Invites/Seed phases would read exactly these lines. Two live statements of one rule, under colliding names. A parenthetical on the "Two launches" bullet ("superseded 2026-10-06 by the four stages; this bullet's soft launch is Seed") and "(Seed gate)" beside Invites is the whole fix. Observable: both lines point at the four stages.

### D3 — The factory-freeze clause dropped the carve-out the plan attached to it

**Recommendation: three words; include it in the batch, would not raise it alone.**

The approved text is `PLAN_GET_TO_LAUNCH.md:207`: *"A factory freeze during launch work; `/maintenance` continues."* `current-roadmap.md:23-25` and `launch-definition.md:188-191` carry the freeze and its one handbook exception and omit `/maintenance continues`. Neither document says what the freeze covers, so a session asked to run `/maintenance` mid-programme has no line telling it the ritual is outside the freeze. David invokes `/maintenance` himself, which is why I rate this low. Observable: the roadmap's *Active area of focus* paragraph carries the clause.

## What I checked and found faithful (so Claude need not re-verify)

- **Phase 1's outcome, item by item** (plan lines 286-294): `product-direction.md`, `current-roadmap.md` and the new `launch-definition.md` carry scope, cuts, readiness criteria with per-stage and payment-mode columns, and the per-item decisions — yes. **#562 re-dispositioned**: the issue body (read via REST, `updated_at 2026-10-07T01:04:33Z`) has a section *"Re-dispositioned against the launch scope (2026-10-07)"* with a doc-level disposition table, the rule *"a deferred step is never a pass"*, and "deferred with feature" rows naming their #628 phase; no step is marked passed. `is_tester` removed from the docs: a grep across `docs/`, `.agents/`, `.claude/`, `AGENTS.md`, `CLAUDE.md` finds it only in the inventory (as the record), `product-direction.md` (saying it is gone), `decisions.md`, and `known-failure-patterns.md:1809` (a historical example about PR #404, not a live rule); "tester" elsewhere is a person running a test. The reversals and the hero gate in `decisions.md` with David's words: present, and the quotes match the oracle's. The "review tools, not hard gates" line: every copy updated (`moderation-workflow.md`, `product-direction.md`, `glossary.md`, Manual ch. 3); the one other "hard gate" hit, `docs/manual/2-content-lifecycle.md:234`, is about the duplicate check and unrelated.
- **Readiness table** (`launch-definition.md:199-210`) against plan section 4 (lines 770-781) and the oracle's numbered criteria (lines 213-239): every row, every stage column and the payment-mode column match; row 5's added "every credential rotated and the old one revoked" is David's 2026-10-07 decision placed where Phase 15 (a Seed gate, line 669) puts it.
- **Stages, What ships, Cut list, Must not change**: near-verbatim from plan lines 47-69, 81-162, 164-175, 177-189. The definition drops the plan's "the waiver fallback to be designed" (line 113), correctly — amendment 6 removed the fallback.
- **Seven `decisions.md` entries**: each traced to the plan — country eligibility (Phase 14, lines 588-594, verbatim on EEA/UK/OFAC), rotation and Mythos (Phase 15, lines 607-653), hero gate (amendment 6), retired-feature records and `pre-cut/` tags (Phase 4, lines 369-377), four stages / full bar before Seed (S6, lines 55-58), Stripe evidence split (S7, lines 216-224), the 2026-10-05 scope entry (Direction served and the cut list). The "Fable silently routes flagged security queries to a weaker model" rationale paraphrases the vendor page the plan quotes at lines 613-615; **unable to verify** the page itself (no web tool in this role) — a `WebFetch` of anthropic.com/claude/fable would settle it; the paraphrase is faithful to the plan's quotation.
- **The roadmap's 21-phase list and every phase number cited** (Phases 2, 4, 7 "image phase", 8, 10, 13, 15): match plan section 3 in order and content; the moderation UI rebuild is Phase 13's scope (line 560), as the roadmap says.
- **"Of the fifty merges to main after 2026-08-15"** (`launch-definition.md:19`): `git log --first-parent --since=2026-08-15 --oneline HEAD | wc -l` gives 52 at `4a66e30`, i.e. 50 before this PR's two commits. "Eight touched the product" is a classification I did not reproduce; it is rationale, not a rule.
- **Disclosure**: "the production dump in its history" was already public in `security-model.md:356` and `deferred-work.md:293`; nothing new is disclosed.
- **Other docs still describing Pexels and video as live** (`visual-pipeline.md:8`, `meme-and-video-studio.md:88`, `architecture-map.md:153`, Manual ch. 12): accurate today — the cut is Phase 4's, and Phase 4's exit evidence includes the docs sweep (plan line 380-382). Not a contradiction.

## Questions and next action

- **For Claude:** none that need investigation; D1's facts are quoted above. One judgement is Claude's under the class rule: whether a Documentation-class PR may carry the regenerated help file. My view is yes — it is the deterministic compilation of the chapter, CI proves the sync, and the alternative is that no Manual chapter can ever ride this class — but the PR body should say it, and the "no product code changed" line should go.
- **For Astra:** D1 is a factual claim about the checkout (`renderScenarios.ts`, `reviews.ts`), not a wording preference; if Astra read "the hero scenario" as acceptable because the plan uses it, the disagreement is about whether system-description docs may use a plan's forward-looking term in the present tense. I hold that they may not without saying it is decided-not-shipped, which the moderation-workflow attempted and got wrong by asserting a runtime fact.
- **For David:** nothing reserved for you here. The one thing to know is the head-moved note in the readout.

**Recommended next action:** one batch — D1 (glossary entry, three clause edits, help regenerated), D2 and D3 (one line each), and the PR body corrected to name the regenerated help. Then the class rule takes over: green CI and merge. This is not a merge authorisation; it is what I would write.


---
_Generated by [Claude Code](https://claude.ai/code)_
