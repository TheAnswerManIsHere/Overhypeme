---
name: retitle
description: Rename this session so its title says, in a few plain-English words, what the work in it is about now — not what it was about when it started. Use when David says /retitle, "rename this session", "retitle this", or "the session name is wrong"; and use it unprompted when the work in a session has clearly moved on to a different thing than its title names (a new pull request or workstream starts, the old one has merged). Reads only this session's own context and its open pull request, writes one title, reports it in one line. NOT the built-in /rename, a command David types that sets the name he gives or, with none, one generated from the chat — once, with no rules for how it reads.
---

<!-- SYNCED FROM KITT — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change KITT instead. -->

# /retitle — name the session for what it is doing now

*Nickname: **Devon**, for Devon Miles, who gave Michael Long the name he
drove under for the rest of the series.*

A session's title is set once, from its first message, and the work drifts:
a session titled "Launch Phase 5" is an hour later about font loading, and
David, scanning his session list, can no longer tell which one is which
(David, 2026-11-03: *"the goal is to make it so that in a few words I can
easily understand what the session is about so that when I look at it in a
list I can identify what it's all about"*). This skill writes the title a
cold reader of that list needs, and nothing else.

**Why this exists beside the built-in `/rename`.** Claude Code's `/rename`
renames the session to a name typed after it, and *"Without a name,
auto-generates one from conversation history"* (Claude Code docs, *Commands*).
Either way David has to notice the drift and type it, and nothing governs how
the generated name reads. This skill applies the rules below, reads the pull
request and workstream as well as the chat, keeps a title that still fits,
and runs on its own when the work moves on (David, 2026-11-03: *"They do
different things. One is me renaming (which I can more easily do from the
GUI) and the other uses your intelligence to give the session a more
meaningful name."*).

**Why `/retitle` and not `/rename`.** In a cloud session the built-in wins over
a skill of the same name, so a skill called `rename` would never run there;
in a local terminal it would replace the built-in, taking away the manual
command (Claude Code docs, *Skills*, "Resolve skills that share a name":
*"In a local terminal session, your skill replaces the built-in command …
this built-in-command replacement applies only in a local terminal
session."*). A different name keeps both.

It runs in the main loop, at any model tier, and never dispatches: the
input is this session's own context, which a subagent does not have.

## Step 1 — what is this session doing now

Read, in this order, and stop as soon as the answer is clear:

1. **David's most recent requests in this session**, and what I am doing
   for them. The latest substantive piece of work outweighs everything
   before it; a quick side question answered along the way (a settings
   question, a status check) is not the session's subject.
2. **The pull request this session has open or is driving** — its title
   says what is being built, in words already agreed.
3. **The workstream issue**, if one is named, for the plain-English name of
   the feature.

If two threads are genuinely live, the title names the one the session will
keep working on. Never list both with "and".

## Step 2 — write the title

- **Three to six words, about forty characters at most.** A session list
  truncates long titles; the limit is my judgement of what survives that,
  not a measured width.
- **Plain English, sentence case, what is happening to what**: *"Fixing
  font loading on meme pages"*, *"Planning the leaderboard redesign"*,
  *"Building a session rename skill"*. An activity word ("Fixing",
  "Planning", "Building", "Testing", "Reviewing") is worth its place when it
  says which stage the work is at.
- **David's own words for the feature** — the ones he uses in chat, in the
  workstream issue, in the plan. A word he would have to decode does not go
  in.
- **Never**: a pull request or issue number, a branch or file name, a
  function or library name, a Codex or review-loop term, an in-house
  nickname (KARR, Bonnie, Astra) — unless it is the plain word David uses
  for the thing — or "Phase N" on its own, which says where in a plan the
  work sits and not what it is.
- No trailing punctuation, no emoji, no quotation marks.

## Step 3 — apply it

- **Read the current title first** (`get_session` with `session_id`
  omitted, from the `claude-code-remote` tools; load them with `ToolSearch`
  if they are deferred). If it already says what Step 1 found, **keep it**
  and say so — a rename that changes a word for its own sake makes the list
  harder to scan, not easier.
- Otherwise call `set_session_title` with this session's id (the `id`
  `get_session` returned) and the new title. The tool echoes the session
  back; its `title` field is the check that the rename applied.
- **Where there is no such tool** — a local terminal session, a Remote
  Control session — I cannot rename it. I give the title I would have set,
  and say that `/rename <title>` applies it there; `/rename` alone would
  generate its own name instead, without these rules.

## Step 4 — report in one line

`Renamed: <old title> → <new title>`, or `Kept: <title>` when it already
fit. Nothing else about the skill. When David invoked it, this is his
answer, inside the turn's usual footer. When I ran it unprompted, the line
sits in the hand-back of the turn it happened in, with no 👀 FYI: a title
is trivially reversible and holds nothing up.
