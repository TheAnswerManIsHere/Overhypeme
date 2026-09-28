---
name: In the Claude app, text I write between tool calls reaches David as a paraphrase — only the final message arrives verbatim
description: A question posted before a PushNotification (or any other tool call) in the same turn rendered on David's iPad as a one-paragraph summary in a different voice, and he could not tell what the question was. Anything he must read exactly — a question, an ask, a banner — goes after the last tool call of the turn.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# Text between tool calls is summarised on David's side

## The mechanic

The cloud harness states it plainly: *"The user may not see your tool calls,
tool results, or the text you write between them. Only your final message
reliably reaches them."* Measured 2026-09-25 on the DojoOS grilling: a
`❓ **Q22**` block written before a `PushNotification` call arrived on David's
iPad as a blockquoted paraphrase beginning *"I'll go with option (1) for
increment 1…"* — a summary, in a voice that was not mine, of a question that
was supposed to be his to answer — and the verbatim final message was the
three words *"Waiting on Q22."* He wrote back: *"Notice that you're not making
it clear what the next question is."*

## The rule

**Anything David must read exactly goes after the last tool call of the
turn.** A grilling question, a 🛑 banner, a numbered-options ask, a merge
report. Tool calls that belong to the same turn — the notes update, the
`PushNotification` the banner rule requires — run first; the text comes last.
The notification's *"fires in that same turn"* requirement is satisfied either
way, so there is no tension between the two rules.

The one-question-per-turn grilling format (#166) makes this bite every turn:
the question is the whole deliverable, and a summarised question is no
question.
