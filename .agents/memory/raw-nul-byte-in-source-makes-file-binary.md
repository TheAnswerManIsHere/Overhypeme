---
name: A raw NUL byte in a TS/JS source file makes Git (and grep) treat the whole file as binary
description: Why using a literal `\x00` character as a string delimiter in source silently breaks diffing, review, and text search for that file.
---

# A raw NUL byte in source code makes Git treat the file as binary

A template literal like `` `${a}\0${b}` `` written with an *actual* NUL byte
character embedded in the source (as opposed to the two-character escape
sequence `\0`) is valid, working JavaScript — `\0` and a literal NUL byte
produce the identical runtime string. But Git's binary-file heuristic looks
for a NUL byte anywhere in the file's raw bytes, and a text editor or an
agent's file-read tool can insert one this way without anyone noticing,
because the *rendered* string in most viewers looks like a space or is
otherwise invisible.

**Dangerous:** once a source file contains a real NUL byte, `git diff`
reports `Binary files a/... and b/... differ` instead of a line-level diff —
so every future PR touching that file gets reviewed blind, and `grep`/`rg`
report "binary file matches" instead of showing the matching line. For a
security-sensitive file (a permission resolver, an auth module), this is
worse than an ordinary hygiene nit: it defeats line-level code review on
exactly the file that most needs it, and the defect can sit unnoticed for a
long time because nothing about the *runtime behavior* is wrong — only
tooling that inspects the file as text is affected.

**Avoid:** never embed a literal NUL byte in source as a delimiter,
separator, or sentinel — always use its escape sequence, `\0`. This is
specifically about NUL: an ordinary embedded newline in a multi-line
template literal is completely normal, intentional, and line-diffable —
Git's binary heuristic triggers on a NUL byte specifically, not on control
characters in general, so this is not a reason to avoid real multi-line
strings. If a file unexpectedly shows as binary in `git diff` or `grep`,
check for embedded NUL bytes before assuming corruption:
`python3 -c "print(open(path,'rb').read().count(b'\x00'))"` finds them
directly; the fix is a plain text search-and-replace of the raw byte with
its escaped form, which produces byte-for-byte-different-but-semantically-
identical output and needs no runtime behavior verification beyond a
regression test confirming the delimited value still round-trips.

**Overhype:** `featureAccess.ts`'s `principalFingerprint()` used two literal
NUL bytes as field separators in its hash-input template literal (`` `${userId}\x00${tier}\x00${isAdmin}` `` with real embedded bytes, not the
`\0` escape) — found by Codex review on PR #425 round 6, on the exact file
the permission-chokepoint architecture calls "the chokepoint." Fixed by
switching to the escaped `\0` form; `featureAccess.integration.test.ts`
still passed 23/23 unchanged, confirming the runtime hash was never
affected — only the file's diffability was.
