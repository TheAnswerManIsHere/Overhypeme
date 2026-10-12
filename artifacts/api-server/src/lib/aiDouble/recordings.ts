/**
 * The committed vendor recordings the AI double replays (Launch Phase 2,
 * increment 4, #631; design `docs/plans/PLAN_PHASE2_INC4_AI_DOUBLES.md` D4).
 *
 * Each recording is one request/response pair captured from the real vendor
 * by `AI_BACKEND=recorder` (`./recorder.ts`), never written by hand: the
 * plan's "shapes come from reality" rule. A pair is found again by the
 * fingerprint of its request (`./fingerprint.ts`), so a request the baseline
 * never made has no recording and fails visibly rather than reaching a vendor.
 *
 * One JSON file per pair, under `recordings/`, named `<kind>--<fingerprint>.json`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fingerprint } from "./fingerprint";

/** Which client operation a recording answers. */
export type RecordingKind =
  | "openai.chat"
  | "openai.embeddings"
  | "openai.responses"
  | "fal.subscribe"
  | "fal.storage.upload"
  | "fal.pricing";

/** A vendor error as the SDK raised it, kept so the double can raise the same shape. */
export interface RecordedError {
  /** `ApiError` (fal) or `APIError` (openai). */
  name: string;
  message: string;
  status: number;
  body: unknown;
}

export interface Recording {
  kind: RecordingKind;
  /** The request as fingerprinted: the normalised request the application sent. */
  request: unknown;
  fingerprint: string;
  /** Exactly one of `response` and `error`. */
  response?: unknown;
  error?: RecordedError;
  /** ISO time the vendor answered. */
  recordedAt: string;
  /** Client library versions the request went through, e.g. `{"@fal-ai/client": "1.9.5", "openai": "6.33.0"}`. */
  clients: Record<string, string>;
  /** The endpoint or model, for a reader; not part of the lookup. */
  target: string;
}

export function recordingsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.AI_RECORDINGS_DIR ?? "").trim();
  if (override) return override;
  return fileURLToPath(new URL("./recordings", import.meta.url));
}

export function recordingFileName(kind: RecordingKind, print: string): string {
  return `${kind}--${print}.json`;
}

/** Thrown when the double is asked for something no recording answers. */
export class NoRecordingError extends Error {
  constructor(
    readonly kind: RecordingKind,
    readonly target: string,
    readonly print: string,
  ) {
    super(`[ai-double] no recording for ${kind} ${target} (fingerprint ${print.slice(0, 12)}); record it with scripts/record-ai-baseline.ts`);
    this.name = "NoRecordingError";
  }
}

let cache: { dir: string; byFile: Map<string, Recording> } | null = null;

function load(dir: string): Map<string, Recording> {
  if (cache?.dir === dir) return cache.byFile;
  const byFile = new Map<string, Recording>();
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const rec = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Recording;
      byFile.set(name, rec);
    }
  }
  cache = { dir, byFile };
  return byFile;
}

/** Forget loaded recordings. Tests and the recorder call it after writing. */
export function resetRecordingCache(): void {
  cache = null;
}

/** The recording for this request, or a visible failure. */
export function findRecording(kind: RecordingKind, target: string, request: unknown): Recording {
  const print = fingerprint(kind, request);
  const rec = load(recordingsDir()).get(recordingFileName(kind, print));
  if (!rec) throw new NoRecordingError(kind, target, print);
  return rec;
}

/** All loaded recordings — for the recording-integrity test. */
export function allRecordings(): Recording[] {
  return [...load(recordingsDir()).values()];
}
