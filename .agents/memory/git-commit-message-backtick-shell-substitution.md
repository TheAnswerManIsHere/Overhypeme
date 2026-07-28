---
name: Git commit message backticks trigger shell command substitution
description: A `-m "..."` string with backtick-quoted code spans gets executed by bash before git ever sees it — write the message to a file and use `-F` instead.
---

## Rule
Never pass a commit message containing backtick-quoted text (e.g. `` `--pr <number>` ``,
`` `chatgpt-codex-connector[bot]` ``) directly to `git commit -m "..."`. Write the
message to a file first and commit with `git commit -F <file>`.

## What happens if you don't
Bash expands `` `...` `` inside a double-quoted `-m` argument as command
substitution *before* git ever receives the string. A message like:

```
git commit -m "Fixed the `--pr <number>` path..."
```

runs `--pr <number>` as a shell command, and its output — or an unrelated
command's output if the backtick content isn't a real command — gets spliced
into the commit message. Concretely, this happened with a message quoting
`` `chatgpt-codex-connector[bot]` `` and similar code spans: the backticks
weren't recognized as markdown by bash, one of them got interpreted as an
attempt to run a shell command, and the literal output of `id`
(`uid=0(root) gid=0(root) groups=0(root)`) ended up embedded in the
already-pushed commit message.

## Why it's dangerous
The corruption lands in a commit that's already pushed. Force-push and
`git reset --hard` are blocked in this environment
([`working-modes.md`](../../docs/ai-context/working-modes.md) / `CLAUDE.md`'s
git-constraints section), so the message cannot be amended — the only fix is
an empty corrective commit (`git commit --allow-empty -F <file>`) explaining
what happened, which is honest but permanently visible in history.

## How to avoid
Always write the commit message to a scratch file, then:

```
git commit -F /path/to/scratch/commit-msg.txt
```

This applies to **every** commit message with markdown code spans, not just
ones that happen to contain a real shell command word — the danger is the
backtick pair itself, not what's inside it.
