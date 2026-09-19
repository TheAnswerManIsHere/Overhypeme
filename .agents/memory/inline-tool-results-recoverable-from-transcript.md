---
name: An inline tool result can be recovered byte-exact from the session transcript
description: A tool response small enough to come back inline is normally re-typed into a capture file, which is where evidence gets corrupted. The same bytes are on disk at ~/.claude/projects/<encoded-project>/<session-id>.jsonl as tool_result blocks. Write the extract OUTSIDE any tool-results directory, or captureSource() will classify it harness-capture and discard your declared fetch time.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

## Rule

Never retype a tool response into a capture file from what is on screen. The
harness has already written the bytes to

```
~/.claude/projects/<encoded-project>/<session-id>.jsonl
```

where each tool response is a `tool_result` block. Read them from there.

**The project directory segment is not optional.** The encoded project name
sits between `projects/` and the session file — measured 2026-09-11, this
repo's transcript is at
`/root/.claude/projects/-home-user-AI-Handbook/<session-id>.jsonl`, and no
`.jsonl` exists directly under `projects/`. A path written without that
segment finds nothing and sends you back to the transcription step this note
exists to remove.

**Write the extract outside any `tool-results/` directory.** See the trap
below; it is the one way this note can make provenance *worse* instead of
better.

## The mechanic

The harness spills an **oversized** tool result to disk and hands back a path;
a **smaller** one comes back inline in the conversation. The capture machinery
classifies these differently and by path, never by declaration —
`harness-capture` for the spilled file (no agent in the path) versus
`agent-written` for anything transcribed.

Measured threshold: between ~50 KB (inline) and 69,207 characters (spilled).

The asymmetry that follows is the whole problem: **evidence the harness writes
costs nothing to refresh, and evidence it hands back inline costs a
transcription.** So any rule demanding a large capture per round is free, and
one demanding a small capture is a tax — and the discipline that is expensive
is the one that gets skipped, which is how evidence got fabricated in the
first place (AI-Handbook #38, round 4: a snapshot carrying invented ids).

The transcript closes that gap for the inline case. The bytes exist; the
retyping step is optional.

## The trap: where you save the extract decides how it is classified

The handbook's former snapshot assembler classified a capture **solely from
the path** its `captureSource()` was handed — and anything that rebuilds this
for #95 or #96 will face the same choice:

```js
/(^|\/)\.claude\/projects\/(?:[^/]+\/)+tool-results\//.test(resolve(file))
  ? "harness-capture"
  : "agent-written"
```

So a recovered block saved alongside genuine harness captures under
`~/.claude/projects/<project>/<session>/tool-results/` is classified
**`harness-capture`** — and `resolveCaptureTime()` then takes the file's mtime
and **ignores a declared `--fetched-at` entirely** (`if (source ===
"harness-capture") return { capturedAt: mtime, capturedAtSource: "file-mtime" }`).

That inverts the note's purpose: an inline result recovered and saved later
would present a fresh save time as the fetch time, with the stronger
evidentiary weight of a harness capture. **Save the extract anywhere else**
— a scratch directory — and pass `--fetched-at` with the real fetch time.

## What this does NOT do

Saved correctly, the file stays classified `agent-written`. A wholly
agent-written record is weaker evidence than a harness capture, and that
caveat is unchanged. This removes the **corruption** risk, not the provenance
caveat.

Hand-typed values do drift in practice, not just in theory: transcribed
issue-comment `created_at` values have come back up to two minutes off
GitHub's actual timestamps.

## Related

- AI-Handbook #75 — the mechanical record's evidence path had an unguarded
  hand step. **Closed** by #79, which made this recovery a script; the #89 cut
  then removed that script with the record it fed. The note stays because the
  technique is still worth knowing, the `tool-results/` trap is still live,
  and **#95 and #96 both have to solve the same problem**: this container
  cannot call GitHub from a dispatched session, and an MCP tool result lands
  in the builder's context rather than in a file the dispatched session can
  read. **A large result is SPILLED to `tool-results/` as a wrapped envelope**,
  `[{"type":"text","text":"…"}]`, not the raw body — which broke the assembler
  twice on #91, and precisely on the long loops where the evidence matters
  most, because a thread payload grows monotonically with its rounds. Test any
  replacement on both an inline and a spilled result.
- [`backgrounded-subagent-answer-is-in-its-own-transcript.md`](backgrounded-subagent-answer-is-in-its-own-transcript.md)
  — the case where the block you want is not a `tool_result` at all.
