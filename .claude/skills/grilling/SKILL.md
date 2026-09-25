---
name: grilling
description: Grill David relentlessly about a plan, decision, or idea. Use when he wants to stress-test his thinking, or uses any 'grill' trigger phrases.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.

## Local adaptations

Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT); the body above is upstream verbatim. Local rules that govern how it runs here:

- **The interviewee is David.** Numbered questions (Q1, Q2, …) are already the house rule — never letters.
- **Keep each question body to a few short sentences**: the issue, the options, the ramification of each. The most-reported failure of this skill upstream is three-paragraph questions causing decision fatigue — and terse, decidable-at-a-glance asks are exactly what `CLAUDE.md`'s banner rule already demands.
- **A round that ends the turn waiting on David's answers is a blocking ask** — the push-notification rule applies, every round.
- **Sub-agent dispatch obeys the standing delegation caps.** Upstream's "dispatch a sub-agent" for environment facts is subordinate to `CLAUDE.md`'s rule that work finishable in a handful of tool calls is never delegated: a file read, a grep, a quick lookup happens directly in the main loop between rounds. A sub-agent is for a genuinely substantial, self-contained investigation only. The don't-block-the-frontier rule applies the same either way — an unfinished lookup just holds back its downstream questions.
- **"Do not act until the user confirms" composes with the standing ceremony, it doesn't replace it.** A grilling session's output feeds the normal flow (scope-of-work gate, plan, plan-review loop, or bugfix mode as the request's shape dictates); shared understanding here is never plan approval, which stays explicit-only.
