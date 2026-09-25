---
name: issue_write with method "update" silently drops an add_comment payload -- the call reports success and returns the ISSUE's id where a comment id should be
description: Use add_issue_comment to post a comment; never pass a comment body to issue_write update. Verify a posted comment by reading it back, because the success response cannot be told from a real one by its status alone.
---

<!-- SYNCED FROM AI-Handbook — do not edit in a consumer repo. Local edits are overwritten by the next sync and their reasoning is lost; change the handbook instead. -->

# A comment that was never posted, reported as posted

## What happened

Two handoff comments were written onto issue #9 by calling `issue_write` with
`method: "update"` and an `add_comment` payload alongside the body edit. The
body edit landed. The comments did not. The call **reported success**, and
that success was taken as proof.

For about thirty minutes the issue body said "detail in the handoff comment
below" and pointed at two comments that did not exist — the exact drift the
State of Play block exists to prevent, introduced by the mechanism meant to
maintain it. The next session read the body, went looking, and found nothing.

## The tell, and why it is easy to read past

The response returned **the issue's own id** (`5343828954`). A real comment
returns *its own* id and an `#issuecomment-<id>` URL.

That is the whole signal. There is no error, no warning, and no field saying
the comment was dropped — a success response with a plausible-looking numeric
id in it. Nothing about the shape announces that half the request was ignored,
which is why reading past it is the default outcome rather than a lapse.

## The rule

**Post comments with `add_issue_comment`. `issue_write` updates the issue.**
One tool, one object. A comment body handed to the update path is not a
partially-supported option; it is discarded.

**And verify by reading back, not by trusting the status.** This is the
general form and the part worth keeping: a success response proves the call
was accepted, never that every field in it was honoured. Where a call has two
effects, confirm the one you cannot see. Reading the comment back costs one
call and is the only thing that would have caught this.

## Why this is a memory entry and not a contract line

It is a property of one tool, discoverable only by having been bitten. A rule
in the contract would be read by every session and needed by the rare one that
reaches for the update path with a comment in hand; an entry here is found by
the session that goes looking after a comment fails to appear, which is when
it is useful.
