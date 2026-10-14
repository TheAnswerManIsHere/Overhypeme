This increment should exist, and its boundary is coherent. The repository has the underlying doubles, accounts, fixture loader, and much of the journey driver, but it does not yet provide the complete acceptance evidence promised here. Detailed planning can proceed without a scope split. The main questions for the plan are how external requests are detected and exactly what the live check exercises; I found no reason to reopen David’s settled decisions.

**S1 — Extend the existing driver, with an explicit completion contract. Resolve before approval.**

The [baseline driver](/home/user/Overhypeme/artifacts/api-server/scripts/drive-ai-baseline.ts:116) is the right foundation, but its current success result covers only journeys 3, 4, 6, and 7:

- Submission and onboarding happen inside journey 3. There is no explicit assertion that the submission appears in the moderation queue before moderation begins.
- Journey 5’s ordinary-free-account refusal is absent.
- Journey 3 checks the expected render cards’ terminal state, but never retrieves their images.
- Journey 4 retrieves the public image, but not the public permalink.
- Journeys 4 and 7 check image response status; journey 6 records a byte count. None establishes that the served body decodes as an image.

These are bounded additions to the existing driver. API-level execution remains consistent with the oracle. The photo-meme image route already resolves the saved upload and invokes the real compositor, so this does not require a second browser implementation merely to prove rendering.

The plan should map each required journey outcome to its assertion and evidence, then require results for journeys 2–7 in **both** database variants. An aborted chain must leave its remaining journeys visibly incomplete. The existing early-return mode for an expected render failure must not qualify as acceptance success.

For media, decode the served bodies; for journey 7, also compare the returned bytes with the uploaded fixture, since the upload path stores them verbatim. Include journey 3’s required render images in the same readable-image rule. Keep journey 6’s spend assertion explicitly Deferred to #651.

**S2 — Environment isolation and external-request detection need separate mechanisms. Resolve the design before approval.**

The [recorder launcher guard](/home/user/Overhypeme/artifacts/api-server/src/testing/aiRecorderGuard.ts:32) already provides a useful environment-allowlist pattern. The production-mode launcher currently refuses particular Resend variables, and [CI still constructs its launch by removing those variables](/home/user/Overhypeme/.github/workflows/build.yml:624). Extending constructed environments across the named journey launch paths is justified.

That does not establish the no-outbound property. Nor does the recorder’s missing-recording log: it observes calls crossing the AI double, whereas other reachable paths include Pexels, storage clients, and media downloads.

The plan should name the detection boundary, the permitted application/database endpoints, and which processes and lifecycle stages it covers. The decisive feasibility evidence is small: a forbidden request whose error is caught must still produce an independently observed, non-green run, while permitted local traffic works. Detection must remain active through background work and teardown.

This merits a targeted feasibility check for the chosen mechanism in CI and the container. It does not justify a general networking framework or changing production clients to report their own compliance. Credential isolation and preventing real effects must remain intact while that check runs.

**S3 — Reuse the recorder’s allowance and driver, but establish the live launch’s actual coverage. Resolve before approval.**

The current [recording runner](/home/user/Overhypeme/artifacts/api-server/scripts/record-ai-baseline.ts:268) forces local storage and passes only AI credentials. Its guard expressly requires that storage double. Consequently, renaming recording mode “live check” would leave real-storage behaviour untested.

There is also a concrete integration boundary: the [fixture loader](/home/user/Overhypeme/artifacts/api-server/scripts/load-legacy-fixture.ts:28) requires local storage and writes its placeholder media there. A live launch using real storage needs a deliberate handoff; changing the selector alone does not move those objects.

The plan should therefore identify:

- Which real provider operations demonstrate each live journey, including the agreed Pexels-only meme read.
- The marked test database and isolated storage location used on the Repl, with cleanup limited to that run’s resources.
- How fixture preparation and real-storage serving fit together without modifying the committed fixture.
- How the existing `Allowance` enforces the $5 cap across the run’s AI work, separately from recording spend.

No pre-existing recording should supply evidence claimed as a current vendor response. A missing credential, allowance refusal, or application fallback must remain visible as missing live evidence. Establish the required Repl resources during planning; if a required service cannot be exercised, the resulting shortfall belongs to David rather than being silently accepted.

**Keep the remaining work narrowly attached to those outcomes.**

The fixture manifest matches the supplied digest. The measured prompt mismatch and duplicate-judge diagnosis are adequate supplied evidence; there is no need to repeat that investigation merely for independence. Preserve the agreed post-load prompt pins, recording top-up, nine-meme gap, and prohibition on fixture refresh.

For uploaded evidence, specify a small report containing commit, fixture and recording identities, applied prompt pins, journey outcomes, external-request results, and explicit deferrals. The current runner prints evidence and deletes its scratch directory; persistent evidence on failure is therefore real work. Avoid uploading whole scratch directories containing captured mail or excluded safety material.

The product-neutral contracts also fit this increment. DojoOS’s [architecture document](/home/user/theanswermanishere/dojoos/docs/ai-context/architecture.md:16), which carries its approved design, confirms the web/worker split and media-processing requirements. That supports a portable launcher contract covering a set of processes, while leaving its actual two-process harness, media fixtures/probes, and voice/transcription doubles to DojoOS. It does not warrant building those facilities here. The final contract comparison and #631 record remain implementation deliverables; this preliminary read does not complete them.

My assessment rests on source inspection and the supplied replay measurements, not a new baseline or live-vendor execution. The evidence supports writing the detailed plan now, with S1–S3 addressed in it before David’s approval.