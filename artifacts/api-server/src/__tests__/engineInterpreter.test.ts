import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEngineInput,
  MissingRequiredParamError,
  UnknownParamTypeError,
  type ParamSchema,
} from "../lib/engineInterpreter.js";
import type { Engine } from "@workspace/db/schema";

// ────────────────────────────────────────────────────────────────────────────
// Helpers: synthesize Engine rows whose paramSchema mirrors migration 0057.
// We only fill the fields buildEngineInput actually reads (id + paramSchema);
// the rest is cast through Engine so the type checker is happy.
// ────────────────────────────────────────────────────────────────────────────

function makeEngine(id: string, paramSchema: ParamSchema, audioHandling = "none"): Engine {
  return {
    id,
    paramSchema: paramSchema as unknown,
    audioHandling,
    // The interpreter never reads these; fill with type-safe nullish defaults.
    provider: "test",
    endpointId: `test/${id}`,
    label: id,
    description: "",
    kind: "video",
    tierRequirement: "legendary",
    isDefault: false,
    isActive: true,
    sortOrder: 0,
    allowedDurationsSec: null,
    defaultDurationSec: null,
    allowedResolutions: null,
    defaultResolution: null,
    allowedAspectRatios: null,
    defaultAspectRatio: null,
    supportedModes: null,
    defaultMode: null,
    estimatedCostUsdPerCall: null,
    estimatedCostUsdPerSecond: null,
    expectedRunMs: 30000,
    featureFlagRequired: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Engine;
}

const VEO_LITE: ParamSchema = {
  params: [
    { name: "image_url",    from: "imageUrl",     type: "string", required: true },
    { name: "prompt",       from: "motionPrompt", type: "string", required: true },
    { name: "duration",     from: "durationSec",  type: "int",    default: 6 },
    { name: "aspect_ratio", from: "aspectRatio",  type: "string", map: { landscape: "16:9", square: "1:1", portrait: "9:16" } },
    { name: "resolution",   from: "resolution",   type: "string", default: "720p" },
    { name: "generate_audio", from: "generateAudio", type: "boolean", default: true },
  ],
};

const VEO_FAST: ParamSchema = VEO_LITE; // identical shape

const KLING: ParamSchema = {
  params: [
    { name: "image_url",       from: "imageUrl",       type: "string",    required: true },
    { name: "prompt",          from: "motionPrompt",   type: "string",    required: true },
    { name: "duration",        from: "durationSec",    type: "stringInt", default: "5" },
    { name: "aspect_ratio",    from: "aspectRatio",    type: "string",    map: { landscape: "16:9", square: "1:1", portrait: "9:16" } },
    { name: "negative_prompt", from: "negativePrompt", type: "string",    default: "blur, distort, low quality" },
    { name: "voice_text",      from: "dialogueText",   type: "string" },
  ],
};

const SEEDANCE: ParamSchema = {
  params: [
    { name: "image_url",      from: "imageUrl",      type: "string", required: true },
    { name: "prompt",         from: "motionPrompt",  type: "string", required: true },
    { name: "duration",       from: "durationSec",   type: "int",    default: 6 },
    { name: "aspect_ratio",   from: "aspectRatio",   type: "string", map: { landscape: "16:9", square: "1:1", portrait: "9:16" } },
    { name: "resolution",     from: "resolution",    type: "string", default: "720p" },
    { name: "generate_audio", from: "generateAudio", type: "boolean", default: true },
    { name: "end_user_id",    from: "endUserId",     type: "string", required: true },
  ],
};

const GROK: ParamSchema = {
  params: [
    { name: "image_url",    from: "imageUrl",     type: "string", required: true },
    { name: "prompt",       from: "motionPrompt", type: "string", required: true },
    { name: "duration",     from: "durationSec",  type: "int",    default: 6 },
    { name: "aspect_ratio", from: "aspectRatio",  type: "string", map: { landscape: "16:9", square: "1:1", portrait: "9:16" } },
    { name: "resolution",   from: "resolution",   type: "string", default: "480p" },
    { name: "mode",         from: "mode",         type: "string", default: "normal" },
  ],
};

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("buildEngineInput — per-engine seeded shapes", () => {
  const fullParams = {
    imageUrl: "https://cdn.example/img.jpg",
    motionPrompt: "Slow cinematic zoom",
    durationSec: 6,
    aspectRatio: "landscape",
    resolution: "720p",
    generateAudio: true,
    endUserId: "user_abc",
  };

  it("Veo Lite — maps the full set with aspect substitution", () => {
    const engine = makeEngine("veo-3.1-lite", VEO_LITE);
    const input = buildEngineInput(engine, fullParams);
    assert.deepEqual(input, {
      image_url: "https://cdn.example/img.jpg",
      prompt: "Slow cinematic zoom",
      duration: 6,
      aspect_ratio: "16:9",
      resolution: "720p",
      generate_audio: true,
    });
  });

  it("Veo Fast — same shape as Lite", () => {
    const engine = makeEngine("veo-3.1-fast", VEO_FAST);
    const input = buildEngineInput(engine, { ...fullParams, resolution: "1080p" });
    assert.equal(input.resolution, "1080p");
    assert.equal(input.aspect_ratio, "16:9");
    assert.equal(typeof input.duration, "number");
  });

  it("Kling — duration coerces to string", () => {
    const engine = makeEngine("kling-v3-standard", KLING);
    const input = buildEngineInput(engine, {
      ...fullParams,
      durationSec: 5,
      dialogueText: "Hello world",
    });
    assert.equal(input.duration, "5");
    assert.equal(typeof input.duration, "string");
    assert.equal(input.voice_text, "Hello world");
    assert.equal(input.aspect_ratio, "16:9");
    // Default negative_prompt applied
    assert.equal(input.negative_prompt, "blur, distort, low quality");
  });

  it("Kling — omits voice_text when no dialogueText supplied", () => {
    const engine = makeEngine("kling-v3-standard", KLING);
    const input = buildEngineInput(engine, fullParams);
    assert.ok(!("voice_text" in input), "voice_text should be omitted when optional + empty");
  });

  it("Seedance — includes end_user_id and aspect mapping", () => {
    const engine = makeEngine("seedance-2.0-fast", SEEDANCE);
    const input = buildEngineInput(engine, fullParams);
    assert.equal(input.end_user_id, "user_abc");
    assert.equal(input.aspect_ratio, "16:9");
    assert.equal(input.generate_audio, true);
  });

  it("Grok — applies mode default when omitted", () => {
    const engine = makeEngine("grok-imagine", GROK);
    const input = buildEngineInput(engine, fullParams);
    assert.equal(input.mode, "normal");
    assert.equal(input.resolution, "720p"); // overridden by fullParams.resolution
  });

  it("Grok — uses default resolution when not provided", () => {
    const engine = makeEngine("grok-imagine", GROK);
    const input = buildEngineInput(engine, { ...fullParams, resolution: undefined });
    assert.equal(input.resolution, "480p");
  });
});

describe("buildEngineInput — required params", () => {
  it("throws MissingRequiredParamError when required value missing", () => {
    const engine = makeEngine("veo-3.1-lite", VEO_LITE);
    assert.throws(
      () => buildEngineInput(engine, { motionPrompt: "x" } as Record<string, unknown>),
      (err) =>
        err instanceof MissingRequiredParamError &&
        err.paramName === "image_url" &&
        err.fromKey === "imageUrl",
    );
  });

  it("throws when required value is empty string", () => {
    const engine = makeEngine("veo-3.1-lite", VEO_LITE);
    assert.throws(
      () =>
        buildEngineInput(engine, {
          imageUrl: "",
          motionPrompt: "x",
        }),
      MissingRequiredParamError,
    );
  });

  it("throws when required value is null", () => {
    const engine = makeEngine("seedance-2.0-fast", SEEDANCE);
    assert.throws(
      () =>
        buildEngineInput(engine, {
          imageUrl: "https://x/y",
          motionPrompt: "x",
          endUserId: null,
        }),
      (err) =>
        err instanceof MissingRequiredParamError && err.paramName === "end_user_id",
    );
  });
});

describe("buildEngineInput — defaults", () => {
  it("applies default when pipeline value omitted", () => {
    const engine = makeEngine("veo-3.1-lite", VEO_LITE);
    const input = buildEngineInput(engine, {
      imageUrl: "x",
      motionPrompt: "y",
      // durationSec, resolution, generateAudio all omitted
    });
    assert.equal(input.duration, 6);
    assert.equal(input.resolution, "720p");
    assert.equal(input.generate_audio, true);
  });

  it("does not apply default when pipeline value is 0 (falsy but valid number)", () => {
    // 0 isn't empty, so coercion runs against it.
    const engine = makeEngine("veo-3.1-lite", VEO_LITE);
    const input = buildEngineInput(engine, {
      imageUrl: "x",
      motionPrompt: "y",
      durationSec: 0,
    });
    assert.equal(input.duration, 0);
  });

  it("skips optional params entirely when no value + no default", () => {
    const engine = makeEngine("kling-v3-standard", KLING);
    const input = buildEngineInput(engine, {
      imageUrl: "x",
      motionPrompt: "y",
      durationSec: 5,
      aspectRatio: "landscape",
      // dialogueText omitted — voice_text should not appear in output
    });
    assert.ok(!("voice_text" in input));
  });
});

describe("buildEngineInput — map primitive", () => {
  const aspectEngine = makeEngine("veo-3.1-lite", VEO_LITE);

  it("translates landscape → 16:9", () => {
    const input = buildEngineInput(aspectEngine, {
      imageUrl: "x",
      motionPrompt: "y",
      aspectRatio: "landscape",
    });
    assert.equal(input.aspect_ratio, "16:9");
  });

  it("translates square → 1:1", () => {
    const input = buildEngineInput(aspectEngine, {
      imageUrl: "x",
      motionPrompt: "y",
      aspectRatio: "square",
    });
    assert.equal(input.aspect_ratio, "1:1");
  });

  it("translates portrait → 9:16", () => {
    const input = buildEngineInput(aspectEngine, {
      imageUrl: "x",
      motionPrompt: "y",
      aspectRatio: "portrait",
    });
    assert.equal(input.aspect_ratio, "9:16");
  });

  it("passes through values not in the map", () => {
    const input = buildEngineInput(aspectEngine, {
      imageUrl: "x",
      motionPrompt: "y",
      aspectRatio: "21:9",
    });
    assert.equal(input.aspect_ratio, "21:9");
  });
});

describe("buildEngineInput — type coercion", () => {
  it("stringInt produces a string from a number (Kling)", () => {
    const engine = makeEngine("kling", KLING);
    const input = buildEngineInput(engine, {
      imageUrl: "x",
      motionPrompt: "y",
      durationSec: 5,
    });
    assert.equal(input.duration, "5");
    assert.equal(typeof input.duration, "string");
  });

  it("stringInt rounds floats", () => {
    const engine = makeEngine("kling", KLING);
    const input = buildEngineInput(engine, {
      imageUrl: "x",
      motionPrompt: "y",
      durationSec: 5.6,
    });
    assert.equal(input.duration, "6");
  });

  it("int rounds floats (Veo)", () => {
    const engine = makeEngine("veo-3.1-lite", VEO_LITE);
    const input = buildEngineInput(engine, {
      imageUrl: "x",
      motionPrompt: "y",
      durationSec: 6.7,
    });
    assert.equal(input.duration, 7);
  });

  it("boolean coerces truthy/falsy", () => {
    const engine = makeEngine("veo", VEO_LITE);
    const a = buildEngineInput(engine, {
      imageUrl: "x",
      motionPrompt: "y",
      generateAudio: false,
    });
    // false counts as empty here? No — isEmpty checks undefined/null/empty
    // string only. Boolean false is preserved.
    assert.equal(a.generate_audio, false);
  });
});

describe("buildEngineInput — static params", () => {
  it("merges static params into the final output", () => {
    const schema: ParamSchema = {
      params: [{ name: "prompt", from: "motionPrompt", type: "string", required: true }],
      static: { generate_audio: true, hidden_flag: "x" },
    };
    const engine = makeEngine("with-static", schema);
    const input = buildEngineInput(engine, { motionPrompt: "hi" });
    assert.equal(input.prompt, "hi");
    assert.equal(input.generate_audio, true);
    assert.equal(input.hidden_flag, "x");
  });

  it("static params override an entry with the same name", () => {
    const schema: ParamSchema = {
      params: [
        { name: "prompt", from: "motionPrompt", type: "string", required: true },
        { name: "generate_audio", from: "generateAudio", type: "boolean", default: false },
      ],
      static: { generate_audio: true },
    };
    const engine = makeEngine("static-wins", schema);
    const input = buildEngineInput(engine, { motionPrompt: "hi" });
    assert.equal(input.generate_audio, true);
  });
});

describe("buildEngineInput — unknown primitive", () => {
  it("throws UnknownParamTypeError on an unrecognized type", () => {
    const schema = {
      params: [
        { name: "x", from: "x", type: "exotic" as unknown as "string", required: true },
      ],
    } as unknown as ParamSchema;
    const engine = makeEngine("bad-type", schema);
    assert.throws(
      () => buildEngineInput(engine, { x: "value" }),
      (err) =>
        err instanceof UnknownParamTypeError &&
        err.type === "exotic" &&
        err.paramName === "x",
    );
  });
});

describe("buildEngineInput — malformed schema", () => {
  it("throws if paramSchema is missing params array", () => {
    const engine = makeEngine("broken", {} as unknown as ParamSchema);
    assert.throws(() => buildEngineInput(engine, {}), /malformed paramSchema/);
  });
});
