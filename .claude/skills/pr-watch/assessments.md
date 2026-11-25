<!-- SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead. -->

# pr-watch — step 3: the two assessments, sub-steps 1 to 6

Part of the `pr-watch` skill ([`SKILL.md`](SKILL.md), step 3), moved here whole;
"step 3.N" anywhere means sub-step N below. Read it when a round returns
findings, before anything is written for them.

   1. **Collect this round's findings** from the live state read in step 2,
      bounded to this round by the reviewer's own markers — the same
      inclusive-current, exclusive-next window, and for this reason:
      `get_review_comments` returns every thread on the pull request, so an
      unbounded read on round 2 hands the assessors round 1's findings again
      and collects fresh advice on settled work. Write them as
      `[{ id, body, path, line }]`, with GitHub's own comment id.
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
      (the `buildreport` skill) is.

      **Pass the argument even though the definition now declares the tier.**
      `fable-review-assessor` carries `model:` and `effort:` in its frontmatter,
      held equal to `strongestClaude` by `scripts/check-agent-models.mjs` — but
      an argument outranks frontmatter, an edited definition can be served
      stale, and a consumer's own pin reaches the dispatch only this way. The
      two together are the belt and the braces; `model-routing` has the measured
      resolution order and why neither alone is enough. What is at stake if both
      are missed: on an ordinary Opus session the second assessment is Opus
      wearing the Fable label while holding the tie-break, and the post does not
      say so. **One brief serves both** — it says "the other assessor"
      throughout — and the only difference between the two packages is the
      identity block the script adds, which names who each reader is and which
      of them holds the tie-break. A brief that named a role would be wrong for
      exactly one of them, silently. **Neither sees the other's answer** — that
      is what makes the readings independent rather than merely separate, so do
      not pass one into the other.

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
      assessment covered. The script refuses a follow-up header naming no
      findings.

      **The header says what was asked for and the assessment's own
      `_Running as:_` line says what it is running as** — line 2, under the ship
      gate, which is line 1 for both assessors. Nothing here claims they match:
      this reads a file and cannot interrogate what wrote it, and a control
      reporting success having evaluated nothing is the worst available
      failure. When the two lines disagree, that is an 👀 FYI to David naming
      both, not a blocker and not a reason to discard the assessment.

      **The Fable header carries three facts and labels each one**, because the
      assessor is reached by an alias and not by a version: `expected` is the
      pin, which is what the self-report is compared against; `instructed alias` is
      the family alias the recipe sends, derived from the pin — an instruction,
      not an observation, since this script never makes the call; `definition …`
      is what the role's file declares, as read at render time. Only Astra's
      header says `requested`, because only Astra is handed a full id and an
      effort per call.

      **Which of the two causes a model disagreement has is decided by the
      answer's family, not by judgement.** Same family as the pin — the alias
      resolves to a different version — is a drift between the pin and the
      alias, which is David's one-line edit. A **different** family rules that
      out entirely: `fable` cannot resolve to an Opus model, so the platform
      served something else, which `model-routing` records as a content refusal.
      The FYI follows that line rather than second-guessing it. And `definition …` never
      means "what ran": definitions are cached, so the file on disk may not be
      the one that answered, and the assessor's own line is the only
      observation there is.

      **Effort is the weaker half of that comparison.** It has no argument at
      all, so the header can only report what the definition declares. On the
      reporting side, an assessor may not be able to name its effort at all
      (its context may show reasoning effort as a number, not one of the pin's
      named levels). **So an effort the assessor could not name is not a
      mismatch**; report it once as the limit it is and do not raise it every
      round. A **model** it could not name, or one that disagrees, is the FYI
      that matters.
   5. **Decide, and say what I decided.** Investigate disputed facts myself in
      the repository and the tests — an assessor should not be asked to settle
      what a few tool calls answer. Where a real question of reasoning remains,
      put it to both. **This costs no commit and no Codex round.**

      **They are two different mechanisms.** Astra's follow-up is a **cold
      re-dispatch**: a fresh `codex exec` that remembers nothing, so the script
      rebuilds the whole package —
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
      `round-<n>.fable.followup-<k>.md` explicitly.

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
      produced it. The Fable side needs no such guard, so a package guard is
      written on the Astra side only.

      **The question carries the evidence**, in the form
      `claude-core.md`'s *A load-bearing claim is quoted, or it is marked
      unverified* already requires: command output and source lines quoted with
      their origin, never paraphrased into my own assertion, and my inference
      from them labelled as mine. There is no separate evidence input.

      A purely technical disagreement that survives is the Fable assessor's to
      settle, with its reasoning recorded. **Intended behaviour and any accepted
      user-facing shortfall go to David** as a 🛑 with a push notification —
      where no settled decision already covers them; a consequence a settled
      decision reaches is settled with it, and the thread reply names the
      decision (`agent-working-rules.md`, *A reversible choice proceeds on the recommendation*) — and
      stay open until he answers — a later clean round never clears them, and
      **neither does a default of mine.** A question of his that goes unanswered
      stays **open** — `PushNotification` re-fired (the alert hook rings it only once) and pointed back to, reprinted only when
      the ask itself changes (`claude-core.md` interaction preference 6) — not
      resolved by whatever I pre-registered as the fallback. A pre-registered
      default is for what *I* do while waiting, never for what *he* decided.
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
      **A push that landed after the round's review and before both
      assessments is disclosed in this block**, whatever the action: the
      commit, what it contained, and whether it touched a line a finding
      names. An early push of a fix is named as a breach of the write-gate
      rule; a build report David asks for carries it, and it asks David for nothing
      (`claude-core.md`, *Shared judgement* item 6).

   **Sign-in is the session's first action** (`claude-core.md`, *Astra*); a
   dispatch only re-checks it, so a restarted container is caught before a
   round starts rather than mid-round. `$CODEX_BIN login status` decides; the
   steps are in `claude-core.md`'s *Astra* section, and the device code
   expires in about fifteen minutes, so the ask and the code go to David in
   the same turn.

   **No clock stops a loop.**
