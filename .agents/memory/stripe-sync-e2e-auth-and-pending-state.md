---
name: Stripe sync e2e CSRF and pending state
description: Durable test and UI expectations for the admin Stripe sync progress flow.
---

Authenticated browser requests in this app use a double-submit CSRF defense. A Playwright `context.request.post()` shares the session cookies but does not automatically convert the `csrf_token` cookie into the required `x-csrf-token` header; direct authenticated mutation requests must do that explicitly.

**Why:** The real UI POST succeeded while the test-only simulation POST returned 403, making the failure look like an admin-auth problem even though the session was valid.

**How to apply:** When an e2e test calls an authenticated mutation directly through `context.request`, read the CSRF cookie and send it as `x-csrf-token`.

During a sequential sync, the status API may legitimately report `idle` for resources that have not started yet because no persisted row exists. The UI must distinguish that in-progress state from an idle page with no historical sync and render it as `pending`.

**Why:** Treating every missing row as “never synced” made the progress panel contradict the active run and caused deterministic transition checks to fail.

**How to apply:** Derive the presentation state from both the persisted resource status and the overall `inProgress` flag; do not change the persisted status vocabulary merely to support the UI.