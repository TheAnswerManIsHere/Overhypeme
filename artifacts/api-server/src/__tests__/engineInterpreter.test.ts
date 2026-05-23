import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEngineInput,
  MissingRequiredParamError,
  UnknownParamTypeError,
  InvalidEngineParamError,
  type ParamSchema,
} from "../lib/engineInterpreter.js";
import { VEO_3_1_LITE } from "../lib/engines/veo-3.1-lite.js";
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
    { name: "generate_audio",  from: "generateAudio",  type: "boolean",   default: true },
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
    });
    assert.equal(input.duration, "5");
    assert.equal(typeof input.duration, "string");
    assert.equal(input.aspect_ratio, "16:9");
    // Default negative_prompt applied
    assert.equal(input.negative_prompt, "blur, distort, low quality");
    // Audio toggle present (Kling honors `generate_audio`; dialogue is
    // routed via the prompt by applyAudioHandling's prompt_cue path, not
    // through a dedicated field).
    assert.equal(input.generate_audio, true);
    assert.ok(!("voice_text" in input), "voice_text is not a Kling v3 standard param");
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
    const engine = makeEngine("optional-shape", {
      params: [
        { name: "image_url",  from: "imageUrl",  type: "string", required: true },
        { name: "extra_note", from: "extraNote", type: "string" },
      ],
    });
    const input = buildEngineInput(engine, { imageUrl: "x" });
    assert.ok(!("extra_note" in input), "extra_note should be omitted when optional + empty");
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

// ────────────────────────────────────────────────────────────────────────────
// Validation primitives: enum, range, includeWhen
// ────────────────────────────────────────────────────────────────────────────

describe("buildEngineInput — enum validation", () => {
  it("accepts values inside the declared enum", () => {
    const schema: ParamSchema = {
      params: [
        { name: "resolution", from: "resolution", type: "string", enum: ["480p", "720p"] },
      ],
    };
    const engine = makeEngine("e1", schema);
    const input = buildEngineInput(engine, { resolution: "720p" });
    assert.equal(input.resolution, "720p");
  });

  it("throws InvalidEngineParamError when value is outside enum", () => {
    const schema: ParamSchema = {
      params: [
        { name: "resolution", from: "resolution", type: "string", enum: ["720p"] },
      ],
    };
    const engine = makeEngine("e2", schema);
    assert.throws(
      () => buildEngineInput(engine, { resolution: "4k" }),
      (err) =>
        err instanceof InvalidEngineParamError &&
        err.paramName === "resolution" &&
        err.value === "4k",
    );
  });

  it("enum validates AFTER map substitution (so wizard 'landscape' passes)", () => {
    const schema: ParamSchema = {
      params: [
        {
          name: "aspect_ratio",
          from: "aspectRatio",
          type: "string",
          map: { landscape: "16:9", square: "1:1" },
          enum: ["16:9", "1:1", "9:16"],
        },
      ],
    };
    const engine = makeEngine("e3", schema);
    const input = buildEngineInput(engine, { aspectRatio: "landscape" });
    assert.equal(input.aspect_ratio, "16:9");
  });

  it("enum applies to numeric primitives (e.g. duration int)", () => {
    const schema: ParamSchema = {
      params: [
        { name: "duration", from: "durationSec", type: "int", enum: [4, 6, 8] },
      ],
    };
    const engine = makeEngine("e4", schema);
    assert.equal(buildEngineInput(engine, { durationSec: 6 }).duration, 6);
    assert.throws(
      () => buildEngineInput(engine, { durationSec: 5 }),
      InvalidEngineParamError,
    );
  });
});

describe("buildEngineInput — range validation", () => {
  it("clamps values below min when policy is 'clamp' (default)", () => {
    const schema: ParamSchema = {
      params: [
        {
          name: "cfg_scale",
          from: "cfgScale",
          type: "float",
          range: { min: 0, max: 1 },
        },
      ],
    };
    const engine = makeEngine("r1", schema);
    const input = buildEngineInput(engine, { cfgScale: -0.5 });
    assert.equal(input.cfg_scale, 0);
  });

  it("clamps values above max when policy is 'clamp'", () => {
    const schema: ParamSchema = {
      params: [
        {
          name: "cfg_scale",
          from: "cfgScale",
          type: "float",
          range: { min: 0, max: 1, policy: "clamp" },
        },
      ],
    };
    const engine = makeEngine("r2", schema);
    const input = buildEngineInput(engine, { cfgScale: 5 });
    assert.equal(input.cfg_scale, 1);
  });

  it("throws when range policy is 'throw' and value is out of range", () => {
    const schema: ParamSchema = {
      params: [
        {
          name: "font_size",
          from: "fontSize",
          type: "int",
          range: { min: 16, max: 200, policy: "throw" },
        },
      ],
    };
    const engine = makeEngine("r3", schema);
    assert.throws(
      () => buildEngineInput(engine, { fontSize: 500 }),
      (err) =>
        err instanceof InvalidEngineParamError && err.value === 500,
    );
  });

  it("passes through values inside the range", () => {
    const schema: ParamSchema = {
      params: [
        {
          name: "y",
          from: "y",
          type: "int",
          range: { min: 0, max: 100 },
        },
      ],
    };
    const engine = makeEngine("r4", schema);
    const input = buildEngineInput(engine, { y: 50 });
    assert.equal(input.y, 50);
  });
});

