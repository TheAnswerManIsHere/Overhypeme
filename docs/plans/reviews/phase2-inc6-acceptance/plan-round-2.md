The revised plan is close, but I would resolve two bounded technical issues before approval: the meme journeys still read an unrelated preview image, and the upload-failure control does not yet exercise the failure it claims to prove. Neither requires reopening David’s settled product decisions.

The checkout is `076e7b5`, and the fixture manifest matches the oracle. Preserve the terminal-state polling, explicit `not-run` outcomes, post-load prompt pins, untouched fixture files, and shared $5 allowance across both live variants.

**S1 — Full decoding is addressed; the identity of the decoded image remains a gap. Resolve before approval.**

Both meme journeys submit the committed `preview.jpg`: [journey 6](/home/user/Overhypeme/artifacts/api-server/scripts/drive-ai-baseline.ts:281) and [journey 4](/home/user/Overhypeme/artifacts/api-server/scripts/drive-ai-baseline.ts:321). On successful preview storage, [createMemeRecord](/home/user/Overhypeme/artifacts/api-server/src/lib/createMemeRecord.ts:381) sets `storedImageSource = null`. The [image-serving route](/home/user/Overhypeme/artifacts/api-server/src/routes/memes.ts:626) then serves that stored preview without reading the selected upload or generated background.

Consequently, D2’s proposed decoding can pass while:

- Journey 4 never composes the uploaded photo into the saved meme.
- Journey 6’s generated background is unreadable, but the unrelated preview remains readable.

The terminal `image_ready` state does not close the latter gap: [measureImage](/home/user/Overhypeme/artifacts/api-server/src/lib/imagePromptJobs.ts:637) reads headers and tolerates failure.

I retract my round-0 statement that this driver’s photo-meme read already invokes the compositor. That describes the recipe-serving branch; the driver’s supplied preview bypasses it.

The simplest correction is to use the existing recipe-save path for these journeys, omitting the unrelated `previewImageBase64`. The subsequent meme-image request then consumes the selected source. Journey 6 should also retrieve and decode its generated object through the ordinary owner-facing route, such as `/api/memes/ai-user/image?storagePath=…`.

Suggested replacement passage:

> Journeys 4 and 6 save recipes referencing the uploaded and generated objects respectively. Their served meme images must render successfully from those sources and complete a pixel decode. Journey 6 additionally reads and decodes the generated object as its owner. A fixed preview image cannot satisfy these assertions.

This is a driver correction using existing application paths. It also avoids making recording fingerprints depend on newly generated preview pixels. Update D6 accordingly: these recipe saves do not invoke the preview classifier; journey 7 still exercises fal upload and classification. Demonstrate that an unreadable selected source makes its journey fail even when `preview.jpg` remains valid.

**S3 — The positive-evidence design is substantially addressed; its negative control needs correction. Resolve before approval.**

Disabling recorder reuse, recording failed uploads, checking usable responses, and sharing the allowance across sequential variants address the main concerns from round 1.

The proposed `upload-failure` control, however, cannot establish the promised result as written:

- The existing [failure selector](/home/user/Overhypeme/artifacts/api-server/src/lib/aiDouble/doubles.ts:38) matches `kind:target`; `AI_DOUBLE_FAIL=fal.storage.upload` does not inject a failure.
- Correcting it to fail every storage upload would break moderation’s reference-image uploads before journey 7. [Reference resolution](/home/user/Overhypeme/artifacts/api-server/src/lib/defaultReferenceResolver.ts:118) crosses that same seam, and [scenario preparation](/home/user/Overhypeme/artifacts/api-server/src/lib/reviewRenderScenarios.ts:254) propagates an ordinary upload failure.
- The control runs in acceptance mode, whereas D6’s live decision requires recorder-ledger evidence. The plan needs to identify how the control exercises that same decision.

A red run caused by an earlier failed render would prove nothing about detecting a swallowed journey-7 failure.

Constrain the injected failure to the photo-upload operation, or run journey 7 as an isolated control over the fixture’s fail-open configuration. Require evidence that the upload and owner read-back completed, yet the **same coverage evaluator used by live mode** marked the required upload evidence missing. A credential-free test can feed that evaluator evidence from the controlled recorder/double execution; it need not run real vendors in CI.

During implementation, also make required operations variant-aware: the duplicate judge is required for the fixture case, while the [fresh-database path returns before that call when there are no neighbours](/home/user/Overhypeme/artifacts/api-server/src/routes/ai.ts:274). This must be an explicit expectation, rather than deriving required coverage from whichever calls happened.

**S2 — The revised observation design addresses the earlier mechanism gap. Execution remains an implementation checkpoint.**

The separate containment and observation mechanisms, four-attempt self-test, permitted-traffic probe, and observation through child shutdown now address caught failures that never reach the packet sink.

My small `strace` probe was refused by this CLI sandbox with `PTRACE_TRACEME: Operation not permitted`; it provided no additional execution evidence. That does not invalidate the supplied successful trace from Claude’s execution context. Keep the first implementation checkpoint exercising **namespace creation, tracing, all four attempts, local HTTP, and the database relay** in the actual container launcher and GitHub runner. Unsupported tracing must produce an environment failure, never reduced coverage or green.

**I1 and I2 remain addressed.**

Keeping the browser spec separately runnable through the constructed `--serve` environment is consistent with the oracle’s allowance for API acceptance journeys. I have no remaining objection to that choice. D9 now accounts for all six handbook-shaped parts.

The next useful revision is the source-dependent image assertion and the correctly targeted fallback control, with their consequences reflected in D6. The remaining work can stay within the existing scope; approval remains David’s.