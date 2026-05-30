import OpenAI from "openai";

let _client: OpenAI | null = null;

/**
 * Shared OpenAI client.
 *
 * Uses our own direct OpenAI key (`OPENAI_API_KEY` — the same key
 * `embeddings.ts` uses for `/embeddings`). All calls go straight to the OpenAI
 * API; there is no Replit-proxy fallback.
 */
export function getOpenAIClient(): OpenAI {
  if (_client) return _client;

  const directKey = process.env.OPENAI_API_KEY;
  if (!directKey) {
    throw new Error("OPENAI_API_KEY must be set to call the OpenAI API.");
  }

  _client = new OpenAI({ apiKey: directKey });
  return _client;
}
