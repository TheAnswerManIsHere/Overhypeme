---
name: A backgrounded subagent's answer is in its transcript's handback call -- prefer having it write a file instead
description: The harness pairs a backgrounded Agent tool_use with a launch notice, not the agent's answer. The answer is the last SubagentHandback tool_use's input.message in <session-transcript-without-.jsonl>/subagents/agent-<agentId>.jsonl -- NOT the last assistant text block, which is closing chatter (measured 2026-09-16: 'Report delivered.' on both agents sampled). Those are the ORIGINAL bytes — the copy rendered back into the session is neutralized where it matched an instruction-shaped pattern. Measured 2026-09-11: this harness backgrounds every Agent dispatch even when run_in_background is false, so "dispatch in the foreground" is not an available remedy.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

## Rule

To recover a subagent's answer from the transcript, **do not read the
`tool_result` paired with its `tool_use`.** For a backgrounded dispatch that
block is the harness's launch notice:

```
Async agent launched successfully. ...
agentId: <id>
```

The answer is the **last `SubagentHandback` tool_use's `input.message`** in
that agent's own transcript:

```
<session-transcript-path minus .jsonl>/subagents/agent-<agentId>.jsonl
```

So for a session at
`/root/.claude/projects/-home-user-AI-Handbook/<session-id>.jsonl`, the agent's
transcript is
`/root/.claude/projects/-home-user-AI-Handbook/<session-id>/subagents/agent-<agentId>.jsonl`
(a sibling `agent-<agentId>.meta.json` sits beside it). The `agentId` is in the
launch notice, which is the link between the two.

Read the file to its end and keep the **last `SubagentHandback` tool_use**, then
take its `input.message`.

**NOT the last assistant `text` block.** This note said that until 2026-09-16
and it was wrong: measured across two agents in one session, the last text
block was the string `Report delivered.` both times -- the agent's closing
chatter after handing back. A caller following the old rule gets a plausible
seventeen-character string instead of the answer, which is worse than getting
nothing. Keep the last-text-block read only as a fallback for an agent that
ends without a handback.

**This location has now moved three times** (#91 moved it one block further
out; this note then pinned it to the last text block; the handback is where it
is today). The harness is not ours and nothing announces a change. **Prefer a
dispatch that has the agent WRITE its answer to a path you chose** -- then
nothing here is load-bearing. Read the transcript only when that is not
available, and treat the layout below as observed on 2026-09-16 rather than
guaranteed.

**Recover only after the dispatch reports completion.** Nothing gates recovery
on it, and a transcript read mid-run is either absent or ends on that interim
chatter — so an early read looks like failure when the answer is still coming.
Waiting costs nothing; the re-dispatch it would otherwise tempt you into costs
a whole adjudication. (Codex, #80 round 2.)

## Why the foreground is not the remedy

The obvious alternative is a contract line — *dispatch adjudicators in the
foreground, where the paired result really is the answer.* **It is not
enforceable here.** Measured 2026-09-11, in this container: an `Agent` call
made with `run_in_background: false` still returned "Async agent launched
successfully" with an `agentId`, and its answer still arrived out of band.

That is one measurement of the false case, not an exhaustive survey — but it is
enough to reject a rule whose whole value depends on the flag being honoured.
Follow the id; do not write the rule.

**Measured the other way on 2026-09-16, and that makes the rule worse, not
better.** In a cloud session that day, an `Agent` call made with
`run_in_background: false` **blocked to completion** — its tool result read
*"This agent's report was delivered to you as a message"* with a duration —
and a call made with `true` the same day returned *"Async agent launched
successfully"* and completed later as a harness task notification. So the flag
has now been observed both ways, dated. A rule that depends on it was written
anyway, off the single favourable sample, in the same commit that edited this
note; the reviewer caught it (Codex, AI-Handbook #109 round 4). **The one thing
every observation shares is that the harness reports completion** — in the tool
result when the call blocked, as a later notification when it did not. Depend
on that signal, whichever way it arrives; never on the flag, and never assume
which way it will go.

## The subagent transcript holds the ORIGINAL bytes

This is the part worth the note on its own. The copy of a subagent's answer
that the harness renders **back into the session** can be neutralized: where
the output matches an instruction-shaped pattern, control characters are
escaped and a preamble is prepended saying so.

Measured on the same dispatch, one string, two places:

| Where | Bytes |
|---|---|
| Rendered back into the session | `&lt;record&gt;.verdict.json` |
| `subagents/agent-<agentId>.jsonl` | `<record>.verdict.json` |

**The transcript is the only route to the actual bytes**, so it is the source
to read whenever the exact characters matter — a quoted citation, a value
compared against something else, anything an escape would change the meaning
of. The session-rendered copy is the wrong source for all of it.

**What this does NOT claim: the committed verdict file is not byte-exact.**
`recoverVerdict()` parses the answer and writes a freshly-serialized document,
so fences, whitespace and equivalent JSON escape spellings are gone. What
survives is the answer's *values*, taken from the right source — which is why
`<record>.verdict.json` above holds `<`, not `&lt;`. **A digest must hash the
transcript text directly**; hashing the committed file and expecting it to
match the answer will fail, and would look like tampering rather than
formatting. (Codex, #80 round 1.)

## The failure mode it replaces

Before this was understood, recovery read the launch notice, failed to parse
it, and reported:

```
the adjudicator's recorded answer does not parse as a JSON object carrying a
`verdict` field. Its contract says to return JSON and nothing else;
re-dispatch rather than editing the answer.
```

Every clause of that is wrong about the cause. The judge returned perfect JSON;
the harness's bookkeeping was in the block being read. And the remedy it
advises — re-dispatch — costs a full adjudication and **fails identically**,
because the second dispatch is backgrounded too.

A refusal that misdiagnoses is worse than a loud one: it spends the expensive
thing while pointing away from the fix. The script that read this was removed
in the #89 cut, along with the adjudicator whose answer it recovered — **and
the harness fact is unchanged**, so anything that recovers a backgrounded
agent's answer has to follow the id, and say by name when that agent's
transcript is genuinely missing rather than blaming the agent.

## Related

- [`inline-tool-results-recoverable-from-transcript.md`](inline-tool-results-recoverable-from-transcript.md)
  — the same idea one level up: a tool response is on disk, so it never needs
  retyping. That note covers `tool_result` blocks in the session transcript;
  this one covers the case where the block you want is not there at all.
- `capture-from-transcript.mjs` implemented this (`backgroundAgentId`,
  `agentAnswer`), discovered by running it rather than by review — AI-Handbook
  #79 — and was removed by the #89 cut. **The measured failure is worth
  carrying into #96**: on #91 the harness moved the answer one block further
  out than the recovery path expected, the script refused, and its refusal
  advised a re-dispatch that cost a full adjudication and could never succeed.
  A recovery path that names what it could not find beats one that names a
  remedy it has not checked.