describe("buildEngineInput — includeWhen conditional inclusion", () => {
  it("emits the param when predicate (equals) matches", () => {
    const schema: ParamSchema = {
      params: [
        {
          name: "voice_text",
          from: "dialogue",
          type: "string",
          includeWhen: { field: "audioMode", equals: "voice_control" },
        },
      ],
    };
    const engine = makeEngine("c1", schema);
    const input = buildEngineInput(engine, {
      audioMode: "voice_control",
      dialogue: "Hello world",
    });
    assert.equal(input.voice_text, "Hello world");
  });

  it("drops the param when predicate (equals) does not match", () => {
    const schema: ParamSchema = {
      params: [
        {
          name: "voice_text",
          from: "dialogue",
          type: "string",
          includeWhen: { field: "audioMode", equals: "voice_control" },
        },
      ],
    };
    const engine = makeEngine("c2", schema);
    const input = buildEngineInput(engine, {
      audioMode: "prompt_cue",
      dialogue: "Hello world",
    });
    assert.equal("voice_text" in input, false);
  });

  it("respects 'present: true' predicate", () => {
    const schema: ParamSchema = {
      params: [
        {
          name: "negative_prompt",
          from: "negativePrompt",
          type: "string",
          includeWhen: { field: "negativePrompt", present: true },
        },
      ],
    };
    const engine = makeEngine("c3", schema);
    assert.equal(
      "negative_prompt" in buildEngineInput(engine, { negativePrompt: "blurry" }),
      true,
    );
    assert.equal(
      "negative_prompt" in buildEngineInput(engine, {}),
      false,
    );
    assert.equal(
      "negative_prompt" in buildEngineInput(engine, { negativePrompt: "" }),
      false,
    );
  });

  it("supports 'any' OR semantics", () => {
    const schema: ParamSchema = {
      params: [
        {
          name: "extra",
          from: "extra",
          type: "string",
          default: "yes",
          includeWhen: {
            any: [
              { field: "mode", equals: "custom" },
              { field: "mode", equals: "fun" },
            ],
          },
        },
      ],
    };
    const engine = makeEngine("c4", schema);
    assert.equal(buildEngineInput(engine, { mode: "custom" }).extra, "yes");
    assert.equal(buildEngineInput(engine, { mode: "fun" }).extra, "yes");
    assert.equal("extra" in buildEngineInput(engine, { mode: "normal" }), false);
  });

  it("supports greaterThan / lessThan", () => {
    const schema: ParamSchema = {
      params: [
        {
          name: "long_clip_warning",
          from: "shouldWarn",
          type: "boolean",
          default: true,
          includeWhen: { field: "durationSec", greaterThan: 10 },
        },
      ],
    };
    const engine = makeEngine("c5", schema);
    assert.equal(
      buildEngineInput(engine, { durationSec: 12 }).long_clip_warning,
      true,
    );
    assert.equal(
      "long_clip_warning" in buildEngineInput(engine, { durationSec: 6 }),
      false,
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Regression: the migration-0058 bug class
// (sending an engine a parameter it doesn't accept)
// ────────────────────────────────────────────────────────────────────────────

describe("buildEngineInput — Veo Lite generate_audio docs alignment", () => {
  it("Veo 3.1 Lite paramSchema DOES emit generate_audio", () => {
    // Migration 0058 documented a real 422 "no_media_generated" from this
    // endpoint months ago. Current fal docs (May 2026) list generate_audio
    // as an accepted boolean toggling the $0.05/s (with audio) vs $0.03/s
    // (without audio) pricing tier:
    //   https://fal.ai/docs/model-api-reference/video-generation-api/veo3.1-lite
    // If a workbench run starts 422ing again, FLIP THIS GUARD back to
    // "must not declare generate_audio" — that's the cleanest rollback
    // signal. Until then, the catalogue + this test track the docs.
    const names = VEO_3_1_LITE.paramSchema.params.map((p) => p.name);
    assert.ok(
      names.includes("generate_audio"),
      "veo-3.1-lite must declare generate_audio per fal docs (May 2026)",
    );
  });
});
