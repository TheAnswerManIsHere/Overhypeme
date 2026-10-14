/**
 * The recorded AI doubles (design D2–D5): stand-ins for the subset of the fal
 * and OpenAI clients the application calls, answering only from committed
 * recordings (`./recordings.ts`). Selected by `AI_BACKEND=recorded-double`
 * through `lib/aiClients.ts` and the facade in `lib/falClient.ts`; never
 * constructed by a caller directly.
 *
 * - A request with no recording throws `NoRecordingError` — it never falls
 *   through to a vendor.
 * - `AI_DOUBLE_FAIL=<kind>:<target>` (for example
 *   `fal.subscribe:fal-ai/nano-banana-2`) makes that operation throw the
 *   vendor error recorded for it, rebuilt as the SDK's own error class, so a
 *   real consumer handles it exactly as it would the vendor's.
 *   `<kind>:<target>@<qualifier>` narrows it to requests whose canonical form
 *   contains the qualifier (for an upload, its sha256), so one operation can
 *   fail while every other of its kind succeeds; with no recorded error for
 *   that operation it throws a plain error (increment 6, plan D6's
 *   upload-failure control).
 * - When `AI_DOUBLE_CALL_LOG` names a file, every call is appended to it, one
 *   JSON line each — kind, target, fingerprint and outcome — the shape of the
 *   recorder's ledger, so one evaluator reads either (increment 6, plan D6).
 * - Every call is appended to `doubleCalls`, so a test can assert the double —
 *   not the vendor — answered.
 * - When `AI_DOUBLE_MISS_LOG` names a file, every request with no recording is
 *   also appended to it, one JSON line each, and so is every request answered
 *   by a recorded vendor error it did not ask for (not via `AI_DOUBLE_FAIL`).
 *   Best-effort callers swallow either and fall back, so the replay run reads
 *   this file to fail visibly on a baseline call the recordings do not cover
 *   with a real answer (#654 rounds 2 and 5).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { ApiError, ValidationError } from "@fal-ai/client";
import OpenAI from "openai";

import { fingerprint, normaliseRequest } from "./fingerprint";
import { allRecordings, findRecording, NoRecordingError, type RecordedError, type RecordingKind } from "./recordings";

export interface DoubleCall {
  kind: RecordingKind;
  target: string;
  outcome: "replayed" | "failed-on-request" | "no-recording";
}

export const doubleCalls: DoubleCall[] = [];

/** Whether `AI_DOUBLE_FAIL` asks this call to fail: "all" for `kind:target`, "qualified" for `kind:target@qualifier`. */
function failureRequested(kind: RecordingKind, target: string, request: unknown, env: NodeJS.ProcessEnv = process.env): "all" | "qualified" | null {
  const wanted = (env.AI_DOUBLE_FAIL ?? "").trim();
  if (wanted === "") return null;
  const at = wanted.indexOf("@");
  if (at < 0) return wanted === `${kind}:${target}` ? "all" : null;
  if (wanted.slice(0, at) !== `${kind}:${target}`) return null;
  return JSON.stringify(normaliseRequest(request)).includes(wanted.slice(at + 1)) ? "qualified" : null;
}

export type CallOutcome = "replayed" | "failed-on-request" | "no-recording" | "recorded-error";

function logCall(kind: RecordingKind, target: string, print: string, outcome: CallOutcome): void {
  const callLog = process.env.AI_DOUBLE_CALL_LOG;
  if (callLog) fs.appendFileSync(callLog, JSON.stringify({ t: Date.now() / 1000, kind, target, fingerprint: print, outcome }) + "\n");
}

function rebuild(err: RecordedError): Error {
  if (err.name === "ApiError" || err.name === "ValidationError") {
    const Ctor = err.name === "ValidationError" ? ValidationError : ApiError;
    return new Ctor({ message: err.message, status: err.status, body: err.body as never });
  }
  // The recording holds the SDK's `error` (the vendor's inner error object);
  // `generate` reads it from an `{ error }` envelope, as the HTTP body carries it.
  return OpenAI.APIError.generate(err.status, { error: err.body }, err.message, new Headers());
}

function logMiss(entry: { kind: RecordingKind; target: string; fingerprint: string; recordedErrorStatus?: number }): void {
  const missLog = process.env.AI_DOUBLE_MISS_LOG;
  if (missLog) fs.appendFileSync(missLog, JSON.stringify(entry) + "\n");
}

function noteMiss(kind: RecordingKind, target: string, print: string): void {
  doubleCalls.push({ kind, target, outcome: "no-recording" });
  logMiss({ kind, target, fingerprint: print });
  logCall(kind, target, print, "no-recording");
}

