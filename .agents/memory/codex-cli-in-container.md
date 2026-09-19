---
name: Codex CLI in a cloud session — closed stdin, a sandbox that blocks /tmp, and a pkill that kills the caller
description: Running `codex exec` from a Bash tool call has four traps that each look like something else. An open stdin hangs forever (looks like a slow model). `--sandbox read-only` blocks /tmp, so a reviewer told to run the suite gets EROFS (looks like a broken repo). A run longer than the tool timeout needs setsid nohup plus an exit file. And `pkill -f 'codex exec'` matches the calling shell's own command line and kills the session's shell.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# Spawning Codex CLI inside a Claude cloud session

Measured on `@openai/codex` 0.153.4 in the Claude Code Remote container,
2026-09-09, while building the in-session plan reviewer
(`core/scripts/plan-review.mjs`, workstream #66). Each of these was found by
hitting it, and each one's symptom points somewhere other than its cause.

## 1. `codex exec` waits forever on an open stdin

The Bash tool leaves stdin open. `codex exec` with no prompt argument reads
instructions from stdin, and an open-but-silent stdin is not EOF — so it waits,
producing no output, until the tool times out.

**The symptom is "the model is being slow."** It is not; nothing has been sent.

Two working shapes:

```bash
codex exec "the prompt" </dev/null      # prompt as an argument, stdin closed
printf '%s' "$prompt" | codex exec -    # `-` reads the prompt from stdin
```

From Node, `spawnSync(..., { input: prompt, stdio: ["pipe", ...] })` writes the
stream and closes it, which is the same thing done properly. `plan-review.mjs`
uses that shape and passes `-` last for the same reason.

## 2. `--sandbox read-only` blocks `/tmp`, not just the repo

The read-only sandbox is not "read the repo, write nowhere else" — it denies
writes **everywhere**, `/tmp` included. So an agent told to run the project's
test suite gets `EROFS` from the test runner's own scratch files, which reads
like a broken checkout rather than a sandbox policy.

The pilot hit exactly this: the reviewer tried the suite, failed on `/tmp`, and
honestly recorded it under `unable_to_verify` instead of guessing — which is the
behaviour you want, but it costs a section of the review.

If the spawned agent genuinely must run a suite: `--sandbox workspace-write` on
a **scratch checkout** (a `git worktree`, never the live tree), or set `TMPDIR`
to a writable directory inside the workspace. If it only needs to read and
grep — which is what plan review needs — leave it `read-only`.

## 3. A long run needs `setsid nohup` and an exit file, not a foreground wait

One `xhigh` review round measured **522 seconds**. That is longer than a
comfortable Bash tool call, and a foreground run that gets cut off leaves no
result at all.

```bash
setsid nohup bash -c "cd $DIR && codex exec … >$DIR/run.log 2>&1; echo \$? >$DIR/run.exit" \
  >/dev/null 2>&1 &
```

Then poll for `run.exit` — its existence is the completion signal and its
contents are the status. Two details that cost time here:

- **Use absolute paths inside the `bash -c`.** The Bash tool resets the working
  directory between calls, and a `cd` in the launching command does not survive
  into the detached child the way you expect. The first attempt wrote its log
  to a directory that no longer applied and looked like a process that never
  started.
- **Read the answer from a file, never from the transcript.** `codex exec`
  prints every tool call it makes (45 of them in the pilot). Use
  `--output-last-message <file>` and read that; scraping stdout for JSON is a
  parser you will have to maintain against a transcript format you do not own.

## 4. `pkill -f 'codex exec'` kills the shell that runs it

`-f` matches against the full command line, and the shell running
`pkill -f 'codex exec'` has `codex exec` in **its own** command line. It matches
itself and dies. The session's Bash tool call ends with no output and no
explanation.

Match the binary path instead (`pkill -f '/node_modules/.bin/codex'`), or record
the PID when you launch it and kill that.

## 5. Two flags that are not tidiness

- **`--ignore-user-config`.** `--output-schema` is **ignored when MCP tools are
  active**, and a user `config.toml` is how MCP tools get turned on. So a schema
  that silently stops constraining the output is one stray config file away.
  Auth still reads from `CODEX_HOME`, so this does not disturb the sign-in.
- **`--ephemeral`.** No session file on disk, which makes "fresh context every
  round" structural rather than a convention someone remembers.

## 6. `codex login status` exits 1 and says "Not logged in"

Both signals are available and both are worth reading — an exit code is a thin
thing to hang a refusal on. Sign-in in a cloud session is **per session, by
device code, and never stored**; see
[`web-research.md`](../../docs/ai-context/web-research.md). The device code
expires in about 15 minutes, so issue it and ask for approval in the same turn
rather than preparing work first.
