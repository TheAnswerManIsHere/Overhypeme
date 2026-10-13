/**
 * The application's own access to its AI vendor clients (Launch Phase 2,
 * increment 4, #631; design D2, settled with Astra).
 *
 * Every OpenAI call in the server goes through `getOpenAIClient()` or
 * `getEmbeddingsClient()` here, and every fal call through the facade in
 * `./falClient.ts`, which uses `aiBackend()` below. Each resolves
 * `AI_BACKEND` **on every call and before any credential check**
 * (`./doubleSelection.ts`):
 *
 * - `vendors` (or unset) — the real clients: the shared integration-package
 *   getter for chat and responses, a direct client for embeddings.
 * - `recorded-double` — the replaying double (`./aiDouble/doubles.ts`); needs
 *   no credential.
 * - `recorder` — the real clients wrapped to capture recordings, under a
 *   spending allowance (`./aiDouble/recorder.ts`).
 *
 * The integration package stays unchanged: it is a composite project that
 * cannot import application modules, so the choice is made here.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import OpenAI from "openai";
import { getOpenAIClient as getVendorOpenAIClient } from "@workspace/integrations-openai-ai-server";

import { selectedBackend } from "./doubleSelection";
import { openaiDouble } from "./aiDouble/doubles";
import { Allowance, recordingOpenAI, type RecorderContext } from "./aiDouble/recorder";

export type AiBackend = "vendors" | "recorded-double" | "recorder";

export function aiBackend(env: NodeJS.ProcessEnv = process.env): AiBackend {
  return selectedBackend("AI_BACKEND", env) as AiBackend;
}

function packageVersion(name: string): string {
  const require = createRequire(import.meta.url);
  let dir = path.dirname(require.resolve(name));
  while (dir !== path.dirname(dir)) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (pkg.name === name && pkg.version) return pkg.version;
    }
    dir = path.dirname(dir);
  }
  return "unknown";
}

let recorderState: { allowance: Allowance; ctx: RecorderContext; openai: OpenAI } | null = null;

/** The recorder's shared allowance and client — one per process, so every call draws on one ceiling. */
export function recorder(): { allowance: Allowance; ctx: RecorderContext; openai: OpenAI } {
  if (recorderState) return recorderState;
  const allowance = new Allowance(Number(process.env.AI_RECORDER_ALLOWANCE_USD), process.env.AI_RECORDER_LEDGER || undefined);
  const ctx: RecorderContext = {
    clients: { "@fal-ai/client": packageVersion("@fal-ai/client"), openai: packageVersion("openai") },
  };
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY must be set for AI_BACKEND=recorder.");
  const openai = recordingOpenAI(new OpenAI({ apiKey, maxRetries: 0 }), allowance, ctx);
  recorderState = { allowance, ctx, openai };
  return recorderState;
}

/** The double or the recorder when one is selected, otherwise the vendor client `real` builds. */
function openaiFor(real: () => OpenAI): OpenAI {
  const backend = aiBackend();
  if (backend === "recorded-double") return openaiDouble();
  if (backend === "recorder") return recorder().openai;
  return real();
}

/** The client for chat completions and the Responses API. */
export function getOpenAIClient(): OpenAI {
  // The integration package resolves its own copy of `openai` (a different
  // zod peer), so the class identity differs while the surface is the same.
  return openaiFor(() => getVendorOpenAIClient() as unknown as OpenAI);
}

/** The client for embeddings (a direct OpenAI key; the Replit proxy has no /embeddings). */
export function getEmbeddingsClient(): OpenAI {
  return openaiFor(() => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    return new OpenAI({ apiKey });
  });
}
