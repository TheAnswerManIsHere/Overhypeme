---
name: pr-watch
description: Use after opening or being re-engaged on any PR, and whenever a github-webhook-activity event arrives for a watched PR. Implementation PRs only — plan review runs in-session and opens no PR.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# Watching the PRs I open

**This file was 1,182 lines before the #89 cut, and most of that was mechanics
for machinery that no longer exists**: budget cadence, receipt shapes, snapshot
recipes, round-count recovery and adjudicator dispatch. All of it is gone,
along with the scripts it drove.

**What is here is what survived the deletion, plus the shared judgement.** The
two assessments are step 3 and are live (#96); neither of them binds, and what
happens next is the action step 6 states. What is still deliberately absent —
the draft-first flow and the shared-vocabulary references — lands with the
rulebook rewrite, beside #92, so a step below that reads thin is thin on
purpose.

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
## The loop

1. **Subscribe, immediately, on whatever tier the session is on** (David,
   2026-08-15, retiring the Sonnet gate). There is no model gate and no tier
   gate. An open PR I created and am not yet watching gets subscribed the
   moment I notice it, without David re-asking.

   **One exception, and it is not optional** (Codex, PR #458 round 1): a
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
   it runs. What ends the loop is not here at all: on internal tooling it is
   the **two-review limit** ([`working-modes.md`](../../../docs/ai-context/working-modes.md#the-two-review-limit-on-autonomous-iteration-david-2026-09-19)),
   and step 4 below is where this skill enacts it. The write-gate rule
   ([`working-modes.md`](../../../docs/ai-context/working-modes.md#the-write-gate-rule-code-written-is-code-reviewed-david-2026-08-22))
   answers the other question — which heads must be reviewed, so that no
   commit merges unreviewed — and every step below serves both.

   **The oracle comes first, and it is agreed with David before round 1.** It
   is the outcome he agreed the work should achieve — an approved plan, an
   issue discussion, or an explicit request — recorded where it can be quoted,
   normally a comment on the workstream issue. `assessmentBrief` refuses
   without one. **Reaching round 1 with no agreed oracle is a 🛑 to David, not
   a package I write myself.**

   1. **Collect this round's findings** from the live state read in step 2,
      bounded to this round by the reviewer's own markers — the same
      inclusive-current, exclusive-next window the translation step uses, and
      for the same reason: `get_review_comments` returns every thread on the
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
      with `model: dispatchModel().agentModel`** the way the round-translation
      step already does. The agent type is named here because it used to not
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
      failure; a second failure goes to David, and one assessment alone is not
      permission to proceed.
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
      ```

      **Two commands, and neither flag is optional.** A follow-up never reads
      `--findings-file`, and an ordinary round never reads `--findings`. This
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
      `chatReport` applies exactly this test, so the FYI follows the line rather
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
      user-facing shortfall go to David** as a 🛑 with a push notification, and
      stay open until he answers — a later clean round never clears them, and
      **neither does a default of mine.** A question of his that goes unanswered
      is **re-asked**, not resolved by whatever I pre-registered as the fallback:
      on #120 round 5 a question about his own ruling was closed by my default
      and the loop carried on, which is this sentence being contradicted by the
      loop that wrote it. A pre-registered default is for what *I* do while
      waiting, never for what *he* decided.
   6. **State the next action explicitly** in a `review-action` block
      (`proceed`, `investigate`, `follow-up`, `ask-david`, `conclude`) with the
      finding ids it covers. Nothing parses an assessment, so this block is
      what says what happens; there is no `merge` action and agent agreement is
      never David's approval.

   **Sign-in before the first dispatch, not mid-round.** `$CODEX_BIN login
   status` decides; the steps are in `claude-core.md`'s *Astra* section, and the
   device code expires in about fifteen minutes, so the ask and the code go to
   David in the same turn.

   **A loop stops at six hours and asks David to resume.** The clock is the PR's
   `created_at`, or his last explicit resume, whichever is later — one quantity,
   read from GitHub, with no judgement about what counted as attended. It covers
   waits and retries and does not reset per dispatch. Expiry pauses and asks;
   never convergence. **Check it at the top of every round**, because #120 wrote
   this rule and then ran seven rounds without once reading it.

4. **Check the limit BEFORE writing anything, then batch the fixes.** This
   gate is first in this step because its whole job is to prevent a commit
   that cannot then be reviewed. It has **exactly two branches, and the
   predicate is stated once** — an earlier shape split it across three
   sibling bullets and restated the complement as the negation of one
   conjunct, which silently dropped product code at its second review. With
   one predicate and one `Otherwise` there is nothing left to restate, so
   nothing to restate wrong. (Codex, #143 round 1; both assessors, who also
   caught that the disposition paragraph below had escaped the predicate
   entirely and so applied to every round.) **A predicate may carry a
   disjunct; what it may not do is grow a third bullet.** The review-loop
   class is a disjunct *inside* the one predicate, asked first, and its
   destination sits in the disposition where a destination is actually
   decided. Written instead as a sibling bullet ahead of the two, it named no
   round and changed no branch beneath it, so the reader either stopped at
   round 1 with nothing corrected or read on and reached `Otherwise` and
   close-out — neither of which is the ruling it was enacting. (Both
   assessors, #154 round 1: three generations of this paragraph's bugs all
   came of adding a predicate as new sibling text instead of into the one
   stated predicate.)

   - **Is this its SECOND review, AND is it either a change to the review loop
     itself OR internal tooling by consequence?** **Ask the review-loop half
     first**: its answer does not depend on the other, and asking it first is
     what keeps the consequence test from being consulted for that class at
     all — a review-loop change the test would put *outside* the limit
     otherwise falls through to `Otherwise` and writes another batch (Codex,
     #153 round 1; both assessors, #154 round 1).
     **Answer the internal half by asking what THIS CHANGE does and how
     recoverable it is** —
     neither its directory nor the file's job title
     ([`working-modes.md`](../../../docs/ai-context/working-modes.md#the-two-review-limit-on-autonomous-iteration-david-2026-09-19)).
     A change that governs approvals, publication, credentials or destructive
     operations is weighed on those consequences whatever folder it sits in,
     and that weighing can put it outside the limit. **It is the change, not
     the file**: editing `sync.mjs`, which publishes the payload to every
     consumer, is outside when it changes what gets published in a way that could
     not be trivially undone, and inside when it changes a dry-run message
     or the formatting of what it publishes, because those are trivially
     recoverable. A consumer overlay marking a subsystem sensitive is one
     route to the classification and not the only one, and its silence is not
     a classification. Reach is not consequence: "this changes how future
     agents work" disqualifies nothing, or every line in this repository would
     be exempt. If this change is outside **and** it does not change the
     review loop, the gate does not apply and the loop continues under the
     Worth rule.
     If yes — its second review, and either a review-loop change or internal
     by consequence — **write nothing**; iteration is over. A batch written
     here would be a changed head I am forbidden to request a review for,
     which is a pull request that can neither merge nor move. (Codex, #140 round 2 — the ordering bug was
     mine: this check sat in step 6, *after* the batching it exists to
     prevent.)

     **Then, of that corrected head, decide where it goes. If the diff
     changes the review loop, it goes to David** — the findings, the declines
     and all — for him to triage by hand. That is his ruling for the class
     (2026-09-23) and it holds whichever way the consequence test fell, so
     the three questions below are not asked of it: they choose between the
     merge button and David, and for this class the answer is already David
     ([`claude-core.md`](../../../.agents/core/claude-core.md#the-ship-gate-when-the-worth-rule-stops-being-asked-david-2026-09-19)).

     **For every other change, ask the three questions that decide whether it
     stops.** Ending iteration and declaring the work not ready are
     two different things. The limit's **"what ending iteration does NOT mean"**
     paragraph in [`working-modes.md`](../../../docs/ai-context/working-modes.md#the-two-review-limit-on-autonomous-iteration-david-2026-09-19) is the authority and
     the only statement of these three; they are enumerated here because this
     is the moment of action. (It is not step 3, which this cited until
     2026-09-23: step 3 says to review the corrected head and turn acceptable
     imperfections into recorded gaps. A reader who followed the citation to
     check found a step that says something else.) Does it violate an agreed
     requirement, does a required check fail, or does a finding establish
     consequential harm David has not accepted? **Any one of those and it does
     not merge** — the concrete shortfall goes to him with a choice: continue,
     cut the scope, or stop. **None of them and the round's remaining findings
     are recorded gaps and follow-up issues**, and the pull request goes to
     close-out like any other.
     (Codex, #140 round 3 — this branch escalated *every* second-review
     finding, so a routine round-two nit would have turned each internal pull
     request into a David-gated stop. An enactment that interrupts him more
     often than the design it replaced is a worse answer than doing nothing,
     and this whole limit exists because he said the looping overhead was
     slowing him down.)

   - **Otherwise** — any pull request's first review; and at any later round,
     product code, or machinery the consequence test above puts outside the
     limit, **the review loop excepted** — everything being written for goes
     in one push, with
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
     thread nobody re-reads.

6. **Re-request review on the actual head.**

   - **Every changed head gets its review; an unchanged one never gets a
     second.** A prose-only push is a changed head and is reviewed like any
     other — the rule here used to say it "waits and rides the next behavioural
     round", which under the write-gate meant a documentation correction with
     nothing behavioural behind it could never merge at all (#125 waited a week
     on that reading). What is refused is re-requesting on a head already
     reviewed as it stands, to get a different answer. (Astra, 2026-09-19.)
   - **On internal tooling — judged by consequence, per step 4's gate and
     [`working-modes.md`](../../../docs/ai-context/working-modes.md#the-two-review-limit-on-autonomous-iteration-david-2026-09-19) — or on a pull request that
     changes the review loop, the second review is the last one I request.**
     Step 4's gate is what enforces that, before anything is written; by the
     time a head exists here it is always reviewable. So this bullet has no
     decision left to make — it records the shape: round 1, one coherent
     batch, the review of that corrected head, and no more. Only David
     reopens a loop beyond it.
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
     dispatches neither on a clean round; a translation when one is owed,
     which the last round before a merge always is, so a clean terminal round
     is not free; and my own turns either way. Then what is downstream if this
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

7. **Translate the round for David when I declined something in it, or when
   something about it smells wrong — and always on the last round before a
   merge** (David, 2026-09-19). Not every round: four translations on #131 were
   the loop's single largest token line, and both of the translator's real
   disagreements came on rounds carrying a decline. **After the trigger is
   posted**, never before: a translation I could act on is an in-loop advisor
   reading my own prose.

   **The deliverable is a message in chat. There is no page** (David,
   2026-09-16). There was one, and removing it is what #109 round 3 actually
   found: it rendered HTML to a gitignored path, so the "delivery" was a file
   nobody could open, and the contract's "page link posted on the PR" named a
   link that never existed. Three of that round's four findings were the inside
   of that hole — no receipt producer, no deploy step, no synchronisation — and
   all three are gone with it rather than fixed. **Do not rebuild it.** Not an
   Artifact, not an HTML file, not a receipt store, not a link. David reads
   chat; a page is something he would have to go and open, and building a
   delivery system for one agent telling him the answer is undoing the #89 cut
   by hand.

   **How it runs**, and it is five steps. Everything the translator needs to
   locate the round is on the pull request; I pin two things and remember
   nothing between rounds or sessions:

   1. **`prepareAnswerPath(root, pr, round)`** — the answer directory exists
      and is ignored, and any earlier attempt's answer for this round is gone,
      so a re-dispatch can never be read as its predecessor. Then **bind the
      model once**: `dispatch = dispatchModel()`.
   2. **Dispatch `fable-round-translation`** with `model: dispatch.agentModel`,
      **passing the brief inline, never as a path.** That role's `tools:` list is
      `ToolSearch`, the two GitHub readers and `Write` — **no file-reading
      tool** — so a brief handed to it by path is unreachable. Measured on #131:
      it could not open the file, reconstructed every coordinate from GitHub
      correctly, and then wrote its answer to a *guessed* filename, which is the
      shape `prepareAnswerPath` exists to prevent — a valid answer written where
      `readAnswer` never looks reports as a FAILED translation of a round that
      actually ran. A `tools:` list is a hard upper bound, and the assessor role
      holding `Read` is not evidence that this one does.
      passing `roundBrief({ root, pr, round, head, finalRound, priorAccounts })`.
      **The activity window's upper bound is not passed** — `roundBrief` is the
      moment of the dispatch, so it stamps that moment itself. There is no
      `until` to capture, forget, or mistype (Codex, #109 round 6).
      `head` is the branch head at dispatch — **where the evidence stops, not
      the commit the reviewer reviewed**; the translator reads the reviewed
      commit off the round's own marker. `run_in_background: false` may be
      passed and costs nothing; it is **not** the synchronisation (below).
   3. **Read only after the harness reports the dispatch complete**, whichever
      way that arrives — in the tool result itself when the call blocked, or
      as a later task notification when it did not — and never assume which.
      Then `result = readAnswer(root, pr, round, { finalRound })`.
   4. **Paste `chatReport(result, { askedModel: dispatch.id })` verbatim**,
      and say nothing else about the round. If the completion signal lands in
      a later turn, the paste happens then, under this round's number, even if
      the next round's trigger has already been posted.
   5. **Keep `result`** for the final round's `priorAccounts`. It is the
      report-ready object, round number included, and a **failed** result is
      passed too: a translation that was owed and did not arrive is a
      limitation the final round has to be told about. A round the cadence
      never owed a translation is **not** — `roundBrief` names it as the
      ordinary case and tells the translator to read its threads directly.
      **Pass nothing for such a round.** A `{ skipped: true }` object is worse
      than passing nothing: `roundBrief` does not understand the flag, so it
      falls through and renders an empty account wearing a clean one's
      clothes.

   - **The completion signal is the synchronisation. The flag is not.**
     `run_in_background: false` has been measured **both ways** — it did not
     block on 2026-09-11 and it did on 2026-09-16, both recorded with dates in
     [`backgrounded-subagent-answer-is-in-its-own-transcript.md`](../../../.agents/memory/backgrounded-subagent-answer-is-in-its-own-transcript.md)
     — and the earlier version of this step wrote a rule on the single
     favourable sample, in the same commit that edited the note saying not
     to (Codex, #109 round 4). What every observation shares is that **the
     harness reports completion**, in the tool result when the call blocked
     and as a later notification when it did not. A read before that signal
     writes a failed round while the valid answer is still coming; that is
     the only ordering error, and depending on the signal removes it with no
     timeout to tune, no poll loop and no state.
     **When no signal ever arrives** — the agent errored, the session was
     interrupted — say nothing until the next event on this PR (interaction
     rule 9 permits silence), then read **once**: a valid file is the answer;
     no file is a `failed` round whose reason says *no completion signal and
     no answer file*, never an unanswered one. Never re-dispatch on the
     strength of a missing signal alone.
   - **The report is the translator's words, not my summary of them.**
     `chatReport` composes it from the validated answer's own fields; the only
     text in it that is not the translator's is the labels — including the
     deterministic "none reported" labels for an empty `disagreements` or
     `known_gaps`, which state the field's value and evaluate nothing. **The translation
     is a second account, not a ban on mine** (David, 2026-09-16: *"There's
     no need to be so paranoid about the builder writing up an account and
     giving it to me. That's not an issue at all."*). My own account of a
     round is welcome beside the report, labelled as mine. What is never done
     is editing the translator's account or presenting mine as it.
   - **The answer comes from the file, never from the dispatch's own reply.**
     Its location in the transcript has moved three times in a month in a
     harness nobody here controls; a path this module derives cannot move. The
     dispatch's own closing message arrives first and is not the answer.
   - **`readAnswer` returns the round `chatReport` consumes** —
     `{ pr, round, answer }` or `{ pr, round, failed: true, reason }` — so
     step 3's output *is* step 4's input, with no adapter to forget. It used
     to return a status object, and the documented flow printed
     `round undefined` and rendered a FAILED read as "no builder account yet"
     (Codex, #109 round 4, P1). All three delivery failures — no file,
     unparseable, schema-invalid — are one honest **failed** state, reported
     in plain words. **Never as quiet or skipped**: "no findings were raised"
     over a failed round is a false clean bill of health. One failure is named
     specially: an answer whose only problems are the final-round sections was
     read with the wrong `finalRound` flag, and the reason says so rather than
     blaming the translator.
   - **Nothing is remembered between rounds, and nothing has to be.** The
     activity window's lower bound, the commit the reviewer reviewed and the
     previous round's boundary are all read off **Codex's own markers on the
     pull request** — a formal review submission when a round has
     findings, a `**Reviewed commit:**` issue comment when it has none
     (measured on #115) — and the Nth marker is round N. The receipt store
     that went with the page had been carrying those coordinates silently,
     and a resumed session with nothing to pass re-attributed every earlier
     round to the current one (Codex, #109 round 4). **Two selectors, and
     they must not be swapped.** Code is selected by **ancestry** — the
     commits between the markers' commits, and from this round's marker to
     the head for the fixes claimed in reply; never by timestamp, since a
     commit's date is its author date and a cherry-pick pushed during a round
     carries an older one. Review activity is selected by **timestamp**, from
     this round's marker inclusive to the next round's marker exclusive, and
     never past `until` — with the role told exactly why each bound is open or
     closed, because the inclusive-both-ends rule this replaced would have
     collected 23 findings for #109's round 1 instead of 14 (Astra,
     2026-09-16).
   - **The upper bound is stamped, not supplied.** The comment reads are live
     and this dispatch runs detached by design, so a slow round-N translation
     can read round N+1's findings and replies — an account of a round that
     never happened, filed under N's number and indistinguishable from a
     correct one. `roundBrief` derives that bound because it *is* the moment of
     the dispatch; accepted as an input, `null` left the window open at the top
     and `"yesterday"` was interpolated as though it were a timestamp.
   - **`finalRound` is stated on EVERY round, true or false, and omitting it
     is refused** at all three entry points. `true` on the stopping round only,
     which is what asks for `known_gaps` and `what_landed`. It used to default
     to `false`, which is silently wrong in exactly one direction: omitted on
     both the dispatch and the read, the two agree on "ordinary", the mismatch
     check never fires, and the stopping round reads as translated with no
     cumulative assessment at all (Codex, #109 round 8). The cumulative change that answers
     `what_landed` is pinned to the head I pass: the live file-list endpoint
     takes no commit, so the role uses it only after confirming — **in the same
     breath as the read, never once at the start of the dispatch** — that the
     pull request has not moved past that head, and otherwise composes the
     cumulative view from the commits and says so (Codex, #109 round 7; the
     adjacency is that round's translation correcting my own reply, which
     claimed a guarantee the first version did not deliver). Pass the earlier rounds' **`readAnswer`
     results** as `priorAccounts`, whole and unedited — never bare answers,
     which carry no round number, and never file paths, since the role holds
     no `Read` tool and cannot be given a narrow one (below). A result from a
     **different pull request** is refused rather than quoted — one session can
     hold several, and a foreign account presented as this PR's own earlier
     work would steer the round David reads most carefully. `roundBrief`
     quotes each one's `about` line, its findings list in the report's own
     one-line-per-finding shape (outcome, whether it held, overbuilt),
     whether the builder had replied, what it could not assess, what it took
     on trust and every disagreement, and names each round that has no
     account, so the final round can state the limitation the role requires
     of it.
   - **The report's order is David's** (2026-09-19, revising 2026-09-17):
     `about` leads as his orientation, then the one-line ask, then
     disagreements, then one line per finding tagged with its outcome and an
     **OVERBUILT** flag where the builder wrote more than the finding was
     worth, then the final-round sections. There is **no reasoning paragraph
     and no trust footer** — he cut both (*"I don't care that you checked
     everything. I assume you did"*, *"I trust you"*), the schema no longer
     has `reasoning` and refuses an answer carrying it, and `took_on_trust` is
     still collected for the next round's translator but never printed. He
     relies on the per-finding lines to catch over-building in time to stop
     it; the headline carries the overbuilt count for the same reason.
     **Never reconstruct a field the schema dropped** — a round that tries
     fails validation and he is told no account exists.
   - **`builder_answered` comes from the role, not from a receipt.** "Agrees
     with the builder's account" prints only when the translator says it saw a
     builder reply. That used to be read off a receipt field whose only writer
     was the record builder the #89 cut deleted — after which every round read
     as answered and the favourable line printed over unanswered ones. An
     absent or malformed value reads as **unanswered**: of the two wrong
     accounts, the false favourable is the one that must never print. And an
     unanswered round with a concern of the translator's own is headed as
     exactly that — never as a disagreement *with the builder*, who has not
     spoken (Codex, #109 round 4).
   - **The model is disclosed, not observed — by choice, not by necessity.**
     The role reports its own model and `chatReport` mentions it only on a
     mismatch against `dispatch.id` or when it could not be determined. This
     bullet used to say a dispatch *cannot* prove what answered it; the harness
     does record the serving model per turn, independently of the subagent
     (measured 2026-09-18), so it could. David ruled on 2026-09-19 that reading
     it is not worth building — small blast radius, easily recoverable, and the
     self-report gives essentially all of the tracking value. Keep the
     disclosure honest about being a self-report; do not upgrade its wording to
     sound like an observation.
   - **A failed dispatch never blocks the loop.** The translation is off the critical path by
     design: say so in plain English and carry on.

   **A newly added agent type is not dispatchable immediately, and that is not
   a broken definition.** Measured 2026-09-16: a dispatch attempted minutes
   after the definition was created failed with `Agent type 'fable-round-translation' not found`,
   and the same type became dispatchable later in the **same** session with no
   restart. **Definitions are also cached against edits** — a dispatch after a
   frontmatter change ran against the old definition — so a probe of a
   definition change carries a freshness token planted in the same edit, or a
   stale definition is indistinguishable from the result being looked for. If a
   dispatch refuses, paste
   `chatReport({ pr, round, skipped: true, reason: "the dispatch was refused: <error>" })`
   so a failure to *launch* is told apart from a failure to *answer*, then
   write the round up myself, labelled as my own account (David, 2026-09-16,
   above: a builder-written account is not a concern; a failure notice with
   no explanation is). Try again next round rather than concluding the file
   is wrong.

   **What the role actually holds, measured on the real dispatch:**
   `ToolSearch`, `Write`, the GitHub read methods (deferred — it loads them
   itself with `ToolSearch`), and the injected `SubagentHandback`. **No `Read`,
   no `Edit`, no `Bash`, no `Grep`.** Per-method MCP names resolve in the
   `tools:` list, so *which* tools it holds is a real boundary rather than an
   asserted one.

   **`Write` is NOT path-scoped, and calling the list "read-only" was wrong.**
   `Write` is on it — I put it there and then described the list by the tools
   absent from it. A **path specifier in an agent's `tools:` list is not
   honoured**: the documentation says a specifier in a subagent's tool config
   removes the whole tool rather than narrowing it, and what
   `tools: Write(some/path/**)` grants is undocumented — possibly nothing,
   which would break the role silently. So the bare grant is what ships, and
   the exposure is named rather than papered over: **this role reads every
   comment on the pull request, from anyone**, so an injected instruction could
   direct its one write tool at any path in the checkout.
   What actually bounds it, in descending order of how much I would rely on it:
   the answer directory is `*`-gitignored, so the legitimate output can never
   be committed; the container is ephemeral; and **the only route to `main` is a
   commit I make**, so after any translation dispatch, read
   `git status --porcelain`. That last one is an honest party looking, not a
   lock on the same ring: the attacker here is a third party, not me.

   **What counts as noise is exactly one thing: an UNTRACKED file inside
   `.agents/reviews/`.** Everything else in that output is a finding, and in
   particular **a modification to any TRACKED file is a finding wherever it
   sits, that directory included**. The earlier rule said "treat anything
   outside `.agents/reviews/` as a finding", which exempted the whole
   directory — and `.agents/reviews/.gitignore` is a tracked payload file
   living in it. So the one file whose contents decide whether answer files
   can ever be committed was the one file a hostile write could change while
   the check that exists to catch hostile writes called it noise. The answer
   files are written from adversarial input, this repository is public, and
   publication cannot be undone. (Codex, #109 round 9, P1.)
   **Unable to verify in this session: whether a path specifier would in fact
   scope `Write`.** Agent definitions are cached, so the probe needs a fresh
   session. #114 carries it, and if scoping does work the bare grant narrows to
   one line.

8. **Merge, sync, report**, per `claude-core.md`'s *Close-out is mine, end to
   end*: re-verify live state with a fresh `pull_request_read` — not cached
   green — then squash-merge, trigger the Repl sync and verify it, execute the
   Post-merge verification section, post the harvest-notes comment, and send
   the merge report with both SHAs, the latitude line and the UAT handoff.
   **No readiness receipt is minted or quoted**: `pr-ready.mjs` is gone, and
   the four-item bar is read by eye.

## One standing stop

**A Codex code-review outage is a FULL STOP**, not the security-review
usage-limit bounce. Stop building, tell David as a 🛑 with a push
notification, say which PRs are blocked and in what state, and wait.

## Keeping the workstream issue's labels current

Per [`workstream-tracking.md`](../../../docs/ai-context/workstream-tracking.md),
`pr-watch` owns `stage:code-review` and everything downstream of it for the
PR's workstream issue (found via `Workstream: #N` in the PR body — if it's
missing, that PR skipped the tracking convention; flag it rather than
silently leaving the workstream unlabeled):

- **PR opens / round 1 triggers** → `stage:code-review`, `waiting:codex`.
- **Codex posts findings, I start responding** → `waiting:claude`.
- **I post the next round's `@codex review` trigger** → `waiting:codex`.
- **Intended behaviour or an accepted user-facing shortfall goes to David**
  (step 3.5 above — a purely technical fork is settled in the loop, never
  escalated) → `waiting:david`; `stage:code-review` stays put — the stage
  hasn't moved, but the turn has.
- **The close-out bar is met** (CLAUDE.md's *Close-out*, all four items) →
  the ready bar is met and **I merge it myself per CLAUDE.md's close-out
  contract (David, 2026-08-15)** — re-verify live state, squash-merge, sync,
  verify, report — so `stage:merge` is normally a moment, not a resting
  state. There is no carve-out exception any more (David, 2026-09-14): a
  guardrail- or authority-widening PR merges the same way, with the latitude
  it grants named in the report. The one PR that does not is a change to the
  review loop still carrying findings after its second review, which step 4
  sends to David.
- **The PR merges with a Post-merge verification section that has real
  content** → `stage:test-run`, `waiting:replit` — the lifecycle's own
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
  after the close-out sync checks pass, and only if a UAT doc
  exists or is actually due**. The transition moment is the verified Repl
  sync (matching SHA + clean worktree, per CLAUDE.md's close-out
  sequence), not the merge click — a failed sync would otherwise put a
  David-held UAT gate on the board for a build he can't actually reach;
  until the checks pass the workstream stays agent-held in close-out.
  On the UAT-doc test: pure-docs/pure-devops PRs never have one,
  and neither does a Tier A bugfix or a Tier B bugfix whose only surface is
  internal (per `working-modes.md`'s Tier B exception): all three go
  straight to `stage:close-out` instead, since holding them at `uat` would
  be a gate with nothing to run against it. "Has product-visible behavior"
  is *not* the test by itself — a Tier A fix can be product-visible and
  still ship no UAT doc, which is what makes checking for the doc the right
  test, not the behavior. **When that straight-to-close-out case is a
  product-visible fix that shipped no UAT doc (the Tier A case), the
  close-out State of Play's *What you need to do* aims David instead of
  saying "nothing" (David, 2026-08-09):** one line — where in the app to
  glance next time he's there, and to reopen the workstream if the symptom
  persists. No gate, no extra stage — David is the acceptance test whether
  or not a stage tracks it; this just points him. Never `stage:done` at
  merge — that's David's to set once he's actually verified it, the same
  reason the Project's built-in `PR merged → Done` workflow is off.

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
  `stage:close-out`. There is no separate whole-feature UAT gate — every
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
and `Where it actually stands`/`What's blocking` whenever there's real
narrative to add (a round's findings, an escalation's actual question, what
shipped at merge). Per `workstream-tracking.md`'s ownership rule: the skill
that moves the label moves the block, in the same edit, every time.

An echo of my own comment bouncing back as a webhook event still needs the
silent live-state check like any other event, but never a label change on
its own — only real state (a new commit, a new finding, an actual merge)
moves a label.

Codex (and other AI reviewers) remain the independent reviewers; my job while
watching is to *respond* — judge every finding under the Worth rule with both
assessments in hand, and take to David only what is his.

