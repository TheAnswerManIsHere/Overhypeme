The plan still serves the verification-build outcome. **C6 is addressed. C5 now has the right admission rule, but its fal retry assumption needs one bounded correction before approval.** David still owns the allowance and plan approval. I found no other design blocker.

**C6 — Addressed**

D6 now specifies a separate process, an explicitly constructed environment, the test-database marker before application import, local temporary storage, and termination on either outcome. That resolves the recording path’s isolation gap without pulling increment 6’s general acceptance launcher into this increment.

The inspected paths support this approach: Stripe credentials come from environment variables; storage selects its backend per operation; baseline uploads and moderation reference images reach fal through `fal.storage.upload`. The marker-refusal and temporary-storage evidence specified in D6 remains appropriate implementation acceptance.

**C5 — Admission rule sound; correct the fal retry mechanism before approval**

Reserving before dispatch, including outstanding calls, refusing unknown prices, charging startup and application retries, and reporting incomplete coverage without resetting the allowance address the earlier overshoot mechanism.

However, **the locked fal SDK does not honour a client-level zero-retry setting for queue submissions**:

- This checkout locks `@fal-ai/client` to **1.9.5**.
- In that version, `subscribe()` calls `queue.submit()`. Submission supplies its own `maxRetries: 3`. [Client source](https://github.com/fal-ai/fal-js/blob/client-v1.9.5/libs/client/src/client.ts#L136), [queue source](https://github.com/fal-ai/fal-js/blob/client-v1.9.5/libs/client/src/queue.ts#L210)
- The request dispatcher merges those operation settings **after** the client configuration. Therefore `fal.config({ retry: { maxRetries: 0 } })` still permits the initial submission plus three retries. [Request dispatcher](https://github.com/fal-ai/fal-js/blob/client-v1.9.5/libs/client/src/request.ts#L45)

A retryable submission failure can therefore cause further vendor submissions underneath one recorder invocation. Reserving for one attempt would not establish D6’s promised ceiling. This is source inspection of the pinned version, not an executed SDK probe.

For this small recorder, I recommend conservatively reserving for fal’s bounded submission attempts rather than adding machinery solely to disable them. OpenAI can retain `maxRetries: 0`, which its SDK explicitly supports. [Official OpenAI documentation](https://developers.openai.com/api/reference/typescript#retries)

Suggested replacement for D6’s retry and settlement sentences, **not yet incorporated**:

> Startup calls and application retries draw on the same allowance. OpenAI automatic retries are disabled. For fal, the reservation covers up to four submission attempts per operation, matching the locked SDK’s initial attempt plus three retries; status and result polling are not additional generations. A reservation is reduced only where actual billable usage is established. Failed or timed-out operations with unknown usage retain their conservative reservation.

This preserves the local-counter design. It requires neither production spend-accounting changes nor a new service. Suppressing repeated submissions at the recorder’s transport boundary is also technically possible, but costs more implementation work than this bounded reservation.

**Resolve during implementation, before the paid run:** exercise the actual SDK with a fake transport returning retryable failures, and demonstrate that its submissions stay covered by the reservation. Also demonstrate refusal with concurrent outstanding calls and retention of reservations when usage is unavailable. These checks establish the spending invariant without vendor expenditure.

**David’s remaining decision**

The allowance remains unresolved. Present the frozen request inventory and its conservative reservations—including the chosen fal retry treatment—alongside the expected actual spend. The earlier “under $1” authorization does not establish a larger allowance.

C1–C3 remain addressed: the request fingerprints, application-owned adapters, and replay through real consumers are unchanged. C4 remains settled by David’s deferral to #651. After the bounded C5 correction, the next useful step is the allowance and approval handoff to David; another broad technical assessment is unnecessary.