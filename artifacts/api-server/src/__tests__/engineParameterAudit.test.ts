/**
 * The parameter audit (plan docs/plans/PLAN_AI_SETTINGS_IN_CODE.md, design 6;
 * David, 2026-11-14: "if something doesn't support temperature, we're not
 * trying to send a temperature setting").
 *
 * Every request an engine can be sent is built here exactly as production and
 * the Eval page build it, and checked against what the vendor accepts, as read
 * on 2026-11-14:
 *   - fal endpoints: each one's published input schema, read through the fal
 *     connector's free schema tool (`get_model_schema`), recorded below;
 *   - OpenAI chat models: the GPT-6 guide ("When reasoning effort is not none,
 *     remove temperature, top_p, and top_logprobs"; "GPT-6 Astra and GPT-6.1
 *     Sol do not support the none reasoning effort; GPT-6.1 Terra, GPT-6 Sol,
 *     and GPT-6 Luna do") and the reasoning guide (gpt-5.x take
 *     max_completion_tokens and reasoning_effort, not temperature).
 *
 * A test fails when a request carries a parameter or a value the audit did not
 * record as accepted. Adding an engine or a parameter means auditing it first.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ALL_ENGINES } from "../lib/engines/catalogue.js";
import { toEngineRecord } from "../lib/engines/engineRecord.js";
import { buildEngineInput } from "../lib/engineInterpreter.js";
import { buildImageRequestSettings } from "../lib/imageRequestBuilder.js";
import { imageEngineParams } from "../lib/imageEngineRequest.js";
import { chatModelTuningParams } from "../lib/openaiChatParams.js";
import { JUDGEMENT_REASONING_EFFORT, UTILITY_LLM_ENGINE_ID } from "../lib/utilityLLM.js";
import { TOKENIZER_MODEL, TOKENIZER_REASONING_EFFORT } from "../lib/factTokenizer.js";

type Accepts = Record<string, (v: unknown) => boolean>;
const oneOf = (...xs: unknown[]) => (v: unknown) => xs.includes(v);
const str = (v: unknown) => typeof v === "string" && v.length > 0;
const urls = (v: unknown) => Array.isArray(v) && v.every((u) => typeof u === "string");
const bool = (v: unknown) => typeof v === "boolean";
const intIn = (lo: number, hi: number) => (v: unknown) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
/** An {width,height} size within the endpoint's published bounds. */
const size = (minPx: number, maxPx: number, mult = 1, maxEdge = Infinity) => (v: unknown) => {
  const s = v as { width?: number; height?: number };
  if (!s || !Number.isInteger(s.width) || !Number.isInteger(s.height)) return false;
  const w = s.width!, h = s.height!;
  return w * h >= minPx && w * h <= maxPx && w % mult === 0 && h % mult === 0 && Math.max(w, h) <= maxEdge;
};

const NANO_ASPECTS = ["auto", "21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16", "4:1", "1:4", "8:1", "1:8"];
const NANO_COMMON: Accepts = {
  prompt: str,
  aspect_ratio: oneOf(...NANO_ASPECTS),
  num_images: intIn(1, 4),
  output_format: oneOf("jpeg", "png", "webp"),
  safety_tolerance: oneOf("1", "2", "3", "4", "5", "6"),
  limit_generations: bool,
  enable_web_search: bool,
};
const GPT_IMAGE: Accepts = {
  prompt: str,
  image_size: size(655_360, 8_294_400, 16, 3840),
  quality: oneOf("auto", "low", "medium", "high", "xhigh", "max"),
  output_format: oneOf("jpeg", "png", "webp"),
  num_images: intIn(1, 10),
};
const FLUX3: Accepts = {
  prompt: str,
  aspect_ratio: oneOf("auto", "21:9", "2:1", "16:9", "3:2", "7:5", "4:3", "5:4", "1:1", "4:5", "3:4", "5:7", "2:3", "9:16", "1:2"),
  resolution: oneOf("768sq", "1k", "1.5k", "2k", "4k"),
  output_format: oneOf("jpeg", "png"),
  safety_tolerance: intIn(0, 4),
  enable_prompt_expansion: bool,
};
const SEEDREAM: Accepts = {
  prompt: str,
  image_size: size(921_600, 4_624_220),
  num_images: intIn(1, 6),
  output_format: oneOf("jpeg", "png"),
  enhance_prompt_mode: oneOf("standard", "fast"),
};
const MUSE: Accepts = {
  prompt: str,
  aspect_ratio: (v) => typeof v === "string" && /^[1-9][0-9]{0,4}:[1-9][0-9]{0,4}$/.test(v),
  num_images: intIn(1, 10),
  output_format: oneOf("jpeg", "png", "webp"),
};

