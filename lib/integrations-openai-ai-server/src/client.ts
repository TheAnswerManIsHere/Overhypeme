import OpenAI from "openai";

let _client: OpenAI | null = null;

/**
 * Shared OpenAI client.
 *
 * Prefers our own direct OpenAI key (`OPENAI_API_KEY` — the same key
 * `embeddings.ts` already uses for `/embeddings`, which the Replit proxy
 * doesn't support). Falls back to the Replit-connector vars
 * (`AI_INTEGRATIONS_OPENAI_API_KEY` + `AI_INTEGRATIONS_OPENAI_BASE_URL`) when
 * the direct key isn't set, so unsetting `OPENAI_API_KEY` reverts to the
 * proxy — the migration is reversible by env.
 */
export function getOpenAIClient(): OpenAI {
  if (_client) return _client;

  const directKey = process.env.OPENAI_API_KEY;
  if (directKey) {
    _client = new OpenAI({ apiKey: directKey });
    return _client;
  }

  const proxyKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const proxyBaseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (proxyKey && proxyBaseURL) {
    _client = new OpenAI({ apiKey: proxyKey, baseURL: proxyBaseURL });
    return _client;
  }

  throw new Error(
    "OPENAI_API_KEY (direct) must be set — or AI_INTEGRATIONS_OPENAI_API_KEY + " +
      "AI_INTEGRATIONS_OPENAI_BASE_URL for the legacy Replit connector fallback. " +
      "Did you forget to provision the OpenAI integration?",
  );
}
