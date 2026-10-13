/**
 * The AI doubles and the recorder (Launch Phase 2, increment 4, #631; design
 * `docs/plans/PLAN_PHASE2_INC4_AI_DOUBLES.md`).
 *
 * The recordings these tests replay are made by the recorder itself, from a
 * stand-in vendor, so each test exercises the round trip a real recording
 * takes: the recorder writes a pair, the double finds it by the request's
 * fingerprint. No test here reaches a vendor.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiError, createFalClient } from "@fal-ai/client";
import OpenAI from "openai";

import { aiBackend, getEmbeddingsClient, getOpenAIClient } from "../lib/aiClients.js";
import { ensureFalConfigured, fal, FAL_DOUBLE_SENTINEL, getFalApiKey } from "../lib/falClient.js";
import { doubleCalls, falDouble, falUploadUrl, type FalLike } from "../lib/aiDouble/doubles.js";
import { NoRecordingError, resetRecordingCache } from "../lib/aiDouble/recordings.js";
import {
  Allowance,
  FAL_SUBMISSION_ATTEMPTS,
  RecorderBudgetError,
  recordingFal,
  recordingOpenAI,
  vendorRejectionCaptured,
  controlAlreadyCaptured,
} from "../lib/aiDouble/recorder.js";
import { allRecordings } from "../lib/aiDouble/recordings.js";

const CTX = { clients: { "@fal-ai/client": "1.9.5", openai: "6.33.0" } };
// The suite runs every file in one process (--test-isolation=none), where a
// root-level hook would run around every other file's tests too. So every hook
// here lives inside the top-level describe below, and the environment is
// restored key by key, never by replacing process.env.
const TOUCHED = ["AI_RECORDINGS_DIR", "NODE_ENV", "OPENAI_API_KEY", "FAL_AI_API_KEY", "FAL_KEY", "AI_DOUBLE_FAIL", "AI_BACKEND", "AI_DOUBLE_MISS_LOG"];
let saved: Record<string, string | undefined> = {};
let dir: string;

function setUp(): void {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-recordings-"));
  process.env.AI_RECORDINGS_DIR = dir;
  for (const k of ["OPENAI_API_KEY", "FAL_AI_API_KEY", "FAL_KEY", "AI_DOUBLE_FAIL", "AI_BACKEND", "AI_DOUBLE_MISS_LOG"]) delete process.env[k];
  doubleCalls.length = 0;
  resetRecordingCache();
}

function tearDown(): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  resetRecordingCache();
}

/** A stand-in vendor: answers chat with fixed usage, embeddings with a vector. */
function fakeOpenAIVendor(onCall: (kind: string, params: any) => void = () => {}) {
  return {
    chat: {
      completions: {
        async create(params: any) {
          onCall("chat", params);
          if (params.messages.some((m: any) => m.content === "please fail")) {
            throw OpenAI.APIError.generate(400, { message: "bad request", type: "invalid_request_error" }, "bad request", new Headers());
          }
          return {
            id: "chatcmpl-real-id",
            object: "chat.completion",
            model: params.model,
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"template":"{NAME} wins"}' } }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          };
        },
      },
    },
    embeddings: {
      async create(params: any) {
        onCall("embeddings", params);
        return { object: "list", model: params.model, data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 4, total_tokens: 4 } };
      },
    },
  };
}

const CHAT = {
  model: "gpt-5.4-mini",
  max_completion_tokens: 8512,
  reasoning_effort: "low",
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: "Tokenise." },
    { role: "user", content: "Chuck counted to infinity. Twice." },
  ],
};

