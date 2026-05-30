---
name: OpenAI must call directly, never the Replit AI proxy
description: This project must use the direct OpenAI API key, not the Replit AI Integration proxy.
---

All OpenAI usage (chat/utility LLM via `getOpenAIClient`, and embeddings) must call
the OpenAI API directly with `OPENAI_API_KEY`. Do NOT add a fallback to the Replit
AI Integration proxy (`AI_INTEGRATIONS_OPENAI_*`).

**Why:** The Replit OpenAI proxy does not support the `/embeddings` endpoint, and the
product owner explicitly wants everything going straight to OpenAI with our own key.
A previous "reversible by env" proxy fallback in `getOpenAIClient()` was confusing and
was removed. The `AI_INTEGRATIONS_OPENAI_*` secrets may still exist in the environment
but must remain unreferenced by code.

**How to apply:** If `getOpenAIClient()` (lib/integrations-openai-ai-server) or any new
LLM caller is touched, keep it direct-key-only and throw if `OPENAI_API_KEY` is unset.