/** Answer one operation from its recording, or fail visibly. */
function replay(kind: RecordingKind, target: string, request: unknown): unknown {
  const failure = failureRequested(kind, target, request);
  if (failure) {
    const recorded = allRecordings().find((r) => r.kind === kind && r.target === target && r.error);
    const print = fingerprint(kind, request);
    if (!recorded?.error) {
      if (failure === "qualified") {
        doubleCalls.push({ kind, target, outcome: "failed-on-request" });
        logCall(kind, target, print, "failed-on-request");
        throw new Error(`[ai-double] ${kind} ${target} failed on request (AI_DOUBLE_FAIL)`);
      }
      noteMiss(kind, target, "none");
      throw new NoRecordingError(kind, `${target} (recorded failure)`, "none");
    }
    doubleCalls.push({ kind, target, outcome: "failed-on-request" });
    logCall(kind, target, print, "failed-on-request");
    throw rebuild(recorded.error);
  }
  let rec;
  try {
    rec = findRecording(kind, target, request);
  } catch (err) {
    if (err instanceof NoRecordingError) noteMiss(kind, target, err.print);
    throw err;
  }
  doubleCalls.push({ kind, target, outcome: "replayed" });
  logCall(kind, target, rec.fingerprint, rec.error ? "recorded-error" : "replayed");
  if (rec.error) {
    // The request itself was recorded as a vendor error. That is the answer it
    // replays, but not coverage: a run that never asked for a failure is told.
    logMiss({ kind, target, fingerprint: rec.fingerprint, recordedErrorStatus: rec.error.status });
    throw rebuild(rec.error);
  }
  // A fresh copy, so a caller mutating the response cannot change the next replay.
  return structuredClone(rec.response);
}

// ---------------------------------------------------------------------------
// Request shapes: what each operation is fingerprinted by. Shared with the
// recorder, so a recorded pair and its replay are keyed identically.
// ---------------------------------------------------------------------------

export function falSubscribeRequest(endpoint: string, opts: { input?: unknown }): unknown {
  return { endpoint, input: opts?.input ?? null };
}

export async function falUploadRequest(file: Blob): Promise<{ contentType: string; bytes: number; sha256: string }> {
  const buf = Buffer.from(await file.arrayBuffer());
  return { contentType: file.type, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
}

/**
 * The URL the double gives an uploaded file: derived from its bytes, so a
 * recorded request that referenced the real upload URL (rewritten to this by
 * the recorder) matches the replay's request.
 */
export function falUploadUrl(sha256: string): string {
  return `https://fal-double.invalid/files/${sha256}`;
}

// ---------------------------------------------------------------------------
// fal
// ---------------------------------------------------------------------------

export interface FalLike {
  subscribe(endpoint: string, opts: { input?: unknown; logs?: boolean; onQueueUpdate?: (s: unknown) => void; [k: string]: unknown }): Promise<any>;
  storage: { upload(file: Blob, opts?: unknown): Promise<string> };
  queue: {
    submit(endpoint: string, opts: { input?: unknown; [k: string]: unknown }): Promise<any>;
    status(endpoint: string, opts: { requestId: string; [k: string]: unknown }): Promise<any>;
    result(endpoint: string, opts: { requestId: string; [k: string]: unknown }): Promise<any>;
  };
  config(opts: unknown): void;
}

export const falDouble: FalLike = {
  async subscribe(endpoint, opts) {
    const result = replay("fal.subscribe", endpoint, falSubscribeRequest(endpoint, opts)) as Record<string, unknown>;
    // The real client reports a COMPLETED status before resolving; consumers
    // that watch the queue see the same final transition.
    opts?.onQueueUpdate?.({ status: "COMPLETED", request_id: result?.requestId, logs: [] });
    return result;
  },
  storage: {
    async upload(file) {
      const request = await falUploadRequest(file);
      replay("fal.storage.upload", "storage", request);
      return falUploadUrl(request.sha256);
    },
  },
  queue: {
    async submit(endpoint) {
      doubleCalls.push({ kind: "fal.subscribe", target: endpoint, outcome: "no-recording" });
      throw new NoRecordingError("fal.subscribe", `${endpoint} (queue.submit)`, "none");
    },
    async status(endpoint) {
      throw new NoRecordingError("fal.subscribe", `${endpoint} (queue.status)`, "none");
    },
    async result(endpoint) {
      throw new NoRecordingError("fal.subscribe", `${endpoint} (queue.result)`, "none");
    },
  },
  config() {
    // No credentials to configure.
  },
};

/** The recorded fal pricing response for an endpoint, as `fetch(...).json()` would return it. */
export function falPricingReplay(endpointId: string): unknown {
  return replay("fal.pricing", endpointId, { endpoint: endpointId });
}

// ---------------------------------------------------------------------------
// OpenAI — only the three surfaces the application calls.
// ---------------------------------------------------------------------------

export function openaiDouble(): OpenAI {
  const client = {
    chat: {
      completions: {
        async create(params: { model: string }) {
          return replay("openai.chat", params.model, params);
        },
      },
    },
    embeddings: {
      async create(params: { model: string }) {
        return replay("openai.embeddings", params.model, params);
      },
    },
    responses: {
      async create(params: { model: string }) {
        return replay("openai.responses", params.model, params);
      },
    },
  };
  return client as unknown as OpenAI;
}