/** Accepted input per fal endpoint, from its published schema (2026-11-14). */
const FAL_AUDIT: Record<string, Accepts> = {
  "fal-ai/nano-banana-2": { ...NANO_COMMON, resolution: oneOf("0.5K", "1K", "2K", "4K") },
  "fal-ai/nano-banana-2/edit": { ...NANO_COMMON, resolution: oneOf("0.5K", "1K", "2K", "4K"), image_urls: urls },
  "google/nano-banana-2.1": { ...NANO_COMMON, resolution: oneOf("1K", "2K", "4K"), thinking_level: oneOf("minimal", "medium", "high") },
  "google/nano-banana-2.1/edit": { ...NANO_COMMON, resolution: oneOf("1K", "2K", "4K"), thinking_level: oneOf("minimal", "medium", "high"), image_urls: urls },
  "openai/gpt-image-2.5/sunburst/text-to-image": GPT_IMAGE,
  "openai/gpt-image-2.5/sunburst/edit": { ...GPT_IMAGE, image_urls: urls },
  "openai/gpt-image-2.6/sunburst/text-to-image": { ...GPT_IMAGE, reasoning_effort: oneOf("low", "medium", "high") },
  "openai/gpt-image-2.6/sunburst/edit": { ...GPT_IMAGE, reasoning_effort: oneOf("low", "medium", "high"), image_urls: urls },
  "blackforestlabs/flux-3/text-to-image": FLUX3,
  "blackforestlabs/flux-3/edit-image": { ...FLUX3, image_urls: urls },
  "bytedance/seedream/v5/pro/text-to-image": SEEDREAM,
  "bytedance/seedream/v5/pro/edit": { ...SEEDREAM, image_urls: urls },
  "meta/muse-image/text-to-image": MUSE,
  "meta/muse-image/edit": { ...MUSE, image_urls: urls },
};

describe("every dispatchable image engine sends only what its endpoint accepts", () => {
  const dispatchable = ALL_ENGINES.filter((d) => d.kind === "image" && d.sizeVocabulary);

  it("every dispatchable image engine was audited", () => {
    const missing = dispatchable.map((d) => d.endpointId).filter((e) => !FAL_AUDIT[e]);
    assert.deepEqual(missing, [], "audit the endpoint's published schema before adding it");
  });

  for (const def of dispatchable) {
    it(`${def.id} (${def.endpointId})`, () => {
      const accepts = FAL_AUDIT[def.endpointId]!;
      const row = toEngineRecord(def) as never;
      let built = 0;
      for (const purpose of ["preview", "comparison", "final"] as const) {
        for (const aspect of ["landscape", "square", "portrait"]) {
          let settings;
          try { settings = buildImageRequestSettings(row, purpose, aspect); } catch { continue; }
          const input = buildEngineInput(row, imageEngineParams(settings, {
            generationMode: def.imageMode!, promptText: "a picture", aspectRatio: aspect, referenceImageUrl: "https://example.test/ref.jpg",
          }));
          built++;
          for (const [name, value] of Object.entries(input)) {
            const ok = accepts[name];
            assert.ok(ok, `${def.id}: sends "${name}", which ${def.endpointId} does not accept`);
            assert.ok(ok(value), `${def.id}: sends ${name}=${JSON.stringify(value)} (${purpose}, ${aspect}), outside what ${def.endpointId} accepts`);
          }
        }
      }
      assert.ok(built > 0, `${def.id}: no request could be built`);
    });
  }
});

/** Reasoning efforts each OpenAI chat model accepts (OpenAI guides, 2026-11-14). */
const OPENAI_EFFORTS: Record<string, string[]> = {
  "gpt-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.5": ["none", "low", "medium", "high"],
  "gpt-5.4-mini": ["none", "low", "medium", "high"],
};

describe("every OpenAI chat call sends only what its model accepts", () => {
  const calls: Array<{ label: string; model: string; effort: string | undefined; temperature: number | null }> = [
    ...ALL_ENGINES.filter((d) => d.provider === "openai" && d.kind === "llm").map((d) => ({
      label: d.id, model: d.endpointId, effort: d.defaultReasoningEffort ?? undefined, temperature: d.defaultTemperature ?? null,
    })),
    { label: `${UTILITY_LLM_ENGINE_ID} at the judgement effort`, model: ALL_ENGINES.find((d) => d.id === UTILITY_LLM_ENGINE_ID)!.endpointId, effort: JUDGEMENT_REASONING_EFFORT, temperature: 0.2 },
    { label: "the tokenizer", model: TOKENIZER_MODEL, effort: TOKENIZER_REASONING_EFFORT, temperature: 0 },
  ];

  for (const c of calls) {
    it(c.label, () => {
      const efforts = OPENAI_EFFORTS[c.model];
      assert.ok(efforts, `${c.model} has not been audited`);
      const params = chatModelTuningParams({ model: c.model, maxTokens: 100, temperature: c.temperature ?? 0.5, reasoningEffort: c.effort }) as Record<string, unknown>;
      assert.equal(params["max_tokens"], undefined, "reasoning models take max_completion_tokens");
      if (params["reasoning_effort"] !== undefined) {
        assert.ok(efforts.includes(String(params["reasoning_effort"])), `${c.model} does not accept reasoning_effort=${String(params["reasoning_effort"])}`);
      }
      const temperatureAllowed = /^gpt-6/.test(c.model) && params["reasoning_effort"] === "none";
      assert.equal("temperature" in params, temperatureAllowed, `${c.model} at effort ${String(params["reasoning_effort"])}: temperature ${temperatureAllowed ? "should" : "must not"} be sent`);
    });
  }

  it("the code holds no temperature it never sends", () => {
    for (const d of ALL_ENGINES.filter((e) => e.provider === "openai" && e.kind === "llm")) {
      const sendsTemperature = /^gpt-6/.test(d.endpointId) && d.defaultReasoningEffort === "none";
      if (!sendsTemperature) assert.equal(d.defaultTemperature ?? null, null, `${d.id} declares a temperature that is never sent`);
    }
  });
});