describe("AI doubles and recorder", () => {
  beforeEach(setUp);
  afterEach(tearDown);

  describe("selection comes before any credential", () => {
    it("serves every client under the double with no key set", () => {
      process.env.AI_BACKEND = "recorded-double";
      assert.equal(aiBackend(), "recorded-double");
      assert.doesNotThrow(() => getOpenAIClient());
      assert.doesNotThrow(() => getEmbeddingsClient());
      assert.equal(getFalApiKey(), FAL_DOUBLE_SENTINEL);
      assert.doesNotThrow(() => ensureFalConfigured());
    });

    it("still demands the keys for the real vendors", () => {
      assert.equal(aiBackend(), "vendors");
      assert.throws(() => getEmbeddingsClient(), /OPENAI_API_KEY/);
      assert.equal(getFalApiKey(), null);
      assert.throws(() => ensureFalConfigured(), /FAL_AI_API_KEY/);
    });
  });

  describe("record, then replay", () => {
    it("replays a recorded chat completion and refuses an unrecorded one", async () => {
      const recorder = recordingOpenAI(fakeOpenAIVendor() as any, new Allowance(1), CTX);
      await recorder.chat.completions.create(CHAT as any);

      process.env.AI_BACKEND = "recorded-double";
      const replayed: any = await getOpenAIClient().chat.completions.create(CHAT as any);
      assert.equal(replayed.choices[0].message.content, '{"template":"{NAME} wins"}');
      assert.notEqual(replayed.id, "chatcmpl-real-id", "request ids are scrubbed");
      assert.deepEqual(doubleCalls.at(-1), { kind: "openai.chat", target: "gpt-5.4-mini", outcome: "replayed" });

      // A corrective retry adds a message: a different request, so no recording.
      const retry = { ...CHAT, messages: [...CHAT.messages, { role: "user", content: "Fix the JSON." }] };
      await assert.rejects(getOpenAIClient().chat.completions.create(retry as any), NoRecordingError);
      assert.equal(doubleCalls.at(-1)?.outcome, "no-recording");
    });

    it("writes every unrecorded request to the miss log, for the replay run to fail on", async () => {
      const missLog = path.join(dir, "misses.jsonl");
      process.env.AI_DOUBLE_MISS_LOG = missLog;
      process.env.AI_BACKEND = "recorded-double";
      await assert.rejects(getOpenAIClient().chat.completions.create(CHAT as any), NoRecordingError);
      const lines = fs.readFileSync(missLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].kind, "openai.chat");
      assert.equal(lines[0].target, "gpt-5.4-mini");
      assert.match(lines[0].fingerprint, /^[0-9a-f]{64}$/);
    });

    it("answers a request already on disk from its recording, counts it as reused and pays nothing", async () => {
      let sent = 0;
      await recordingOpenAI(fakeOpenAIVendor(() => sent++) as any, new Allowance(1), CTX).chat.completions.create(CHAT as any);
      const ledger = path.join(dir, "..", `${path.basename(dir)}-ledger.json`);
      try {
        const resumed = new Allowance(1, ledger);
        await recordingOpenAI(fakeOpenAIVendor(() => sent++) as any, resumed, CTX).chat.completions.create(CHAT as any);
        assert.equal(sent, 1, "the second run did not reach the vendor");
        assert.equal(resumed.reused, 1);
        assert.equal(resumed.committed, 0);
        assert.equal(JSON.parse(fs.readFileSync(ledger, "utf8")).reused, 1, "the count reaches the run's report through the ledger");
      } finally {
        fs.rmSync(ledger, { force: true });
      }
    });

    it("keys on the whole request, including the schema and output options", async () => {
      const recorder = recordingOpenAI(fakeOpenAIVendor() as any, new Allowance(1), CTX);
      await recorder.chat.completions.create(CHAT as any);
      process.env.AI_BACKEND = "recorded-double";
      for (const variant of [
        { ...CHAT, response_format: { type: "json_schema", json_schema: { name: "x", schema: {} } } },
        { ...CHAT, max_completion_tokens: 9000 },
        { ...CHAT, model: "gpt-5.5" },
        { ...CHAT, messages: [{ role: "system", content: "Tokenise!" }, CHAT.messages[1]] },
      ]) {
        await assert.rejects(getOpenAIClient().chat.completions.create(variant as any), NoRecordingError);
      }
    });

    it("replays embeddings through the embeddings client", async () => {
      const recorder = recordingOpenAI(fakeOpenAIVendor() as any, new Allowance(1), CTX);
      const req = { model: "text-embedding-3-small", input: "Chuck", dimensions: 384 };
      await recorder.embeddings.create(req as any);
      process.env.AI_BACKEND = "recorded-double";
      const res: any = await getEmbeddingsClient().embeddings.create(req as any);
      assert.deepEqual(res.data[0].embedding, [0.1, 0.2, 0.3]);
    });

    it("raises the recorded vendor error as the SDK's own class when asked to fail", async () => {
      const recorder = recordingOpenAI(fakeOpenAIVendor() as any, new Allowance(1), CTX);
      const failing = { ...CHAT, messages: [{ role: "user", content: "please fail" }] };
      await assert.rejects(recorder.chat.completions.create(failing as any), OpenAI.APIError);

      process.env.AI_BACKEND = "recorded-double";
      // Replaying the failing request itself reproduces the error...
      await assert.rejects(getOpenAIClient().chat.completions.create(failing as any), (err: any) => err instanceof OpenAI.APIError && err.status === 400);
      // ...and the failure control turns any call to that model into it.
      process.env.AI_DOUBLE_FAIL = "openai.chat:gpt-5.4-mini";
      await assert.rejects(getOpenAIClient().chat.completions.create(CHAT as any), (err: any) => err instanceof OpenAI.APIError && err.status === 400);
      assert.equal(doubleCalls.at(-1)?.outcome, "failed-on-request");
    });
  });

  describe("the fal double", () => {
    function fakeFalVendor(): FalLike {
      return {
        async subscribe(endpoint: string, opts: any) {
          if (opts.input?.prompt === "fail") throw new ApiError({ message: "Unprocessable", status: 422, body: { detail: [{ msg: "bad prompt", type: "value_error" }] } });
          return { requestId: "real-request", data: { images: [{ url: "data:image/png;base64,iVBORw0KGgo=", content_type: "image/png" }] } };
        },
        storage: { async upload() { return "https://v3.fal.media/files/real-upload.png"; } },
        queue: { submit: async () => ({}), status: async () => ({}), result: async () => ({}) },
        config() {},
      };
    }
    const price = async () => 0.08;

    it("replays a generation, including a request that carried an uploaded file's URL", async () => {
      const rec = recordingFal(fakeFalVendor(), new Allowance(1), CTX, price);
      const blob = new Blob([Buffer.from("reference-bytes")], { type: "image/jpeg" });
      const realUrl = await rec.storage.upload(blob);
      await rec.subscribe("fal-ai/nano-banana-2/edit", { input: { prompt: "hero", image_urls: [realUrl] } });

      process.env.AI_BACKEND = "recorded-double";
      const url = await fal.storage.upload(blob);
      assert.match(url, /^https:\/\/fal-double\.invalid\/files\/[0-9a-f]{64}$/);
      const result: any = await fal.subscribe("fal-ai/nano-banana-2/edit", { input: { prompt: "hero", image_urls: [url] } });
      assert.match(result.data.images[0].url, /^data:image\/png;base64,/);
      // The media a render downloads is local: a data URL, readable with no network.
      const [header, payload] = result.data.images[0].url.split(",");
      assert.equal(header, "data:image/png;base64");
      assert.ok(Buffer.from(payload, "base64").subarray(1, 4).equals(Buffer.from("PNG")));
    });

    it("raises the recorded fal error as an ApiError when asked to fail", async () => {
      const rec = recordingFal(fakeFalVendor(), new Allowance(1), CTX, price);
      await assert.rejects(rec.subscribe("fal-ai/nano-banana-2", { input: { prompt: "fail" } }), ApiError);
      process.env.AI_BACKEND = "recorded-double";
      process.env.AI_DOUBLE_FAIL = "fal.subscribe:fal-ai/nano-banana-2";
      await assert.rejects(fal.subscribe("fal-ai/nano-banana-2", { input: { prompt: "anything" } }), (err: any) => err instanceof ApiError && err.status === 422);
    });

    it("fails visibly on anything unrecorded, including the admin queue path", async () => {
      process.env.AI_BACKEND = "recorded-double";
      await assert.rejects(fal.subscribe("fal-ai/yolo-world", { input: {} }), NoRecordingError);
      await assert.rejects(falDouble.queue.submit("fal-ai/nano-banana-2", { input: {} }), NoRecordingError);
    });

    it("is selected per call, not when the module loaded", async () => {
      process.env.AI_BACKEND = "recorded-double";
      await assert.rejects(fal.subscribe("fal-ai/unrecorded", { input: {} }), NoRecordingError);
      assert.equal(doubleCalls.length, 1);
      delete process.env.AI_BACKEND;
      assert.equal(getFalApiKey(), null, "back on the vendor path, the key gate applies again");
    });
  });

  describe("the recording run's failure control", () => {
    const INVALID = { ...CHAT, messages: [{ role: "user", content: "please fail" }] };

    it("counts the vendor's own rejection with the expected status as captured, with its recording on disk", async () => {
      const rec = recordingOpenAI(fakeOpenAIVendor() as any, new Allowance(1), CTX);
      const err = await rec.chat.completions.create(INVALID as any).catch((e: unknown) => e);
      assert.equal(vendorRejectionCaptured("openai.chat", "gpt-5.4-mini", err, 400), true);
    });

    it("does not count a budget refusal: nothing reached the vendor and nothing was recorded", async () => {
      const allowance = new Allowance(1);
      allowance.reserve("openai.chat", "gpt-5.5", 0.9999);
      const rec = recordingOpenAI(fakeOpenAIVendor() as any, allowance, CTX);
      const err = await rec.chat.completions.create(INVALID as any).catch((e: unknown) => e);
      assert.ok(err instanceof RecorderBudgetError);
      assert.equal(vendorRejectionCaptured("openai.chat", "gpt-5.4-mini", err, 400), false);
    });

    it("does not record or count a transport failure, which carries no vendor status", async () => {
      const vendor = fakeOpenAIVendor();
      vendor.chat.completions.create = async () => {
        throw Object.assign(new Error("socket hang up"), { name: "APIConnectionError" });
      };
      const rec = recordingOpenAI(vendor as any, new Allowance(1), CTX);
      const err = await rec.chat.completions.create(INVALID as any).catch((e: unknown) => e);
      assert.equal(vendorRejectionCaptured("openai.chat", "gpt-5.4-mini", err, 400), false);
      assert.equal(allRecordings().length, 0, "a transport failure is never written as a recording");
    });

    it("does not count a vendor 4xx other than the expected one, such as throttling", async () => {
      const vendor = fakeOpenAIVendor();
      vendor.chat.completions.create = async () => {
        throw OpenAI.APIError.generate(429, { message: "rate limited", type: "rate_limit_error" }, "rate limited", new Headers());
      };
      const rec = recordingOpenAI(vendor as any, new Allowance(1), CTX);
      const err = await rec.chat.completions.create(INVALID as any).catch((e: unknown) => e);
      assert.equal(vendorRejectionCaptured("openai.chat", "gpt-5.4-mini", err, 400), false);
    });

    it("lets a resume reuse a failure control already captured with its expected status, and nothing else", async () => {
      const rec = recordingOpenAI(fakeOpenAIVendor() as any, new Allowance(1), CTX);
      await rec.chat.completions.create(INVALID as any).catch(() => {});
      assert.equal(controlAlreadyCaptured("openai.chat", "gpt-5.4-mini", INVALID, 400), true);
      assert.equal(controlAlreadyCaptured("openai.chat", "gpt-5.4-mini", INVALID, 429), false, "a different status is not the control");
      assert.equal(controlAlreadyCaptured("openai.chat", "gpt-5.4-mini", CHAT, 400), false, "a different request is not the control");
      await rec.chat.completions.create(CHAT as any);
      assert.equal(controlAlreadyCaptured("openai.chat", "gpt-5.4-mini", CHAT, 400), false, "a recorded success is not a control");
    });

    it("does not count a vendor accepting the invalid request", async () => {
      const rec = recordingOpenAI(fakeOpenAIVendor() as any, new Allowance(1), CTX);
      const ok = await rec.chat.completions.create(CHAT as any);
      assert.equal(vendorRejectionCaptured("openai.chat", "gpt-5.4-mini", ok, 400), false);
    });
  });

  describe("the recorder's allowance", () => {
    it("refuses a call whose price is unknown, before dispatch", async () => {
      let sent = 0;
      const rec = recordingOpenAI(fakeOpenAIVendor(() => sent++) as any, new Allowance(1), CTX);
      await assert.rejects(rec.chat.completions.create({ ...CHAT, model: "gpt-unknown" } as any), RecorderBudgetError);
      assert.equal(sent, 0);
    });

    it("refuses a call whose conservative maximum does not fit, counting calls still outstanding", () => {
      const allowance = new Allowance(1);
      allowance.reserve("openai.chat", "gpt-5.5", 0.6); // outstanding
      assert.throws(() => allowance.reserve("openai.chat", "gpt-5.5", 0.5), RecorderBudgetError);
      assert.doesNotThrow(() => allowance.reserve("openai.chat", "gpt-5.5", 0.4));
    });

    it("settles to actual usage when it is known, and keeps the reservation when it is not", async () => {
      const allowance = new Allowance(1);
      const ok = allowance.reserve("openai.chat", "gpt-5.5", 0.5);
      allowance.settle(ok, 0.01, true);
      const unknown = allowance.reserve("openai.chat", "gpt-5.5", 0.3);
      allowance.settle(unknown, null, true);
      const failed = allowance.reserve("openai.chat", "gpt-5.5", 0.1);
      allowance.settle(failed, 0.001, false);
      assert.equal(Number(allowance.committed.toFixed(6)), 0.41);
    });

    it("reserves a chat call at its output cap and settles it to the vendor's usage", async () => {
      const allowance = new Allowance(1);
      const rec = recordingOpenAI(fakeOpenAIVendor() as any, allowance, CTX);
      await rec.chat.completions.create(CHAT as any);
      const line = allowance.lines[0];
      assert.ok(line.reservedUsd >= (8512 * 4.5) / 1e6, "the reservation covers the whole output cap");
      assert.equal(line.actualUsd, (100 * 0.75 + 50 * 4.5) / 1e6);
    });

    it("reserves a fal generation for every submission attempt the SDK may make", async () => {
      const allowance = new Allowance(1);
      const rec = recordingFal(
        { ...({} as FalLike), subscribe: async () => ({ data: { images: [] } }), storage: { upload: async () => "" }, config() {} } as FalLike,
        allowance,
        CTX,
        async () => 0.08,
      );
      await rec.subscribe("fal-ai/nano-banana-2", { input: { prompt: "x" } });
      assert.equal(allowance.lines[0].reservedUsd, 0.08 * FAL_SUBMISSION_ATTEMPTS);
      assert.equal(allowance.committed, 0.08 * FAL_SUBMISSION_ATTEMPTS, "an unobserved retry count keeps the reservation");
    });

    it("matches the real SDK: one subscribe makes at most four submissions", async () => {
      let submissions = 0;
      const client = createFalClient({
        credentials: "test",
        fetch: (async (url: string | URL | Request) => {
          if (String(url).includes("queue.fal.run")) submissions++;
          return new Response(JSON.stringify({ detail: "busy" }), { status: 503, headers: { "content-type": "application/json" } });
        }) as typeof fetch,
      });
      await assert.rejects(client.subscribe("fal-ai/nano-banana-2", { input: { prompt: "x" } }));
      assert.ok(submissions >= 1 && submissions <= FAL_SUBMISSION_ATTEMPTS, `submissions=${submissions}`);
      assert.equal(submissions, FAL_SUBMISSION_ATTEMPTS, "the SDK retries a retryable submission three times");
    });
  });
});
