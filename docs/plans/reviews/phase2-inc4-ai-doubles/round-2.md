The revised design serves the verification-build outcome. **C1–C3 are addressed**, and the recorder selector plus API driver is a sound approach. D6 still needs two bounded corrections before approval: isolate the recording process from the Repl’s other services, and make its spending limit enforceable. David’s journey 6 decision remains settled; no new product decision is needed unless the recording requires a larger allowance.

**What the revision resolves**

- **C1:** D4 now fingerprints the complete semantic request, includes corrective messages, limits normalization to evidenced transport differences, and explicitly excludes vision.
- **C2:** The application-owned OpenAI adapter and call-time fal facade preserve the existing package boundaries and credential-free replay.
- **C3:** D7 now requires the recorded chain, media and representative failure to pass through real consumers. That is meaningful evidence; implementation still must produce it.
- **C4:** The spend assertion’s deferral to #651 accurately reflects David’s decision.

**C6 — Define the recorder’s isolated launch environment. Resolve before approval.**

Production refusal is sound: the existing selector checks both production signals, and [bootChecks.ts](/home/user/Overhypeme/artifacts/api-server/src/lib/bootChecks.ts:43) executes before the application’s database graph. Requiring vendor keys for `recorder` also fits credential-free CI. I see no reason to replace that mechanism.

The gap is the development recording run. A worktree isolates code, and a marked database isolates database writes; neither isolates other services:

- Storage defaults to the real Replit bucket unless `STORAGE_BACKEND=local-double` is selected. See [objectStorage.ts](/home/user/Overhypeme/artifacts/api-server/src/lib/objectStorage.ts:43).
- The normal entrypoint performs Stripe verification before listening and starts further initialization afterward. With inherited credentials, that can reach Stripe independently of the driver’s chosen journeys. See [index.ts](/home/user/Overhypeme/artifacts/api-server/src/index.ts:256).
- Calling the normal entrypoint does not itself enforce the test-database marker. The existing [production-mode launcher](/home/user/Overhypeme/artifacts/api-server/src/testing/productionModeLauncher.ts:26) demonstrates the appropriate check-before-import pattern.

D6 introduces a real-app boot on the credential-bearing Repl, while explicitly leaving the allowlisted boot environment to increment 6. That leaves this new recording path underspecified.

Suggested addition to D6:

> Launch the recording server as a separate process with an explicitly constructed environment containing the required runtime settings and AI credentials only. Before importing the application, require the existing test-database marker. Select local object storage with a dedicated temporary directory and synthetic bucket paths, use the baseline fixture and a separate local port, and terminate the server on success or failure. Unrelated vendor credentials are not inherited. Recording mode is invoked explicitly outside CI; replay uses the same baseline without credentials.

This is a small launch contract for the recorder; increment 6 can still own the general acceptance launcher. During implementation, demonstrate marker refusal before application startup and storage writes landing in the temporary directory.

**C5 — The proposed estimate is not yet an enforced spending ceiling. Reopened; resolve the admission rule before approval.**

David’s spending authorization is settled. The remaining question is whether D6 implements its stated limit.

“Refuse the next call once the ceiling is reached” permits the current call—and concurrent calls already admitted—to cross it. The request inventory also does not establish that the complete recording fits:

- The [planner engine](/home/user/Overhypeme/artifacts/api-server/src/lib/engines/openai-visual-planner.ts:19) uses `gpt-5.5` with 2,800 configured output tokens. [openaiChatParams.ts](/home/user/Overhypeme/artifacts/api-server/src/lib/openaiChatParams.ts:26) adds 8,000 reasoning-token headroom.
- At the currently published $30 per million output tokens, four completions consuming that allowance could cost **$1.296 for output alone**, before input tokens, enrichment or images. This is a possible upper consumption, not a prediction of actual usage. [Official OpenAI pricing](https://developers.openai.com/api/docs/models/gpt-5.5)
- SDK retries also matter: the official TypeScript documentation specifies two automatic retries for eligible failures, including timeouts. Counting one wrapper invocation does not necessarily count one vendor attempt. [Official SDK documentation](https://developers.openai.com/api/reference/typescript#retries)

Suggested replacement direction:

> Freeze and price the baseline’s model settings and image parameters. Before dispatch, reserve the next operation’s conservative cost against the remaining $1 allowance, including outstanding calls. Refuse unknown prices or requests that exceed the remainder. Include startup calls and application retries in the same allowance; disable recorder-only SDK retries or account for every attempt. A budget refusal leaves the recording incomplete and reports the missing coverage; it never automatically restarts with a fresh allowance.

A recorder-local counter and bounded price table are sufficient. This does not require extending production spend accounting. Verify the prices, calculations and refusal behaviour during implementation before the paid run. If the complete baseline cannot fit, return that concrete result to David rather than increasing the allowance or weakening the baseline.

The API driver remains a useful choice: it captures requests produced by the application and can prove replay through the same orchestration. Its fresh replay run is still necessary—application-owned requests alone do not establish that changing database identities, stored configuration and uploaded URLs have been normalized correctly. D4 and D7 now assign that proof appropriately.