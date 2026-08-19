---
name: git show / cat-file -e exit 128 for BOTH a missing path and a missing ref
description: A script shelling out to git cannot tell "the file isn't in that commit" from "that ref doesn't exist" by exit status alone; resolve the ref first, then ask about the path, or the actionable error branch is unreachable.
---

## Rule
`git cat-file -e <ref>:<path>` and `git show <ref>:<path>` **both exit 128**
when the path is missing from the tree *and* when the ref itself does not
exist. A script that branches on exit status alone collapses two different
answers into one. **Resolve the ref first** (`git rev-parse --verify <ref>`),
then ask about the path — only then can the caller distinguish
present / absent / cannot-tell.

## Why it matters — the failure is a vaguer error, so nobody notices
PR #503's guard checks whether an extension receipt is durably committed, and
reports one of three things: present, absent (**"commit and push it"** — the
actionable branch), or unknown (**"could not be established"** — a refusal with
no remedy). Because `gitContains` couldn't split the two 128s, it had to treat
every 128 as unknown, so **the actionable branch was unreachable** and every
uncommitted extension got the unhelpful message. Nothing errored; the guard
just never said the one useful thing it was written to say.

## How to hold it
Resolving the ref first splits the cases, and this is worth a test **against
real git rather than a fake** — the defect lives in the adapter, so a fake that
returns whatever the adapter expects cannot catch it going back. See
`scripts/review-budget.mjs`'s `gitShow` (which returns
present-with-contents / absent / unknown) and its real-git test.

## Related
A durability check should compare **contents**, not merely assert a path
exists — see the failure pattern *A "durable" or "committed" check that proves a
proxy, not the property* in
[`known-failure-patterns.md`](../../docs/ai-context/known-failure-patterns.md).
