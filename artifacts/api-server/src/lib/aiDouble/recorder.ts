/**
 * `AI_BACKEND=recorder`: the real AI clients, wrapped to capture each
 * request/response pair as a recording (design D6, settled with Astra).
 *
 * Run only by `scripts/record-ai-baseline.ts`, on the Repl, against the
 * marked test database — never in CI, and refused in a production boot by
 * `lib/doubleSelection.ts`.
 *
 * **The spending ceiling is enforced here, before dispatch.** Every vendor
 * call reserves its conservative maximum cost against the allowance
 * (`AI_RECORDER_ALLOWANCE_USD`, required), counting calls still outstanding;
 * a call with an unknown price, or whose reservation does not fit the
 * remainder, is refused and never sent. A completed call's reservation is
 * settled to its actual usage only when that usage is established; a failed
 * or timed-out call keeps its reservation. OpenAI retries are off, so one
 * admitted call is one attempt. fal's `queue.submit` retries up to three
 * times on its own (`@fal-ai/client` 1.9.5 merges its `maxRetries: 3` after
 * the client configuration), so a fal generation reserves four attempts.
 *
 * **What is written** goes to `AI_RECORDINGS_DIR`, scrubbed: request ids are
 * replaced, generated images become small data URLs (the media the double
 * serves, D3), and a vendor URL the application later sends back is
 * rewritten to the URL the double will give it, so the replay's requests
 * fingerprint identically.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

import { fingerprint, normaliseRequest } from "./fingerprint";
import { allRecordings, findRecording, NoRecordingError, recordingFileName, recordingsDir, resetRecordingCache, type Recording, type RecordingKind } from "./recordings";
import { falSubscribeRequest, falUploadRequest, falUploadUrl, type FalLike } from "./doubles";

// ---------------------------------------------------------------------------
// The allowance
// ---------------------------------------------------------------------------

/**
 * Published list prices, USD per 1M tokens, read from developers.openai.com
 * model pages: 2026-10-12, and `gpt-4o-mini` (the default utility model on a
 * fresh database) 2026-10-13.
 */
export const OPENAI_PRICES: Record<string, { input: number; output: number }> = {
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
};

/** fal's own `queue.submit` retries (see the module comment). */
export const FAL_SUBMISSION_ATTEMPTS = 4;

export class RecorderBudgetError extends Error {
  constructor(message: string) {
    super(`[ai-recorder] refused: ${message}`);
    this.name = "RecorderBudgetError";
  }
}

export interface LedgerLine {
  kind: RecordingKind;
  target: string;
  reservedUsd: number;
  actualUsd: number | null;
  outcome: "ok" | "error" | "refused";
}

export class Allowance {
  private committedUsd = 0;
  /** Requests answered from a recording already on disk, at no cost (a `--resume` run). */
  private reusedCount = 0;
  readonly lines: LedgerLine[] = [];

  /** `ledgerFile`, when given, is rewritten after every change so the launcher can report the run. */
  constructor(
    readonly limitUsd: number,
    private readonly ledgerFile?: string,
  ) {
    if (!(limitUsd > 0)) throw new RecorderBudgetError("AI_RECORDER_ALLOWANCE_USD must be a positive number");
    // One allowance across every process and every attempt of a recording run:
    // what an earlier attempt committed stays committed, never a fresh start.
    if (ledgerFile && fs.existsSync(ledgerFile)) {
      const prior = JSON.parse(fs.readFileSync(ledgerFile, "utf8")) as { committedUsd: number; reused?: number; lines: LedgerLine[] };
      this.committedUsd = prior.committedUsd;
      this.reusedCount = prior.reused ?? 0;
      this.lines.push(...prior.lines);
    }
  }

  private persist(): void {
    if (!this.ledgerFile) return;
    fs.writeFileSync(this.ledgerFile, JSON.stringify({ limitUsd: this.limitUsd, committedUsd: this.committedUsd, reused: this.reusedCount, lines: this.lines }, null, 2));
  }

  /** Reserve `usd` or refuse. Returns the line to settle. */
  reserve(kind: RecordingKind, target: string, usd: number | null): LedgerLine {
    if (usd === null || !Number.isFinite(usd)) {
      this.lines.push({ kind, target, reservedUsd: 0, actualUsd: null, outcome: "refused" });
      this.persist();
      throw new RecorderBudgetError(`no known price for ${kind} ${target}`);
    }
    if (this.committedUsd + usd > this.limitUsd + 1e-9) {
      this.lines.push({ kind, target, reservedUsd: usd, actualUsd: null, outcome: "refused" });
      this.persist();
      throw new RecorderBudgetError(
        `${kind} ${target} needs $${usd.toFixed(4)} but only $${(this.limitUsd - this.committedUsd).toFixed(4)} of $${this.limitUsd.toFixed(2)} remains`,
      );
    }
    this.committedUsd += usd;
    const line: LedgerLine = { kind, target, reservedUsd: usd, actualUsd: null, outcome: "ok" };
    this.lines.push(line);
    this.persist();
    return line;
  }

