---
name: A migration file already on main is byte-for-byte immutable
description: The migration runner tracks "already applied" by SHA-256 of the whole file — editing even a comment in an already-merged migration makes it replay.
---

# Editing an already-merged migration file — even a comment — makes it replay

`lib/db/src/migrate.ts`'s `applyMigrations()` decides whether a migration
already ran by hashing the **entire file content**
(`crypto.createHash("sha256").update(fs.readFileSync(path, "utf8"))`), not by
tag, filename, or journal index. Change one byte of an already-applied
migration — including a comment — and any database that already ran the old
hash sees an unrecognized, "pending" migration on its next `migrate()` call
and replays the whole file. Not idempotent by default: a replayed `INSERT`
duplicates an audit row, a replayed conditional `DELETE` can remove something
a later, legitimate action restored.

**Caught in PR #427 round 9 (Codex), after a docs-only round-8 fix edited a
comment inside `0099_admin_permissions_core.sql` — a different, already-merged
PR's migration that happened to be sitting in the diff.** Verified before
fixing: the edited file's hash matched zero rows in a real database's applied
set; the restored, byte-identical file's hash matched a row already there.

**Rule: a migration file on `main` is immutable, full stop** — no "just a
comment" exception, because the hash function has no concept of cosmetic vs.
substantive. Wrong comment, wrong behavior, whatever the reason: the fix is
always a **new** forward-only migration, or (for pure prose) editing a
different file that talks *about* the migration instead of the migration
itself.

**How to apply:** before editing anything under `lib/db/migrations/`, ask
whether it's the migration *this* change is introducing (safe — nothing has
run it yet) or someone else's already-merged one (never safe, regardless of
how small the edit looks). If in doubt whether a file has been applied
anywhere, treat it as applied. Full incident and reasoning:
[`known-failure-patterns.md`](../../docs/ai-context/known-failure-patterns.md#editing-an-already-merged-migration-file--even-a-comment--makes-the-hash-tracked-runner-replay-it);
working rule: [`migrations-and-backfills.md`](../../docs/engineering/migrations-and-backfills.md).
