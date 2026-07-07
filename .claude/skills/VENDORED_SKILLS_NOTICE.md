# Vendored / externally-installed skills

Claude Code on the web doesn't support `/plugin` marketplace commands, so
external skills are pulled in either by copying skill files directly into
`.claude/skills/` (which Claude Code auto-discovers, no plugin system
needed) or via the `npx skills@latest` CLI, which does the same thing
non-interactively. This file tracks provenance/licensing for each.

## Vendored skills from trailofbits/skills (CC BY-SA 4.0)

The following skill directories (and two agents under `.claude/agents/`) were
copied verbatim from https://github.com/trailofbits/skills, which is licensed
under Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0):

- `differential-review` (+ agent `adversarial-modeler`)
- `insecure-defaults`
- `supply-chain-risk-auditor`
- `semgrep` (+ agent `semgrep-scanner`)
- `sarif-parsing`
- `fp-check`
- `agentic-actions-auditor`

Vendored instead of installed as a Claude Code plugin because plugin
marketplace commands (`/plugin`) aren't available in Claude Code on the web —
skills placed under a project's `.claude/skills/` folder are auto-discovered
without that step.

Only change made to upstream content: `semgrep`'s SKILL.md, scan-workflow.md,
and scanner-task-prompt.md referenced the plugin-namespaced subagent type
`static-analysis:semgrep-scanner`; rewritten to the plain `semgrep-scanner`
since project-level agents in `.claude/agents/` aren't plugin-namespaced.

Not vendored (referenced by these skills but out of scope for this pass):
`codeql` and `sarif-parsing`'s sibling `audit-context-building` / `issue-writer`
skills. Each of the above still works standalone without them.

Source commit: main branch of trailofbits/skills as of 2026-07-07.
Attribution: Trail of Bits (https://github.com/trailofbits/skills), CC BY-SA 4.0.

## Vendored skills from obra/superpowers (MIT)

All 14 skills under `skills/` from https://github.com/obra/superpowers were
copied verbatim into `.claude/skills/`: `brainstorming`,
`dispatching-parallel-agents`, `executing-plans`,
`finishing-a-development-branch`, `receiving-code-review`,
`requesting-code-review`, `subagent-driven-development`,
`systematic-debugging`, `test-driven-development`, `using-git-worktrees`,
`using-superpowers`, `verification-before-completion`, `writing-plans`,
`writing-skills`. MIT licensed, copyright Jesse Vincent.

Not vendored: the plugin's `hooks/` (a SessionStart hook that auto-loads
skill docs at session start) — this repo already has its own SessionStart
hook (test DB setup) and adding a second one wasn't part of the ask. The
skills work standalone without it; the model just decides whether to invoke
them by description match, same as any other project skill.

Requested as `superpowers@claude-plugins-official` — that marketplace alias
wasn't resolved; vendored directly from the plugin's authoritative upstream
source (`obra/superpowers`) instead, which is the same underlying content.

## Installed via `npx skills@latest` (mattpocock/skills, MIT)

`grill-me` — installed at project scope via the real `skills` CLI
(`npx skills@latest add mattpocock/skills -s grill-me -a claude-code -y`),
which writes `skills-lock.json` at the repo root for future
`npx skills update` / `experimental_install`. MIT licensed, copyright Matt
Pocock. Note: the user's first attempt used `-g` (global, user-home-level)
install — that does not persist in this ephemeral remote environment, so it
was reinstalled at project scope instead so it's committed with the rest.