  /** Settle to actual usage when it is known; otherwise keep the reservation. */
  settle(line: LedgerLine, actualUsd: number | null, ok: boolean): void {
    line.outcome = ok ? "ok" : "error";
    if (actualUsd !== null && ok) {
      const actual = Math.min(actualUsd, line.reservedUsd);
      this.committedUsd -= line.reservedUsd - actual;
      line.actualUsd = actual;
    }
    this.persist();
  }

  get committed(): number {
    return this.committedUsd;
  }

  /** Count a request answered from a recording already on disk. */
  noteReused(): void {
    this.reusedCount += 1;
    this.persist();
  }

  get reused(): number {
    return this.reusedCount;
  }
}

function chatReservationUsd(params: Record<string, any>): number | null {
  const price = OPENAI_PRICES[params.model];
  if (!price) return null;
  const outputCap = params.max_completion_tokens ?? params.max_tokens;
  if (typeof outputCap !== "number") return null;
  // Two characters per token over-counts English and JSON (about four), so the input side is conservative.
  const inputTokens = Math.ceil(JSON.stringify({ m: params.messages, f: params.response_format ?? null }).length / 2);
  return (inputTokens * price.input + outputCap * price.output) / 1e6;
}

function chatActualUsd(params: Record<string, any>, response: any): number | null {
  const price = OPENAI_PRICES[params.model];
  const u = response?.usage;
  if (!price || typeof u?.prompt_tokens !== "number" || typeof u?.completion_tokens !== "number") return null;
  return (u.prompt_tokens * price.input + u.completion_tokens * price.output) / 1e6;
}

// ---------------------------------------------------------------------------
// Writing recordings
// ---------------------------------------------------------------------------

const urlSubstitutes = new Map<string, string>();
let idCounter = 0;

function substituteUrls<T>(value: T): T {
  if (urlSubstitutes.size === 0) return value;
  let text = JSON.stringify(value);
  for (const [real, sub] of urlSubstitutes) text = text.split(real).join(sub);
  return JSON.parse(text) as T;
}

function scrubIds(response: any): any {
  if (!response || typeof response !== "object") return response;
  const out = structuredClone(response);
  if (typeof out.id === "string") out.id = `recorded-${++idCounter}`;
  if (typeof out.requestId === "string") out.requestId = `recorded-${++idCounter}`;
  if (typeof out.request_id === "string") out.request_id = `recorded-${++idCounter}`;
  return out;
}

export interface RecorderContext {
  clients: Record<string, string>;
}

/** The HTTP status of a vendor's own rejection (4xx/5xx), or null for anything else: a budget refusal, a transport failure. */
function vendorStatus(err: unknown): number | null {
  const status = Number((err as { status?: unknown })?.status);
  return Number.isInteger(status) && status >= 400 && status < 600 ? status : null;
}

function write(kind: RecordingKind, target: string, request: unknown, outcome: { response?: unknown; error?: any }, ctx: RecorderContext): void {
  // Only a vendor's own answer is a recording. A failure with no vendor status
  // (the network, a timeout) is not, and replaying it would raise the wrong
  // error class, so it is never written.
  if (outcome.error && vendorStatus(outcome.error) === null) return;
  const req = substituteUrls(request);
  const print = fingerprint(kind, req);
  const rec: Recording = {
    kind,
    request: normaliseRequest(req),
    fingerprint: print,
    recordedAt: new Date().toISOString(),
    clients: ctx.clients,
    target,
  };
  if (outcome.error) {
    const e = outcome.error;
    rec.error = {
      name: e?.name === "ValidationError" || e?.name === "ApiError" ? e.name : "APIError",
      message: String(e?.message ?? e),
      status: vendorStatus(e)!,
      body: e?.body ?? e?.error ?? null,
    };
  } else {
    rec.response = outcome.response;
  }
  const dir = recordingsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, recordingFileName(kind, print)), JSON.stringify(rec, null, 2) + "\n");
  resetRecordingCache();
}

/** Replace each generated image URL with a small PNG data URL, remembering the substitution. */
async function localiseImages(result: any): Promise<any> {
  const out = structuredClone(result);
  const images: any[] = out?.data?.images ?? (out?.data?.image ? [out.data.image] : []);
  for (const img of images) {
    if (typeof img?.url !== "string" || img.url.startsWith("data:")) continue;
    const res = await fetch(img.url);
    if (!res.ok) throw new Error(`[ai-recorder] could not fetch generated image (${res.status})`);
    const png = await sharp(Buffer.from(await res.arrayBuffer())).resize(96, 96, { fit: "inside" }).png().toBuffer();
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    urlSubstitutes.set(img.url, dataUrl);
    img.url = dataUrl;
    if ("content_type" in img) img.content_type = "image/png";
  }
  return out;
}

// ---------------------------------------------------------------------------
// The wrappers
// ---------------------------------------------------------------------------

/**
 * A request already recorded (by an earlier attempt of this run, or in the
 * corpus a `--resume` run tops up) is answered from its recording rather than
 * paid for again, so a recording run that stopped part-way resumes without
 * re-spending. The recording script refuses a non-empty output directory
 * unless `--resume` is passed, so this reuse is always asked for (#654 round 2).
 */
