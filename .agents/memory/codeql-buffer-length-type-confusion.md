---
name: CodeQL type-confusion flags Buffer.length on request data even after Buffer.isBuffer
description: CodeQL's type-confusion rule still flags `.length` on a request-derived value that a `Buffer.isBuffer` check has narrowed; `.byteLength` passes.
---

# CodeQL flags `Buffer.length` on request data, even after `Buffer.isBuffer`

**What happened (PR #637, the local storage double).** CodeQL's
type-confusion-through-parameter-tampering rule flagged a `.length` read on a
request-derived value. A `Buffer.isBuffer` check ran right before the read.
The check narrows the type for TypeScript, but the query does not treat it as
a sanitiser.

**What passed:** reading `.byteLength` instead. For a `Buffer` it is the same
number. Prefer it over adding a suppression.

**Scope of the claim:** observed once, on that one alert in #637's review. It
is not a general statement about which CodeQL queries treat `Buffer.isBuffer`
as a sanitiser.
