# GitHub Project v2 field/option names typed by hand need normalized matching, not exact string comparison

**What happened:** `scripts/sync-project-fields.mjs`'s `resolveOption()`
normalized option names from the start (case, emoji, hyphens,
parentheticals all stripped before comparing) — but `resolveField()` did an
exact-string match. The real project's `Waiting On` field (capital O,
typed by hand into the GitHub Projects UI) didn't match the script's
hardcoded `Waiting on`. The very first live run against the real board
failed all 9 workstream syncs with
`no single-select field named "Waiting on"`.

**Why it slipped through review:** the inconsistency was invisible until
real data hit it — the script's own tests used a hand-authored fixture
(`STATUS_FIELD`) that happened to match the code's assumed casing, so unit
tests passed while the live board never would have. Three rounds of Codex
review on the same file caught real bugs (a clearing gap, a pagination
gap, a concurrency gap) but none of it can catch a hardcoded string
disagreeing with a live UI-created name — that only surfaces by running
against the real board.

**The generalizable rule:** any code that references a name a human typed
into a GitHub Projects/Issues UI (a field name, a single-select option, a
label) should compare it normalized — never by exact string. A human-typed
name is not a stable identifier the way a node ID or a slug is.

**Reference:** `scripts/sync-project-fields.mjs`'s `resolveField`/
`resolveOption`. The bug shipped in PR #318, surfaced on its first live
`workflow_dispatch` run, fixed in PR #322.
