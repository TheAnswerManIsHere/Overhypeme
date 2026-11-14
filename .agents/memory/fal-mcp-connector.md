---
name: fal.ai is drivable directly through its MCP connector
description: Claude sessions hold fal's hosted MCP server as a claude.ai connector — model search, schemas, pricing, uploads, and image/video generation — so AI image or video work can be tried against fal from the session, not only through the app.
---

**What exists** (David, 2026-11-08). fal's hosted MCP server,
`https://mcp.fal.ai/mcp-relay`, is connected as a **claude.ai custom
connector** on David's account, so it appears in cloud sessions as the
`mcp__Fal_ai__*` tools (deferred: load them with `ToolSearch`). It
signs in through OAuth in a browser, not with an API key, which is why it
lives in claude.ai's connector settings and **not in `.mcp.json`**: a project
entry would show as a server that cannot sign in in every cloud session, since
the container has no browser to complete the sign-in in. Verified on connection: `check_account_status`
returned `"status":"ready"` for `david@davidcarlos.net`, and `search_models`
for "nano banana" returned `google/nano-banana-2.1`,
`google/nano-banana-2.1/edit` and `fal-ai/nano-banana-pro/edit`.

**What it is for.** Whenever the work touches AI image or video
generation, fal is something I can drive directly:

- **Free reads**: `search_models`, `recommend_model`, `get_model_schema`
  (exact input parameters and accepted sizes for an endpoint), `get_pricing`,
  `estimate_cost`, `check_account_status`, `search_docs`. Use these to settle
  a question about an endpoint from the live catalogue rather than from
  memory or a guessed ID. The visual pipeline's engines are fal endpoints
  (`docs/ai-context/visual-pipeline.md`, *Which engine draws a render*).
- **Paid calls**: `run_model`, `submit_job` / `submit_jobs`. A
  generation through the connector is a **paid AI run** like any other, and
  it falls under the $5-per-run and $25-per-week fleet budget and the
  `paid-ai-ledger` comment (`docs/tests/uat-doc-format.md`, the paragraph
  beginning *"A paid AI run proceeds within David's budget"*). Price it with
  `estimate_cost` first, and never run it in a loop.

**Gotchas.**

- **Connectors load when a session starts.** A session that began before the
  connector was added does not have it. Starting a new session fixes that.
  (On the day it was added, the tools did appear mid-session, but don't
  rely on that.)
- **Billing goes to fal's "Active MCP account"**, chosen at
  fal.ai/dashboard/ai-tools, not to whichever key the app uses. unable to
  verify: whether that is the same fal account as the app's key (`FAL_AI_API_KEY`,
  falling back to `FAL_KEY`: `artifacts/api-server/src/lib/falClient.ts`);
  comparing the two in fal's dashboard would settle it.
- **A connector generation does not go through the product.** It skips the
  app's planner, compiler, moderation and render-budget gate. So it can
  answer "what does this endpoint do with this input" and nothing about
  "what does Overhype.me produce". A result from it is never evidence for a
  product check, which runs through the app.
- **`run_model` returning `processing` is normal for video.** Poll `check_job`
  with the returned `request_id`. Calling `run_model` again starts a second
  billable job.