function alreadyRecorded(kind: RecordingKind, target: string, request: unknown): unknown | undefined {
  try {
    const rec = findRecording(kind, target, substituteUrls(request));
    return rec.response === undefined ? undefined : structuredClone(rec.response);
  } catch (err) {
    if (err instanceof NoRecordingError) return undefined;
    throw err;
  }
}

export function recordingFal(
  real: FalLike,
  allowance: Allowance,
  ctx: RecorderContext,
  falUnitPrice: (endpoint: string) => Promise<number | null>,
): FalLike {
  return {
    async subscribe(endpoint, opts) {
      const request = falSubscribeRequest(endpoint, opts);
      const prior = alreadyRecorded("fal.subscribe", endpoint, request);
      if (prior !== undefined) {
        allowance.noteReused();
        return prior;
      }
      const unit = await falUnitPrice(endpoint);
      const line = allowance.reserve("fal.subscribe", endpoint, unit === null ? null : unit * FAL_SUBMISSION_ATTEMPTS);
      try {
        const result = await real.subscribe(endpoint, opts);
        // Usage is one billed generation per completed call; the retries the SDK may have made are not observable.
        allowance.settle(line, null, true);
        const localised = await localiseImages(result);
        write("fal.subscribe", endpoint, request, { response: scrubIds(localised) }, ctx);
        // The application keeps the real URL for this run; only the recording carries the substitute.
        return result;
      } catch (err) {
        allowance.settle(line, null, false);
        write("fal.subscribe", endpoint, request, { error: err }, ctx);
        throw err;
      }
    },
    storage: {
      async upload(file, opts) {
        const request = await falUploadRequest(file);
        const url = await real.storage.upload(file, opts);
        urlSubstitutes.set(url, falUploadUrl(request.sha256));
        write("fal.storage.upload", "storage", request, { response: falUploadUrl(request.sha256) }, ctx);
        return url;
      },
    },
    queue: {
      submit() {
        throw new RecorderBudgetError("queue.submit is outside the recorded baseline");
      },
      status() {
        throw new RecorderBudgetError("queue.status is outside the recorded baseline");
      },
      result() {
        throw new RecorderBudgetError("queue.result is outside the recorded baseline");
      },
    },
    config(opts) {
      real.config(opts);
    },
  };
}

export function recordFalPricing(endpointId: string, body: unknown, ctx: RecorderContext): void {
  write("fal.pricing", endpointId, { endpoint: endpointId }, { response: body }, ctx);
}

/** Wrap a real OpenAI client constructed with `maxRetries: 0`. */
export function recordingOpenAI<T extends Record<string, any>>(real: T, allowance: Allowance, ctx: RecorderContext): T {
  const wrap = (kind: RecordingKind, call: (p: any, o?: any) => Promise<any>, reserve: (p: any) => number | null, actual: (p: any, r: any) => number | null) =>
    async (params: any, options?: any) => {
      const prior = alreadyRecorded(kind, params.model, params);
      if (prior !== undefined) {
        allowance.noteReused();
        return prior;
      }
      const line = allowance.reserve(kind, params.model, reserve(params));
      try {
        const response = await call(params, options);
        allowance.settle(line, actual(params, response), true);
        write(kind, params.model, params, { response: scrubIds(response) }, ctx);
        return response;
      } catch (err) {
        allowance.settle(line, null, false);
        write(kind, params.model, params, { error: err }, ctx);
        throw err;
      }
    };
  const embedReserve = (p: any) => {
    const price = OPENAI_PRICES[p.model];
    return price ? (Math.ceil(JSON.stringify(p.input).length / 2) * price.input) / 1e6 : null;
  };
  const embedActual = (p: any, r: any) => {
    const price = OPENAI_PRICES[p.model];
    return price && typeof r?.usage?.prompt_tokens === "number" ? (r.usage.prompt_tokens * price.input) / 1e6 : null;
  };
  return {
    chat: { completions: { create: wrap("openai.chat", (p, o) => real.chat.completions.create(p, o), chatReservationUsd, chatActualUsd) } },
    embeddings: { create: wrap("openai.embeddings", (p, o) => real.embeddings.create(p, o), embedReserve, embedActual) },
    responses: {
      create: async () => {
        throw new RecorderBudgetError("responses.create is outside the recorded baseline");
      },
    },
  } as unknown as T;
}

/**
 * Whether a deliberately invalid request left the vendor's own rejection of it
 * recorded: the error it threw carries exactly the status the probe expects
 * (the validation rejection it was designed to capture), and an error
 * recording for that kind and target with that status is now on disk. A
 * budget refusal, a transport failure, an authentication or throttling error,
 * or a vendor accepting the request is not a captured failure control, and
 * the recording run must say so (#654 rounds 1 and 2).
 */
export function vendorRejectionCaptured(kind: RecordingKind, target: string, err: unknown, expectedStatus: number): boolean {
  if (vendorStatus(err) !== expectedStatus) return false;
  resetRecordingCache();
  return allRecordings().some((r) => r.kind === kind && r.target === target && r.error?.status === expectedStatus);
}
