The approach serves the verification-build outcome. I favour **option A**, and D3’s local-media design is sound. Before approval, pin down the replay key and the OpenAI adapter’s ownership; both need only bounded revisions. David’s decisions about journey 6’s spend requirement and the recording spend remain open.

**A1 — Define what constitutes a recorded request. Resolve before approval.**

Replaying recorded content is proportionate for a fixed acceptance baseline. It preserves the real validators and avoids teaching a synthesiser how to manufacture valid enrichment and render plans.

I would change the justification, though: adapting a recorded exemplar does not inherently violate “shapes come from reality”—D3 already substitutes media URLs. The stronger reason against B is its obligation to maintain input-dependent semantic behaviour alongside the application’s validators.

A’s proposed key needs more precision:

- Enrichment and planning can send **two ordered user messages**, with a corrective instruction appended after validation fails. A key based on only the initial message cannot distinguish those requests. See [enrichment retry](/home/user/Overhypeme/artifacts/api-server/src/lib/factEnrichment.ts:259) and [planner retry](/home/user/Overhypeme/artifacts/api-server/src/lib/imagePrompt/generator.ts:784).
- Vision classification sends **content blocks containing an image URL**, rather than a text-only user message. That URL comes from an uploaded object whose path can vary between runs. See [vision request](/home/user/Overhypeme/artifacts/api-server/src/lib/sourceImageAnalysis/tier3AiVisionFallback.ts:61) and [upload URL construction](/home/user/Overhypeme/artifacts/api-server/src/routes/memes.ts:1721).
- The stated key omits the system prompt and schema definition, so “any prompt-template change changes the hash” is not established. The parent’s live-check triggers are launch stages and client-library upgrades; it does not already require a live check after every prompt edit.

Suggested replacement direction:

> Replay a bounded set of captured request/response pairs for fixed baseline inputs. Fingerprint the model, complete response format, and ordered messages, including stable system instructions and corrective messages. Normalize only identified transport differences. If a baseline uses vision, identify its fixture image independently of its changing URL; otherwise leave that operation explicitly unrecorded. Unmatched requests fail visibly. Record the fixture identity, account personalization, model configuration and render scenarios needed to reproduce the requests.

This does not require supporting arbitrary facts or every vision path. It requires choosing the baseline requests before designing their matching rules. Exact helper structure and serialization can remain implementation choices.

**A2 — Put selection in an application-owned client adapter. Resolve before approval.**

The existing shared OpenAI getter is in [the integration package](/home/user/Overhypeme/lib/integrations-openai-ai-server/src/client.ts:12), whereas `selectedBackend` and the proposed recordings live inside the API application. That package is a composite TypeScript project with `rootDir: "src"`; directly importing application modules into it would cross its build boundary. Its current cached-client return also precedes any credential check.

My recommendation is a small API-owned `getOpenAIClient()` adapter:

> The application adapter checks `selectedBackend("AI_BACKEND")`, returns the recorded double when selected, and otherwise delegates to the existing integration-package getter. Both `utilityLLM.ts` and `referenceResearch/openaiResponses.ts` import this adapter. The embeddings accessor uses the same selector before constructing its real client.

This keeps the existing real client and avoids moving the selector or creating another shared package.

For fal, explicitly describe the exported object as a forwarding facade whose supported methods resolve the backend when invoked. A conditional export evaluated during module initialization would not deliver D2’s call-time selection. Preserve the classifier’s injected-client seam and check selection before the credential gate.

The non-secret fal sentinel is reasonable: it lets the existing upload and meme-save gates exercise classification rather than silently skip it. The direct classifier import is indeed the runtime SDK-import exception that needs rerouting.

**D3 — Retain the local image design.**

I verified Node 22.22.0 fetching an embedded PNG: status 200, `image/png`, and identical returned bytes. The inspected consumers accept that URL directly: [image-job download](/home/user/Overhypeme/artifacts/api-server/src/lib/imagePromptJobs.ts:623) and [legacy image download](/home/user/Overhypeme/artifacts/api-server/src/lib/aiMemePipeline.ts:403). Their storage paths remain real.

For the inspected baseline-relevant upload consumers, fal-upload URLs are passed onward to providers rather than downloaded by application code. A deterministic placeholder URL is therefore sufficient there. No local HTTP media server is needed.

**A3 — Prove recordings through their consumers. Resolve during implementation; state the obligation in D7.**

A recorded envelope, provenance metadata and a double’s call record establish interception. They do not establish that the recorded chain satisfies the real validators or that a failure becomes an actionable application outcome.

Add bounded evidence that:

- Recorded tokenizer, enrichment, concept and planner responses pass through the real consumers for the selected baseline cases, with downstream requests finding their recordings.
- The committed PNG survives decoding, storage and serving.
- One recorded provider error travels through a real consumer and produces its expected error or job state, rather than merely being thrown by the double.

Journey 3’s full browser workflow can remain in increment 6. These checks establish that increment 4 supplies usable components without duplicating that workflow.

Also account for startup calls when implementing missing-recording behaviour. [Pricing initialization](/home/user/Overhypeme/artifacts/api-server/src/index.ts:100) walks the whole engine catalogue—including video and OpenAI model identifiers—and embedding backfill processes eligible active facts. Recordings for the baseline alone will not cover those populations. Explicit missing-recording failures are acceptable under the stated rule; they must never fall through to vendors. There is no need to invent successful responses merely to make startup quiet.

**David’s outstanding decisions remain consequential.**

The spend gap is confirmed: the Nano Banana worker in [imagePromptJobs.ts](/home/user/Overhypeme/artifacts/api-server/src/lib/imagePromptJobs.ts:299) contains neither `checkBudget` nor `recordCost`; the legacy FLUX/PuLID implementation contains both. A provider double cannot create genuine application spend attribution while leaving persistence real.

David must choose whether the missing production support is corrected as a prerequisite or the acceptance requirement is explicitly deferred. I recommend preserving the spend assertion and treating its production support as a prerequisite. Substituting legacy generation solely to obtain a ledger entry would not establish the live Nano Banana behaviour.

Recording expenditure also remains unapproved. The “under $1” figure is explicitly unverified; use the selected request inventory to establish the proposed run and spending limit before seeking that approval.

The checkout matches `d0a5444`, and the parent’s full digest matches the cited `db036f0f…`; its v3 heading is merely stale. The principal client inventory, 13 configuration calls, four structured-output schema names and startup hooks check out. D1’s claim that every AI journey needs all three clients is too broad—photo upload uses fal—but the single selector remains a sensible simplification.

The execution evidence here is limited to the Node fetch probe. Sharp was unavailable, so decoding and the proposed database/browser journeys remain implementation evidence to obtain, not demonstrated passes.