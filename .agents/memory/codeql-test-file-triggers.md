---
name: Two CodeQL alerts a test file trips — a bare cookie-parsing app and a URL in `includes`
description: A route test that builds a bare Express app with cookieParser() trips js/missing-token-validation (CSRF); a test that checks a URL with array.includes(url) or text.includes(url) trips js/incomplete-url-substring-sanitization. Run cookie cases through createApp(), and match a URL with an anchored regex.
---

# Two CodeQL alerts a test file trips

Both came up in launch Phase 5 (#795) and both were cleared by changing the
test, not by dismissing the alert.

1. **A bare route-test app with `cookieParser()` trips CodeQL's missing-CSRF
   rule** (`js/missing-token-validation`). When cookie behaviour matters, run
   the case through `createApp()`, which has the real Origin check and
   double-submit CSRF, as `passwordHardening.test.ts` does (PR #798 — Launch
   Phase 5, Increment 2). A Bearer request skips the CSRF check by design. The
   production-side version of this alert is
   [`codeql-missing-rate-limiting-csrf-false-positive.md`](codeql-missing-rate-limiting-csrf-false-positive.md).
2. **"Incomplete URL substring sanitization" fires on `includes(url)` in a
   test** (`js/incomplete-url-substring-sanitization`), on an array or a string
   alike. The shape it accepts is an anchored regex:
   `assert.match(text, /^https:\/\/example\.test\/path$/m)` (PR #833 — Launch
   Phase 5, Increment 5b).
