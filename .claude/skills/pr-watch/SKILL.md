---
name: pr-watch
description: Use after opening or being re-engaged on any PR, and whenever a github-webhook-activity event arrives for a watched PR. Implementation PRs only — plan review runs in-session and opens no PR.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# Watching the PRs I open

**Not a prototype-phase PR.** It merges in the same turn it opens (or, on a
`prototype/<feature>` branch, there is no PR), so nothing here fires for it:
no subscription, no labels, no rounds — save step 7's build report, which
the `prototype` skill dispatches at each version's close-out, whichever
regime the version ships under. **Nor one of the phase's one-line
registry PRs** — at a prototype's start under the branch regime, at its flip
and at its abandonment — which are Trivial by David's phase declaration,
carry `Refs #N` rather than `Workstream: #N`, and own no lifecycle: no
subscription, no labels (Codex, #168 round 7). The rule is working-modes.md,
*The prototype phase, per feature*.

**This file was 1,182 lines before the #89 cut, and most of that was mechanics
for machinery that no longer exists**: budget cadence, receipt shapes, snapshot
recipes, round-count recovery and adjudicator dispatch. All of it is gone,
along with the scripts it drove.

**What is here is what survived the deletion, plus the shared judgement.** The
two assessments are step 3 and are live (#96); neither of them binds, and what
happens next is the action step 6 states. What is still deliberately absent —
the shared-vocabulary references — lands with the rulebook rewrite, beside
#92, so a step below that reads thin is thin on purpose. (The draft-first
flow used to be on that list; it is retired with the UAT file it existed to
name, 2026-10-21 — every PR opens non-draft with its `## UAT` section in the
body, `uat-doc-format.md`.)

**The restoration, because a strip that overshoots is a deletion nobody
approved.** Most of the old reply section was a second statement of
`claude-core.md` rules 5 and 6, and losing a second copy is the point of this
cut. But the class-level sweep lived *only* here and rule 6 still points at it.
Stripping it would have left the always-loaded contract pointing at a spec that
no longer exists, which is a worse outcome than the duplication. It is back in
step 5, stated once, with the duplicated material left out. (The two escape
valves this sentence also named belonged to the four-line `Class:` / `Worth:` /
`Oracle:` / `Result:` reply form, which rule 6 retired on 2026-09-17; what
replaced them is step 5's proportionate-evidence rule.)

**Two classes do not run this loop** (David, 2026-09-25; the rule is in
`claude-core.md`, *Two classes and a phase that leave the loop*). I still subscribe to
them (step 1) — except the phase's registry PRs, top of this file — and every
Codex thread is still resolved, because the ruleset
requires it.

- **Trivial**, declared by David alone: no review requested of anyone. Read
  Codex's automatic pass for a P1 only; a P1 I judge and report — fixed in a
  named commit, or merged with the reason in the merge report (David,
  2026-10-21; until then it held the merge for him) — except on a phase
  registry PR, where the pass is read for nothing,
  P1s included (David, 2026-10-20; `working-modes.md`, *The prototype phase,
  per feature*). Resolve each thread with one line citing his ruling, then merge on
  green CI.
- **Documentation**: one pass, `review-proxy.mjs --documentation --round 1`,
  with the Fable assessor dispatched on the same package (`--prompt-only
  --source fable`). Wait for Codex's automatic pass first — its review-summary
  row reading **Completed**; a draft is reviewed only once marked ready — and
  pass its inline findings as `--findings-file` (step 3's findings shape), so
  both assessors weigh them, or `--codex-clean` when it reported Completed with
  none. The script refuses a pass given neither. There is no timeout: a pass
  that never comes back is the outage in *One standing stop*, below. The
  range is derived from where the reviewed commit left `main`; nothing is
  typed. **The oracle file is the decision the prose
  records, quoted** — David's words, or the issue or merged PR where the rule
  changed — so a docs sweep needs no new agreement from David, and step 3's
  🛑 on a missing oracle applies only when no such decision can be quoted.
  Both assessments are posted verbatim (step 3's mechanics, using its
  documentation render command, with the same `--findings-file` or
  `--codex-clean`). I write one
  batch, answer each Codex thread as review rule 6 answers any finding — fixed
  in a named commit, or declined with the reason and the assessment it rests
  on — resolve it, and merge on green CI. No second pass. The merge report
  says what the batch changed, in my words, and the build report follows it
  (step 7).

## The loop

1. **Subscribe, immediately, on whatever tier the session is on** (David,
   2026-08-15, retiring the Sonnet gate). There is no model gate and no tier
   gate. An open PR I created and am not yet watching gets subscribed the
   moment I notice it, without David re-asking.

   **Three exceptions, and none is optional.** A prototype-phase PR is never
   subscribed, and neither is one of the phase's one-line registry PRs (top
   of this file). And (Codex, PR #458 round 1) a
   `/document` harvest PR is subscribed only at step 5 of
   [`documentation-workflow.md`](../../../docs/ai-context/documentation-workflow.md),
   after the workstream issue exists and the PR body's `Workstream:` line
   points at it. Subscribing performs label writes, so subscribing early
   labels an untracked draft against a missing or wrong issue.

2. **Read live PR state on every event.** One batched `pull_request_read`:
   threads, CI, latest commits. **Never judge a webhook event from its text
   alone** — webhooks lag, drop CI successes and arrive out of order, so
   silence is never "all clear". An echo of my own comment still gets the
   silent live-state check and produces no output on either surface.

3. **Get two independent assessments, then decide.** Every round that returns
   findings, before anything is written for them, on every tier. The rule is
   `claude-core.md`'s *Shared judgement on a review round*; what is here is how
   it runs. What ends the loop is my judgement from the two assessments, under
   the write-gate and the ship gate — never a count: the two-review limit is
   retired (David, 2026-10-21; [`working-modes.md`](../../../docs/ai-context/working-modes.md#the-two-review-limit-on-autonomous-iteration-david-2026-09-19)
   keeps the record) — and step 4 below is where that judgement is made. The write-gate rule
   ([`working-modes.md`](../../../docs/ai-context/working-modes.md#the-write-gate-rule-code-written-is-code-reviewed-david-2026-08-22))
   answers the other question — which heads must be reviewed, so that no
   commit merges unreviewed — and every step below serves both.

   **The oracle comes first, and it is agreed with David before round 1.** It
   is the outcome he agreed the work should achieve — an approved plan, an
   issue discussion, or an explicit request — recorded where it can be quoted,
   normally a comment on the workstream issue; for a plan that failed the
   disclosure check, the oracle file is the full text from the private item,
   and the assessors' brief keeps their posted quotes and paraphrases to the
   sanitized copy (`review-proxy.md`). That item is write-only to me, so a
   session that does not already hold the text asks David to paste it — a
   🛑, since the round cannot run without it — and writes it to the
   scratchpad, never the repository (David, 2026-10-12;
   `workstream-tracking.md`). **Such a PR is also assessed when its round
   comes back clean**, once before merge (David, 2026-10-12; `claude-core.md`,
   *Internal tooling: what is downstream*). **No script mode runs that
   assessment yet** (AI-Handbook #206), and the documentation mode is not a
   substitute: it declares the Documentation class and applies its rubric to
   code. Until the mode exists, such a PR's clean round is a 👀 FYI to David
   saying the assessment it is owed cannot run, and I decide how it proceeds
   on my recommendation and report it (David, 2026-10-21).
   `assessmentBrief` refuses
   without one. **Reaching round 1 with no agreed oracle is a 🛑 to David, not
   a package I write myself.**

   1. **Collect this round's findings** from the live state read in step 2,
      bounded to this round by the reviewer's own markers — the same
      inclusive-current, exclusive-next window, and for this reason: `get_review_comments` returns every thread on the
      pull request, so an unbounded read on round 2 hands the assessors round
      1's findings again and collects fresh advice on settled work. Write them
      as `[{ id, body, path, line }]`, with GitHub's own comment id.
   2. **Write the oracle and the labelled history to files, in the session
      scratchpad — never inside the repository.** The dispatch refuses on an
      unclean tree and `git status --porcelain` lists untracked files, so an
      input written at a repo-relative path refuses both assessments before
      either starts. Under `.agents/reviews/` is not a safe answer either: that
      directory is only made ignored by `prepareAssessmentPath`, which runs
      *after* the checkout guard, so on a consumer that has never run this
      script the first dispatch would still refuse. Labels are `David`,
      `oracle`, `reviewer`, `builder`, `astra`, `fable`. Provenance is what lets
      an assessor weigh them: mine and the reviewer's are claims to check,
      **David's are authority**.
   3. **Dispatch both, on the same package.** Astra through the script; the
      Fable assessor as the **`fable-review-assessor`** subagent, given the
      package `--prompt-only` emits with `--source fable`, and **dispatched
      with `model: dispatchModel().agentModel`** the way the build report
      (step 7) is. The agent type is named here because it used to not
      be: the step said "as a subagent" and nothing in the payload said which
      one, so every dispatch of the second assessment was improvised (#126).

      **Pass the argument even though the definition now declares the tier.**
      `fable-review-assessor` carries `model:` and `effort:` in its frontmatter,
      held equal to `strongestClaude` by `scripts/check-agent-models.mjs` — but
      an argument outranks frontmatter, an edited definition can be served
      stale, and a consumer's own pin reaches the dispatch only this way. The
      two together are the belt and the braces; `model-routing` has the measured
      resolution order and why neither alone is enough. What is at stake if both
      are missed: on an ordinary Opus session the second assessment is Opus
      wearing the Fable label while holding the tie-break, and the post does not
      say so. **One brief serves both** — it says "the other
      assessor" throughout — and the only difference between the two packages
      is the identity block the script adds, which names who each reader is and
      which of them holds the tie-break. A brief that named a role would be
      wrong for exactly one of them, silently, and once was: the first version
      shipped Astra's brief to the subagent unchanged, so it read that it
      discussed with Fable and that Fable settled ties. **Neither sees the
      other's answer** — that is what makes the readings independent rather
      than merely separate, so do not pass one into the other.

      ```
      P=core/scripts/review-proxy.mjs; [ -f "$P" ] || P=scripts/review-proxy.mjs
      node "$P" --pr <n> --round <n> --commit <reviewed sha> --tier <product|sensitive|internal> \
        --oracle-file <path> --findings-file <path> [--history-file <path>] [--note "<where we are>"]
      node "$P" --source fable --prompt-only --pr <n> --round <n> --commit <reviewed sha> --tier <…> \
        --oracle-file <path> --findings-file <path> [--history-file <path>] [--note "<where we are>"]
      ```

      The dispatch **refuses unless the checkout is at that commit and clean**,
      because both assessors read the live tree. Retry once on a transient
      failure; a second failure is reported to David in plain English and the
      round stops (a sign-in is his to supply), and one assessment alone is
      not permission to proceed.
   4. **Post both on the PR verbatim**, each under the header `prComment`
      renders. Never summarise one away, and never drop the one I disagree
      with. Astra's comment is printed by the dispatch itself; the Fable
      assessment is written by a subagent this script does not run, so render
      its comment rather than assembling one:

      ```
      # an ordinary round — the scope comes from the round's findings file
      node "$P" --render --source fable --pr <n> --round <n> \
        --commit <reviewed sha> --findings-file <path>

      # a follow-up — the scope is the subset the follow-up actually addressed
      node "$P" --render --source fable --pr <n> --round <n> --follow-up <k> \
        --commit <reviewed sha> --findings <id,id>

      # a documentation pass — the header carries the derived range, and the
      # Codex findings it weighed when its automatic pass returned any
      node "$P" --render --source fable --pr <n> --round 1 \
        --commit <reviewed sha> --documentation (--findings-file <path> | --codex-clean)
      ```

      **Three commands, and each one's scope flag is mandatory for it.** A
      follow-up never reads `--findings-file`, an ordinary round never reads
      `--findings`, and a documentation pass takes whichever of `--findings-file`
      and `--codex-clean` it composed with, so the header names what the
      assessment covered. This
      recipe used to show one command with both marked optional, which posted a
      follow-up header naming no findings at all — the script refuses that now,
      but the recipe is what a reader copies (Codex `4051974432`, #131 round 2).

      **The header says what was asked for and the assessment's own
      `_Running as:_` line says what it is running as** — line 2, under the ship
      gate, which is line 1 for both assessors. Nothing here claims they match: this reads a
      file and cannot interrogate what wrote it, and a control reporting success
      having evaluated nothing is the one shape this repository's archive names
      as the worst available. When the two lines disagree, that is an 👀 FYI to
      David naming both, not a blocker and not a reason to discard the
      assessment (David, 2026-09-18: *"a highly visible warning"*).

      **The Fable header carries three facts and labels each one**, because the
      assessor is reached by an alias and not by a version: `expected` is the
      pin, which is what the self-report is compared against; `instructed alias` is
      the family alias the recipe sends, derived from the pin — an instruction,
      not an observation, since this script never makes the call; `definition …`
      is what the
      role's file declares, as read at render time. Only Astra's header says
      `requested`, because only Astra is handed a full id and an effort per
      call.

      **Which of the two causes a model disagreement has is decided by the
      answer's family, not by judgement.** Same family as the pin — the alias
      resolves to a different version — is a drift between the pin and the
      alias, which is David's one-line edit. A **different** family rules that
      out entirely: `fable` cannot resolve to an Opus model, so the platform
      served something else, which `model-routing` records as a content refusal.
      The build report's `chatReport` applies exactly this test, so the FYI follows the line rather
      than second-guessing it. (Before #131 round 4 this said to name the pin
      first "unless something rules it out" without saying what does — a
      judgement where an observable was available, which is the flip-condition
      lesson one level down.) And `definition …` never means "what ran":
      definitions are cached, so the file on disk may not be the one that
      answered, and the assessor's own line is the only observation there is.

      **Effort is the weaker half of that comparison, and knowing why saves a
      false alarm.** It has no argument at all, so the header can only report
      what the definition declares. On the reporting side,
      an assessor may not be able to name its effort at all: measured on this
      PR's own round 1, the assessor answered `at unable to name` and said why —
      its context shows reasoning effort as the number `80`, not one of the pin's
      named levels. **So an effort the assessor could not name is not a
      mismatch**; report it once as the limit it is and do not raise it every
      round. A **model** it could not name, or one that disagrees, is the FYI
      that matters.
   5. **Decide, and say what I decided.** Investigate disputed facts myself in
      the repository and the tests — an assessor should not be asked to settle
      what a few tool calls answer. Where a real question of reasoning remains,
      put it to both. **This costs no commit and no Codex round** — measured on
      #120 round 6, the first time either was run.

      **They are two different mechanisms, and one verb used to hide that.**
      Astra's follow-up is a **cold re-dispatch**: a fresh `codex exec` that
      remembers nothing, so the script rebuilds the whole package —
      `--follow-up <n> --question … --findings <ids> --findings-file …
      --oracle-file … --tier … --prior-file … [--fable-file …]`. The Fable
      assessor's is a **transcript continuation**: the harness resumes the same
      subagent, which still holds its own assessment and the evidence behind it,
      so it is sent the question and nothing else — **plus the path to write to,
      which is the one thing the continuation must be told.** Its retained
      instruction still names the base assessment's file, so a continuation sent
      without a new path would overwrite the assessment it is supposed to
      supplement, and a continuation that then wrote nothing would leave the
      base assessment looking like the follow-up. Name
      `round-<n>.fable.followup-<k>.md` explicitly. (Codex, #120 round 7. It did
      not bite on the one live run only because the subagent chose that path
      itself.)

      **`k` counts attempts, not questions, so it is never reused.** List the
      round's directory first and take the next unused number: a second attempt
      at follow-up 1 is `followup-2`. Nothing can clear the old file for me —
      `prepareAssessmentPath` is reached only through the CLI, and a Fable
      continuation invokes no CLI at all — and `readAssessment` accepts any
      non-empty file as an answer. The case that matters is not a plain retry,
      where a stale answer is at least an answer to the same question: it is a
      **corrected question landing on the answer to the old one**, which reads
      as a reply to what I just asked and is not. Counting up eliminates the
      state instead of clearing it, and the file name then says which attempt
      produced it. (Codex, #120 round 8, deferred to #122; Fable held the
      tie-break between this and clearing the destination.) That asymmetry is why the
      Astra package took three rounds of guards to get right and the Fable side
      needed none — and why a package guard is worth writing on one side only.

      **The question carries the evidence**, in the form
      `claude-core.md`'s *A load-bearing claim is quoted, or it is marked
      unverified* already requires: command output and source lines quoted with
      their origin, never paraphrased into my own assertion, and my inference
      from them labelled as mine. There is no separate evidence input; one was
      removed on #120 round 6 because it flattened multi-line output to a single
      line under a label nothing validated, which is worse fidelity than the
      question gives.

      A purely
      technical disagreement that survives is the Fable assessor's to settle,
      with its reasoning recorded. **Intended behaviour and any accepted
      user-facing shortfall go to David** as a 🛑 with a push notification —
      where no settled decision already covers them; a consequence a settled
      decision reaches is settled with it, and the thread reply names the
      decision (`agent-working-rules.md`, *A reversible choice proceeds on the recommendation*) — and
      stay open until he answers — a later clean round never clears them, and
      **neither does a default of mine.** A question of his that goes unanswered
      stays **open** — re-notified and pointed back to, reprinted only when
      the ask itself changes (`claude-core.md` interaction preference 6) — not
      resolved by whatever I pre-registered as the fallback:
      on #120 round 5 a question about his own ruling was closed by my default
      and the loop carried on, which is this sentence being contradicted by the
      loop that wrote it. A pre-registered default is for what *I* do while
      waiting, never for what *he* decided.
   6. **State the next action explicitly** in a `review-action` block
      (`proceed`, `investigate`, `follow-up`, `ask-david`, `conclude`) with the
      finding ids it covers. Nothing parses an assessment, so this block is
      what says what happens; there is no `merge` action and agent agreement is
      never David's approval. **When the action is `proceed`, the block is
      posted before the batch is pushed and carries, per finding, the class
      the finding belongs to and the sweep of that class** — every member
      found, with the command that found them — or, where the class is design
      judgement or naming and no command can enumerate it, saying so, as
      `working-modes.md`'s class-sweep step 2 allows (`claude-core.md`,
      *Shared judgement* item 6). The thread reply after the push cites this
      block for the class and the pre-fix sweep, names the commit, and carries
      the post-fix re-run of the oracle to zero, which the block cannot hold
      because it is posted before the batch is written (class-sweep step 3).

   **Sign-in before the first dispatch, not mid-round.** `$CODEX_BIN login
   status` decides; the steps are in `claude-core.md`'s *Astra* section, and the
   device code expires in about fifteen minutes, so the ask and the code go to
   David in the same turn.

   **No clock stops a loop** (David, 2026-10-21, retiring #120's six-hour
   stop: *"everything that stops you from working is a problem for me"*).

4. **Decide what is worth writing, then batch the fixes.** No count ends
   iteration and no round sends findings to David: the two-review limit, its
   three-question shortfall exit, its ask-to-reopen and the review-loop PR's
   hand triage are all retired (David, 2026-10-21: *"everything that stops
   you from working is a problem for me ... I'd much rather have you use up
   too many tokens accidentally occasionally than keep delaying our ability
   to build"*). What decides, every round, is the judgement from both
   assessments under the Worth rule and the ship gate: once both say the
   oracle is met, a finding is a recorded gap unless it is a regression or
   reaches outside this pull request. From the second review on,
   record-the-gap is the ordinary answer — the 2026-09-19 measurement (57%
   of later findings landed on an earlier round's fix) is the prior — and a
   further batch is written when the judgement says it is worth it, with the
   merge report saying what was recorded and why. A corrected head that still
   violates an agreed requirement or fails a required check does not merge:
   I fix it or cut it, and report. What goes to David is only what step 3.5
   names — intended behaviour, an accepted user-facing shortfall, where no
   settled decision already covers them — and a
   change to the review loop is judged like any other. The usual outcome is
   **recorded gaps and follow-up issues**, and the pull request goes to
   close-out like any other. **A follow-up issue is filed with its labels**:
     `gap` and the workstream's `mode:`, and **no `queue:` label** — so it
     stays out of `/next` until it has been triaged (David, 2026-09-28: a
     recorded gap is not a candidate for work before that).
     The triage is `/maintenance` step 9's, applied on my recommendation
     and reported there (2026-10-21; until then each line waited for his
     approval); that step finds every gap by its `gap`
     label, which is why the missing `queue:` label cannot lose one. If the
     finding's consequence argues for sooner, that case goes in the body for
     step 9 to propose; a user-facing consequence he has not accepted is his under step 3.5 and
     never reaches this sentence. (Until 2026-09-28 a gap was filed with
     `queue:later`, which `/next` reads as wanted work, so an untriaged gap
     could be recommended — Codex on Overhype #622.) The label is in the
     shared vocabulary
     ([`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md));
     GitHub does not create a label on first use, so a consumer creates
     `gap` by hand once, like every other label the vocabulary names.
     (Codex, #140 round 3 — this branch escalated *every* second-review
     finding, so a routine round-two nit would have turned each internal pull
     request into a David-gated stop. An enactment that interrupts him more
     often than the design it replaced is a worse answer than doing nothing,
     and the limit this step enacted until 2026-10-21 existed because he said
     the looping overhead was slowing him down.)

   - **Everything being written for goes in one push**, with
     the repo's own fast checks run first: lint, format, typecheck, the
     changed suites. One validated push beats three speculative ones, because
     each push costs a full round.

5. **Reply to every finding and resolve its thread**, right after posting that
   reply, never in a batch, and never as a standalone summary comment in place
   of per-thread replies. The shape is `claude-core.md` rule 6's and is not
   restated here. What that rule points at and states nowhere else:

   - **The sweep is class-level, always.** A fix closes the class the finding
     belongs to, not the line the reviewer happened to land on, and a decline
     answers the consequence that class reaches at its worst. Measured cost of
     not doing this: on #553 I posted twenty-plus replies across five rounds
     that read as thorough — naming the class, describing what I had checked —
     and ran zero commands. **Prose that sounds thorough is not a check that
     ran.**

   - **Where a command settles the question, it runs before the reply is
     written** and its real output is transcribed. Where the class is design
     judgement or naming preference and no command can enumerate it, the reply
     says so rather than going silent. **Neither is a fixed four-line form any
     more** (David, 2026-09-17): that form made declining more burdensome to
     write than fixing, which is the asymmetry this loop exists to remove.

   - **The prose is held to the same bar as any evidence.** A sentence
     asserting a fact about the code — that an edit applied, that a flag
     exists, that a class has no other member — is a load-bearing claim under
     `claude-core.md`'s *A load-bearing claim is quoted, or it is marked
     unverified*: it quotes what was read, or it carries `unable to verify:`.
     The reply that motivated this is on file in AI-Handbook #113.

   - **A decline is recorded, not just replied to**: a row in the PR body's
     **Recorded gaps** table naming what ships unfixed and why, so the final
     round and David can see it in one place rather than inside a resolved
     thread nobody re-reads. The body's **Decisions taken on my
     recommendation** section is the same device for the reversible choices
     the build proceeded on without asking (`claude-core.md`, *A reversible
     choice proceeds*); a round that adds one adds a line there, under the
     canonical disclosure check like every record of one
     (`workstream-tracking.md`, *Sensitive / disclosure-carve-out workstreams*).

6. **Re-request review on the actual head.**

   - **Every changed head gets its review; an unchanged one never gets a
     second.** A prose-only push is a changed head and is reviewed like any
     other — the rule here used to say it "waits and rides the next behavioural
     round", which under the write-gate meant a documentation correction with
     nothing behavioural behind it could never merge at all (#125 waited a week
     on that reading). What is refused is re-requesting on a head already
     reviewed as it stands, to get a different answer. (Astra, 2026-09-19.)
   - **No review is the last one by number** (David, 2026-10-21, retiring the
     two-review limit): the second review is where record-the-gap becomes the
     ordinary answer, and a further batch is written when the judgement says
     it is worth it. Only a changed head gets a review, so by the time a head
     exists here it is always reviewable.
   - **Pre-registered flip conditions, in the request itself.** Name, before
     the round runs, what would stop the loop. **Each names an OBSERVABLE,
     never a judgement** (#85, 2026-09-13) — something read off the round ("a
     silent omission", "more findings than the last round"), not something I
     decide in the moment having just read the finding ("needs a new concept").
     The second kind does not fire: on #83 a judgement-shaped pair was crossed
     twice and caught once, by the round translation rather than by me, while
     #85's observable pair fired twice and decided both times without my
     judgement entering it. **A condition I have to interpret is one I will
     reinterpret.**
   - **One line naming what the round costs and what it protects**, in the same
     comment, before it runs. The bill is **conditional and the condition is
     the findings**: two assessments at roughly a hundred and fifty thousand
     tokens each **only if the round returns findings**, since step 3
     dispatches neither on a clean round — save the one clean round of a PR
     whose plan took the private path, which step 3 assesses anyway; the
     build report the close-out owes, once per unit of work; and my own
     turns either way. Then what is downstream if this
     round finds nothing. When that reads "a sentence in a
     comment two agents read", the disproportion is legible to both of us
     *before* it is spent rather than after. The token counts are already
     reported to me on every dispatch; this is putting them beside what they
     bought, not building a ledger.
   - **A fix I would only write because a round is already being written is
     not written.** Sunk cost is not a reason: the round already happening does
     not make the next one free, it causes it — and a fix written owes a round.
   - **Name the branch head, never a specific SHA** (David, 2026-08-17). Codex
     reviews the head at the moment it runs, not the SHA it was told, and the
     `**Reviewed commit:**` line it emits is what binds.
   - **The re-request says what to reconcile.** A bare trigger on a fix round
     invites a review of just the new commits, so the round context names which
     findings it was meant to close and asks for each to be confirmed resolved
     in the code, not merely responded to.
   - **The trigger comment carries no prose of mine** — the defanged trigger
     `atC0dex r3view` and nothing else (`claude-core.md` interaction rule 11).
     Round context and flip conditions go in a separate defanged comment posted
     just before it.
   - **Verify CI on the SHA that is actually HEAD**, not the one last looked
     at. `get_check_runs` returning `total_count: 0` means checks have not
     reported yet, which is not green and must never be reported as green.

7. **The build report: one independent account per unit of work, at
   close-out** (David, 2026-10-21; `claude-core.md`, *Watching the PRs I
   open*). It replaced the per-round translation, and nothing runs per round
   any more. A unit is a PR's merge, or a prototype version delivered on its
   own `prototype/<feature>` branch, which opens no PR. A Trivial PR gets
   none. It is dispatched **after** the merge report hands back, never before
   a merge, and never holds one: it is off the critical path by design.

   **The deliverable is a message in chat and the same text as a comment on
   the workstream issue — chat only on the private path (step 4). There is
   no page** (David, 2026-09-16). There was
   one, and #109 round 3 found it was HTML written to a gitignored path: a
   delivery nobody could open. **Do not rebuild it** — not an Artifact, not
   an HTML file, not a receipt store, not a link.

   **How it runs** (`core/scripts/build-report.mjs` here, `scripts/` in a
   consumer):

   1. **Write the brief and prepare the answer path in one call**:
      `node <dir>/build-report.mjs brief --unit <slug> --issue <n> --pr <n> [--pr <n> …]`,
      or for a branch-regime prototype version
      `--branch prototype/<feature> --since <sha> --head <sha>` in place of
      the PRs: `--since` is the previous version's head, read off the
      *Evidence* line of that version's build report — on the issue, or,
      on the private path, in the private item, which David relays — or
      the branch's base for the first version. The unit's slug names the
      answer file (`pr-231`, `ingest-v2`). Preparing clears any earlier
      attempt's answer and coordinates, so a re-dispatch that writes nothing
      reads as a failure, never as its predecessor. **A workstream whose
      plan is on a private draft Project item** — no public issue at all, or
      one that turned sensitive and keeps only sanitized tracking — is
      reported from **the item's text, relayed by David** (#227): the item
      is write-only to agents, so I ask him to paste it (the plan, the
      decisions taken on recommendation, the *Spend so far* line), write it
      to the scratchpad, never the repository, and pass `--private-source
      <file>` with `--private-ref <the item's reference>`, in place of
      `--issue` or beside a sanitized one. `brief` refuses a source inside
      the checkout, quotes it inline under its provenance, and marks the
      unit private; `--private yes` without a source is refused, since the
      flag alone would point the role at a sanitized issue for the plan. The role still reads the PRs or branch from GitHub
      itself; only the plan side is relayed. With no issue and no source,
      `brief` refuses by name and says to ask for the relay.
   2. **Dispatch `fable-build-report`** with `model:` set to the pin's alias
      (`dispatchModel().agentModel`, which is `fable` today), and **the
      printed brief as the whole prompt**. The role holds no file-reading
      tool, so a brief handed to it as a path is unreachable — measured on
      #222's interim account, which could not open its brief and rebuilt its
      coordinates from the PR, and on #131 before it, which then wrote to a
      guessed filename. The brief carries the schema for the same reason.
      Announce the dispatch in one line.
   3. **Read only after the harness reports the dispatch complete**, in the
      tool result or a later task notification. The completion signal is the
      synchronisation; `run_in_background: false` is not, having been
      measured both ways
      ([`backgrounded-subagent-answer-is-in-its-own-transcript.md`](../../../.agents/memory/backgrounded-subagent-answer-is-in-its-own-transcript.md)).
      The answer is the file, never the role's closing message. When no
      signal ever arrives, read once at the next event: no file is a failed
      report, never a quiet one.
   4. **Paste the report verbatim**:
      `node <dir>/build-report.mjs report --unit <slug> --session continue|"hand off" --session-why "<one clause>"`,
      in chat and as a comment on the workstream issue, and say nothing else
      about the unit. **A private-path unit's report goes in chat only**,
      never as an issue comment, and the report says so at its top, asking
      David to paste it into the private item, which is where it is kept:
      the role writes a plain account of the diff, and from a relayed
      source the restricted plan too, which is what the canonical
      disclosure check keeps off GitHub (`workstream-tracking.md`,
      *Sensitive / disclosure-carve-out workstreams*). The report's
      *Evidence* line names what it covered from the brief's own
      coordinates, and for a branch unit both ends of the range — the next
      version's `--since`. The **session** line is mine and printed under a label
      saying so, because only this session can see its own context: the
      `handoff` skill's Step 1 judgement, run here without being asked, and
      when it says hand off, the hand-off prompt follows the report.

   - **The report is the role's words, not my summary of them.** `chatReport`
     composes it from the validated answer's own fields; the only text in it
     that is not the role's is the labels and my labelled session line. My
     own account is welcome beside it, labelled as mine (David, 2026-09-16);
     editing the role's account, or presenting mine as it, is not.
   - **A failure is honest and never blocks.** No file, unparseable JSON and
     a schema-invalid answer are each a visible **failed** report, never
     "nothing to report". If the dispatch itself is refused — a newly added
     agent type is not dispatchable for some minutes, and an edited one may
     be served stale (both measured 2026-09-16) — say so in plain English,
     write the unit up myself labelled as my own account, and try again at
     the next unit.
   - **"Agrees" prints only when nothing differs, nothing shipping unfixed is
     called unreasonable, no decision drew a concern and everything reachable
     was assessed.** The model is disclosed, not observed: the role reports
     its own and the report mentions it only on a mismatch or an absence
     (David, 2026-09-19: observing it is not worth building).
   - **`Write` is not path-scoped, and this role reads every comment on the
     pull request, from anyone.** A path specifier in a `tools:` list removes
     the tool rather than narrowing it, so the bare grant ships and the
     exposure is named: an injected instruction could direct the one write
     tool at any path in the checkout. What bounds it: the answer directory is
     `*`-gitignored; the container is ephemeral; and the only route to `main`
     is a commit I make. **So after every dispatch, read `git status
     --porcelain`**: an untracked file inside `.agents/reviews/` is the one
     kind of noise, and anything else — a tracked file modified anywhere,
     `.agents/reviews/.gitignore` included — is a finding (Codex, #109
     round 9, P1).

8. **Merge, sync, report**, per `claude-core.md`'s *Close-out is mine, end to
   end*: re-verify live state with a fresh `pull_request_read` — not cached
   green — then squash-merge, check the Repl for its own commits and then sync and verify it (close-out step 3), execute the
   Post-merge verification section (a step that would start a paid AI run
   within David's paid-run budget — $5 a run, $25 a week — and on his go-ahead only above it (`uat-doc-format.md`, *Lanes*)), post the harvest-notes comment, and send
   the merge report with both SHAs, the latitude line, the PR's **Decisions
   taken on my recommendation** entries, the UAT handoff and, as its last
   block, the fixed footer — Done / Next / Needs you / Spend (`claude-core.md`,
   *A reversible choice proceeds, and every turn reports its spend*) — then
   dispatch the build report (step 7).
   **No readiness receipt is minted or quoted**: `pr-ready.mjs` is gone, and
   the three-item bar is read by eye.

## One standing stop

**A Codex code-review outage is a FULL STOP**, not the security-review
usage-limit bounce. Stop building, tell David as a 🛑 with a push
notification, say which PRs are blocked and in what state, and wait. A
Documentation-class PR still waiting on Codex's automatic pass is one of
them; a prototype-phase PR owes Codex nothing and is not (`claude-core.md`,
*Close-out*).

## Keeping the workstream issue's labels current

Per [`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md),
`pr-watch` owns `stage:code-review` and everything downstream of it for the
PR's workstream issue (found via `Workstream: #N` in the PR body — if it's
missing, that PR skipped the tracking convention; flag it rather than
silently leaving the workstream unlabeled — unless it is one of the phase's
registry PRs, which carry `Refs #N` by design and are never subscribed, top
of this file, or one of David's display-only Replit tweaks, which carries no
issue by design and is its own record (`agents-core.md`, *Workstream
tracking*), so it has no labels to keep):

- **PR opens / round 1 triggers** → `stage:code-review`, `waiting:codex` — on
  a Documentation-class PR too, while its one pass waits for Codex's
  automatic pass; `waiting:claude` once that pass reports Completed, since the
  assessed pass and its batch are mine to run.
- **Codex posts findings, I start responding** → `waiting:claude`.
- **I post the next round's `@codex review` trigger** → `waiting:codex`.
- **Intended behaviour or an accepted user-facing shortfall goes to David**
  (step 3.5 above — a purely technical fork is settled in the loop, never
  escalated) → `waiting:david`; `stage:code-review` stays put — the stage
  hasn't moved, but the turn has.
- **The close-out bar is met** (CLAUDE.md's *Close-out*, all three items) →
  the ready bar is met and **I merge it myself per CLAUDE.md's close-out
  contract (David, 2026-08-15)** — re-verify live state, squash-merge, check and sync the Repl, verify, report — so `stage:merge` is normally a moment, not a resting
  state. There is no carve-out exception any more (David, 2026-09-14): a
  guardrail- or authority-widening PR merges the same way, with the latitude
  it grants named in the report. The PRs that do not are the ones whose shortfall is a product decision
  (step 3.5); no count and no class sends one to him (David, 2026-10-21).
- **The PR merges with a Post-merge verification section that has real
  content** → `stage:test-run`, `waiting:replit` — or `waiting:david` while
  a step in it that would start a paid AI run above his budget waits for his
  go-ahead (`uat-doc-format.md`, *Lanes*) — the lifecycle's own
  Test-run stage, between Merge and UAT, not a step to skip past. Per the
  `pr-docs` contract this stage is now **executed inside close-out**: I
  drive the section through the connector, read the results, and on a
  clean pass move the label myself to `stage:uat`/`stage:close-out` per
  the next bullet's check, in the same close-out sequence. A failure
  keeps the workstream here while it routes through the normal channel.
  (The `test-run-completion.yml` Action that used to own this transition —
  built on PR #334 when file deletion was the completion signal and no
  agent owned the moment — is retired along with the TEST_RUN file
  pattern, 2026-08-15: close-out now has an owner, me. A **legacy**
  `docs/tests/Replit/PR<N>_..._TEST_RUN.md` doc still on `main` follows
  this same flow, plus deleting the doc on a full pass — a tiny deletion
  PR, self-merged; the label move is likewise mine, since the Action is
  gone.)
- **The PR merges with "none needed" verification** → `stage:uat` **only
  after the close-out sync checks pass, and only if the PR body carries a
  `## UAT` section ([`uat-doc-format.md`](../../../docs/tests/uat-doc-format.md);
  or a legacy UAT doc still under `docs/tests/UAT/` on `main`) or one is
  actually due**. The transition moment is the verified Repl
  sync (matching SHA + clean worktree, per CLAUDE.md's close-out
  sequence), not the merge click — a failed sync would otherwise put a
  David-held UAT gate on the board for a build he can't actually reach;
  until the checks pass the workstream stays agent-held in close-out.
  On the UAT-section test: pure-docs/pure-devops PRs never have one,
  and neither does a Tier A bugfix or a Tier B bugfix whose only surface is
  internal (per `working-modes.md`'s Tier B exception): all three go
  straight to `stage:close-out` instead, since holding them at `uat` would
  be a gate with nothing to run against it (a prototype-phase PR ships none
  either, and never reaches this step — top of this file). "Has product-visible behavior"
  is *not* the test by itself — a Tier A fix can be product-visible and
  still ship no UAT section, which is what makes checking for the section
  the right test, not the behavior. **The straight-to-close-out case does not stop
  at close-out** (David, 2026-09-25): with no UAT owed there is nothing
  left to verify, so in the same pass I finish whatever close-out items
  remain, set `stage:done`, and close the issue as completed with a comment
  naming the PR, per
  [`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md#closing-an-issue)'s
  *Closing an issue*. **When it is a product-visible fix that shipped no
  UAT section (the Tier A case), the closing comment aims David** (David,
  2026-08-09, moved from the State of Play): one line — where in the app to
  glance next time he's there, and to reopen the issue if the symptom
  persists. Still never `stage:done` at the merge click: the verified sync
  comes first, the same reason the Project's built-in `PR merged → Done`
  workflow is off. (This line used to say `stage:done` was David's to set.
  Nothing ever asked him to, so every workstream with no UAT stayed open
  for good.)
- **Any other issue this PR completes** — named with `Closes #N` in the
  body, so GitHub closes it at merge. If the PR completes an issue whose
  number the body left out, I close it by hand at close-out, naming the PR.

**If this PR is one phase of a phased feature, every `waiting:` toggle
updates the parent too — not just close-out.** Per
[`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md)'s
*Phased features* section, the parent's `waiting:` is supposed to mirror
whoever holds the active phase at all times. Touching it only at close-out
leaves the parent showing a stale holder for the entire review-and-merge
cycle of every phase — so **each time this section moves the phase issue's
`waiting:`** (round-by-round toggling, escalation, merge), mirror the same
value onto the parent, in the same edit, State of Play included.

**The parent's Phases checklist moves when the phase issue itself reaches
`stage:close-out` — never at merge.** This is the same distinction the
general flow above already makes for an ordinary workstream (merge is not
verified work; David's UAT is) — a phase is no different. A product-visible
phase merges into `stage:test-run`/`stage:uat` like any workstream and sits
there through David's UAT before reaching `stage:close-out`; a phase with
no UAT reaches `stage:close-out` sooner, immediately after its verification
checks, but through the same transition, not a merge-time shortcut. Ticking
the checklist at merge instead would let `/next` treat a phase as done —
and surface the next phase, or close the parent — while its own UAT is
still outstanding.

**Keep mirroring the parent's `waiting:` through this entire span**, per
the toggle rule above — that already covers the phase's `stage:uat`/
`waiting:david` transition, so the parent correctly shows "waiting on
David's UAT" for exactly as long as that's true.

**When the phase issue reaches `stage:close-out`, move the parent's
checklist**, in the same edit as the phase's own transition:

- **Tick this phase's checkbox** in the parent's checklist, replacing
  `(active)` with the merged PR number.
- **Re-point the parent's `waiting:`** at whoever holds the next phase — or
  `waiting:claude` when the next phase hasn't been opened yet, since an
  unstarted next phase is work owed, not a resting state.
- **If this was the last phase**, move the parent straight to
  `stage:close-out` and close it out in the same pass, per
  `workstream-tracking.md`'s *Closing an issue*: finish what its State of
  Play lists, set `stage:done`, and close it as completed with a comment
  naming the phase PRs. It holds at close-out only with a named remaining
  item. There is no separate whole-feature UAT gate — every
  phase already ran its own UAT wherever it was product-visible, per
  `workstream-tracking.md`'s *Phased features* section, so a UAT stage here
  would be a gate with nothing left to run against it.
- **If a phase's own UAT surfaced a bug**, that's the UAT-descent case —
  see `workstream-tracking.md`'s *When UAT finds a bug* section for the
  `Blocked by:` marker that records the way back up. The phase stays open
  (not `stage:close-out`) until that descent resolves, so the checklist
  correctly doesn't tick early.

**At the close-out of any workstream, check whether it was the target of a
`Blocked by:` marker** — one `search_issues` call, `"Blocked by: #<this
issue>" in:body`, trusted-issue filtered the same way every other marker
lookup here is. If a match comes back, that match is a parent this closure
just unblocked — but what to do about its `waiting:` depends on whether
this is the UAT-descent shape:

- **If the matched issue's State of Play records a stashed prior
  `waiting:` value** (only `bugfix`'s UAT-descent intake writes one, per
  `workstream-tracking.md`'s *When UAT finds a bug*) — **restore it**
  (normally back to `david`) and remove the now-stale `Blocked by:` line.
  Skipping this leaves the unblocked parent sitting at `waiting:claude`
  indefinitely — mechanically releasable per the `Blocked by:` contract,
  but with no open question left for anyone to notice needs restoring.
  **If that matched issue is itself a phase sub-issue, restore its
  parent's `waiting:` the same way, in the same edit** — `bugfix` mirrors
  the descent flip onto the parent at intake, so the restore has to mirror
  back the same way, or the parent is left stuck at `waiting:claude` after
  the phase itself has already recovered.
- **Otherwise** — an ordinary workstream-to-workstream dependency, or a
  blocked backlog item — **only remove the stale `Blocked by:` line.**
  Nothing stashed a prior value for these, so guessing a `waiting:` (or
  adding one to a `queue:`-only item that shouldn't carry the label at
  all) would fabricate state instead of restoring it. Their own next
  `waiting:`-touching moment sets the right value normally.

**Every transition above lands with a State of Play update in the same
edit** — the block's `Stage`/`Waiting on`/`Last movement` fields at minimum,
`Spend so far` whenever the turn's spend changed it,
and `Where it actually stands`/`What's blocking` whenever there's real
narrative to add (a round's findings, an escalation's actual question, what
shipped at merge), all of it under the canonical disclosure check — on a
workstream that turned sensitive after its issue opened, the issue gets the
sanitized tracking only and the narrative goes in the draft item
(`workstream-tracking.md`). Per `workstream-tracking.md`'s ownership rule: the skill
that moves the label moves the block, in the same edit, every time.

An echo of my own comment bouncing back as a webhook event still needs the
silent live-state check like any other event, but never a label change on
its own — only real state (a new commit, a new finding, an actual merge)
moves a label.

Codex (and other AI reviewers) remain the independent reviewers; my job while
watching is to *respond* — judge every finding under the Worth rule with both
assessments in hand, and take to David only what is his.

