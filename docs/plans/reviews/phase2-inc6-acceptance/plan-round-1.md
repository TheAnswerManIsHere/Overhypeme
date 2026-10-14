The approach serves the agreed outcome, and the scope remains coherent. Before approval, I would correct three evidence gaps: image decoding, the detector’s coverage, and live checks that can pass after a vendor fallback. These are technical questions; I found no need to reopen David’s settled product decisions.

The checkout is `076e7b5`, and the fixture manifest matches the oracle’s digest. Preserve the shared driver, terminal-state polling, explicit `not-run` outcomes, post-load prompt pins, untouched fixture files, and separate recording/live allowances.

**S1 — Substantially addressed; actual image decoding remains open. Resolve before approval.**

D2 covers the missing submission-to-queue assertion, free-user refusal, public permalink, moderation render reads, and incomplete-chain reporting. Its definition of “decodes,” however, does not establish readable pixels.

Sharp documents that `metadata()` reads image headers without decoding compressed pixels. [Sharp documentation](https://sharp.pixelplumbing.com/api-input/#metadata)

I reproduced the consequence using the installed dependency and committed `photo.jpg`, entirely in memory: truncating the 7,636-byte JPEG to 3,818 bytes still returned `{format: "jpeg", width: 640, height: 480}` from `metadata()`. A full pixel decode rejected it with `VipsJpeg: premature end of JPEG image`. MIME and aspect-ratio checks would not distinguish that damaged body.

Proposed replacement for D2’s definition:

> Every retrieved image must complete a pixel decode, for example `sharp(body).raw().toBuffer()`, as well as satisfy the MIME, dimensions and applicable aspect-ratio checks. Journey 7 additionally compares the returned bytes with the uploaded bytes.

Add a truncated-but-header-valid image to D10’s helper cases. This is a small correction to the planned helper, with direct value for the image-content gap assigned to this increment.

**S2 — The isolation approach is useful, but its observation boundary is incomplete. Resolve the mechanism before approval.**

D4’s stated rules observe IPv4 TCP outside loopback and IPv4 UDP destination port 53. They do not establish the claim that the detector observes everything the process tree attempts over IP:

- IPv6 connection attempts are outside the shown `iptables` rules. Without an IPv6 route, a request can fail before reaching either sink; application code can catch that failure.
- UDP traffic to other ports is outside both rules.
- The per-run hostname self-test can register solely through DNS. It does not establish that TCP interception works in that run.

The failure class is **a forbidden network attempt being prevented or failing, but remaining absent from the acceptance evidence**. That can produce green despite the oracle’s explicit requirement that caught outbound failures make the run fail. Preventing external effects and observing attempts remain separate obligations.

Keep the isolated process tree, but choose an observation mechanism that accounts for disallowed attempts—including failures before a packet reaches a sink. An external observer of socket system calls around that tree is one alternative worth probing; extending the packet mechanism is another only if it demonstrates equivalent coverage. This does not require changing production clients.

The decisive evidence should include permitted local HTTP and database access, plus caught forbidden hostname, literal IPv4 and literal IPv6 requests. Exercise each independently implemented observation path in the per-run self-test, and retain observation until the covered children exit.

I accept the supplied IPv4 probe as evidence for what it exercised. My attempted extension could not create the namespace (`uid_map: Operation not permitted`), so it produced no additional networking evidence; that is an environment limitation, not an application failure.

I would relax my earlier request that the CI execution itself precede approval: GitHub explicitly documents passwordless `sudo` on its Linux VMs, which reduces the privilege uncertainty. The corrected mechanism’s CI probe can remain the first implementation checkpoint, but it should exercise the database relay and permitted traffic as well as interception. [GitHub runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges)

**S3 — Storage scope is settled; live fallback detection still needs a concrete design. Resolve before approval.**

David’s choice of real AI over local storage addresses the former storage question. The disposable database, untouched fixture, Pexels-only meme read and independent allowance are appropriate.

D6 promises that application fallbacks leave missing live evidence. Reusing the recorder’s existing `uncoveredCalls()` does not establish that promise. There are concrete reachable gaps:

- The committed fixture sets `nsfw_classifier_fail_open=true`. A failure uploading the journey-7 photo to fal can therefore be caught and followed by a successful local upload and read-back. The [recorder’s storage-upload wrapper](/home/user/Overhypeme/artifacts/api-server/src/lib/aiDouble/recorder.ts:299) records only a successful upload; it writes neither a failed recording nor an allowance-ledger failure when that upload throws. The current uncovered-call scan consequently has nothing to find. The application’s continuation is explicit in [userImageUpload.ts](/home/user/Overhypeme/artifacts/api-server/src/lib/userImageUpload.ts:274).
- A successful SDK response need not establish successful consumption. The [classifier reader](/home/user/Overhypeme/artifacts/api-server/src/lib/moderation/nsfwClassifier.ts:84) substitutes zero when no recognised score exists. A changed response shape can therefore leave a successful recorder entry and a successful journey without proving the advertised classifier compatibility.

These examples bound the needed change: live coverage cannot be inferred solely from the absence of recorded vendor errors.

Extend D6 with a small map from each claimed live operation to its current-run evidence and usable result. Cover zero-cost operations such as fal uploads, require positive evidence where a journey can otherwise skip a vendor, and make missing or unusable results non-green. Reuse existing response readers where possible; this does not call for a general vendor-schema framework or changes to production fallback behaviour. Add a negative control showing that a swallowed upload failure cannot produce green.

There is also an existing reuse behaviour to account for explicitly. [The recorder](/home/user/Overhypeme/artifacts/api-server/src/lib/aiDouble/recorder.ts:254) replays requests already written during the same run. Both meme saves submit the same `preview.jpg`, so an initially empty scratch directory does not mean “every AI request reaches its vendor.” My recommendation is to disable recorder reuse in live mode while preserving `record --resume`. If same-run reuse is retained, describe and report it accurately, and tie its evidence to a successful current-run response.

For `--variant both`, keep one $5 allowance across the entire invocation. Sequential variants sharing the allowance ledger are the straightforward fit for the existing class; its per-process state is not a concurrent spending coordinator.

**Two bounded matters can be resolved during implementation.**

- **Preserve the promised browser check’s launch path.** D3 retains `e2e:storage` inside acceptance, but the current runner boots only the API. [photoUpload.spec.ts](/home/user/Overhypeme/artifacts/overhype-me/e2e/photoUpload.spec.ts:60) signs in through the frontend. Its invocation therefore needs the frontend and browser lifecycle, explicit local base URL, and coverage by the same environment and detector boundary. This is implementation work within D3’s stated promise; its execution should appear in verification.
- **Complete the whole DojoOS comparison.** D9 currently reasons about the launcher and detector. The oracle also names lane tags, acceptance workflow shape, readiness table, double-selection rule and test-database marker. Record the disposition of all six named handbook parts on #631, using links to existing contracts where appropriate. The three DojoOS-specific implementation deferrals can remain unchanged.

S1–S3 therefore remain open in the narrower forms above. The next useful revision is to make those evidence mechanisms concrete. The remaining scaffold and documentation work can proceed from the existing design once David approves the revised plan.