/**
 * Positive evidence per operation (Launch Phase 2, increment 6, #631; plan D6).
 *
 * The application falls back in several places — the classifier fails open
 * on an upload error under the fixture's configuration, a classifier response
 * without a recognised score reads as 0, hashtags, keywords and the duplicate
 * judge are best-effort — so a journey can complete while a vendor operation
 * it claims never produced a usable answer. This evaluator reads one record
 * line per AI call (the recorder's ledger in live mode, the double's call log
 * otherwise; the same shape), finds the response the call produced, applies
 * the product's own reader to it, and reports every expected operation as
 * satisfied or missing.
 *
 * Required operations are declared per mode and per variant, never derived
 * from the calls that happened: an expected call that is absent is a missing
 * row.
 */
import fs from "node:fs";
import path from "node:path";

import { falUploadUrl } from "../../lib/aiDouble/doubles";
import { SUGGEST_HASHTAGS_LIMIT, sanitizeHashtagsForPersistence } from "../../lib/hashtags";
import { extractNsfwScore } from "../../lib/moderation/nsfwClassifier";

export type Mode = "acceptance" | "replay" | "record" | "live";
export type Variant = "fresh" | "fixture";

/** One AI call, normalised from a ledger line or a call-log line. */
export interface CallRecord {
  kind: string;
  target: string;
  fingerprint?: string;
  ok: boolean;
  /** The outcome as the source wrote it. */
  outcome: string;
}

export interface Row {
  key: string;
  journey: string;
  description: string;
  status: "satisfied" | "missing" | "not-required";
  calls: number;
  detail: string;
}

interface Recorded {
  request?: any;
  response?: any;
}

interface Operation {
  key: string;
  journey: string;
  description: string;
  kind: string;
  target: RegExp;
  /** Which of this kind's calls are this operation, read from the recorded request. */
  matches: (req: any) => boolean;
  /** Whether the recorded response is a usable answer, read the way the product reads it. */
  usable: (res: any) => boolean;
  min: number;
  required: (mode: Mode, variant: Variant) => boolean;
}

const systemText = (req: any): string =>
  ((req?.messages ?? []) as Array<{ role: string; content: unknown }>).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
const content = (res: any): string => res?.choices?.[0]?.message?.content ?? "";
const parsesAsObject = (res: any): boolean => {
  try {
    const v = JSON.parse(content(res));
    return v !== null && typeof v === "object";
  } catch {
    return false;
  }
};
const always = () => true;

export function operations(photoSha256: string): Operation[] {
  return [
    { key: "tokenize", journey: "2", description: "the fact tokenizer", kind: "openai.chat", target: /./, matches: (r) => systemText(r).includes("fact-template tokenizer"), usable: (r) => content(r).trim().length > 0, min: 1, required: always },
    { key: "embedding", journey: "2", description: "the duplicate check's embedding", kind: "openai.embeddings", target: /./, matches: always, usable: (r) => Array.isArray(r?.data?.[0]?.embedding) && r.data[0].embedding.length > 0, min: 1, required: always },
    {
      key: "duplicate-judge",
      journey: "2",
      description: "the duplicate judge (only the fixture holds a near neighbour)",
      kind: "openai.chat",
      target: /./,
      matches: (r) => systemText(r).includes("You are a duplicate detector"),
      usable: (r) => {
        try {
          return typeof JSON.parse(content(r)).isDuplicate === "boolean";
        } catch {
          return false;
        }
      },
      min: 1,
      required: (_m, v) => v === "fixture",
    },
    {
      key: "hashtags",
      journey: "2",
      description: "the hashtag suggester",
      kind: "openai.chat",
      target: /./,
      matches: (r) => systemText(r).includes("You generate discovery hashtags"),
      // The product's own reader (routes/ai.ts suggestHashtagsForText): the
      // array through the same sanitizer and limit. An answer it reduces to no
      // suggestions is the product's fallback, not a usable value (plan D6).
      usable: (r) => {
        try {
          const tags = JSON.parse(content(r)).hashtags;
          return Array.isArray(tags) && sanitizeHashtagsForPersistence(tags, { limit: SUGGEST_HASHTAGS_LIMIT }).length > 0;
        } catch {
          return false;
        }
      },
      min: 1,
      required: always,
    },
    { key: "keywords", journey: "3", description: "the stock-photo keyword extractor", kind: "openai.chat", target: /./, matches: (r) => systemText(r).includes("You extract Pexels stock photo search keywords"), usable: parsesAsObject, min: 1, required: always },
    { key: "enrichment", journey: "3", description: "the fact enrichment classifier", kind: "openai.chat", target: /./, matches: (r) => systemText(r).includes("You are the fact enrichment classifier"), usable: parsesAsObject, min: 1, required: always },
    { key: "visual-concepts", journey: "3", description: "the Visual Concept ideator", kind: "openai.chat", target: /./, matches: (r) => systemText(r).includes("Visual-concept ideator"), usable: parsesAsObject, min: 1, required: always },
    { key: "image-prompts", journey: "3, 6", description: "the image-prompt generator (three review renders and one generation)", kind: "openai.chat", target: /./, matches: (r) => systemText(r).includes("render-time image-prompt generator"), usable: parsesAsObject, min: 4, required: always },
    {
      key: "image-renders",
      journey: "3, 6",
      description: "image generation (three review renders and one generation)",
      kind: "fal.subscribe",
      target: /^fal-ai\/nano-banana-2(\/edit)?$/,
      matches: (r) => typeof r?.input?.prompt === "string" && r.input.prompt.length > 0,
      usable: (r) => typeof (r?.data?.images?.[0]?.url ?? r?.data?.image?.url) === "string",
      min: 4,
      required: always,
    },
    { key: "reference-uploads", journey: "3", description: "reference images uploaded for the image-to-image renders", kind: "fal.storage.upload", target: /./, matches: (r) => r?.sha256 !== photoSha256, usable: always, min: 1, required: always },
    { key: "photo-upload", journey: "7", description: "the uploaded photo sent to the classifier's storage", kind: "fal.storage.upload", target: /./, matches: (r) => r?.sha256 === photoSha256, usable: always, min: 1, required: always },
    {
      key: "photo-classifier",
      journey: "7",
      description: "the NSFW classifier on the uploaded photo",
      kind: "fal.subscribe",
      target: /imageutils\/nsfw$/,
      matches: (r) => r?.input?.image_url === falUploadUrl(photoSha256),
      usable: (r) => extractNsfwScore(r) !== null,
      min: 1,
      required: always,
    },
  ];
}

/** The ledger's lines, or the double's call log, as call records. */
export function readCallRecords(file: string): CallRecord[] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8").trim();
  if (text.startsWith("{") && text.includes('"lines"')) {
    const ledger = JSON.parse(text) as { lines: Array<{ kind: string; target: string; fingerprint?: string; outcome: string }> };
    // A reused answer is a recording already on disk: usable evidence in a recording run, never present in a live one.
    return ledger.lines.map((l) => ({ kind: l.kind, target: l.target, fingerprint: l.fingerprint, ok: l.outcome === "ok" || l.outcome === "reused", outcome: l.outcome }));
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { kind: string; target: string; fingerprint?: string; outcome: string })
    .map((l) => ({ kind: l.kind, target: l.target, fingerprint: l.fingerprint, ok: l.outcome === "replayed", outcome: l.outcome }));
}

function recorded(dir: string, call: CallRecord): Recorded | null {
  if (!call.fingerprint) return null;
  const file = path.join(dir, `${call.kind}--${call.fingerprint}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Recorded;
}

/**
 * Every expected operation with its evidence. A call whose recording cannot
 * be found (no fingerprint, or a vendor error the recorder did not write)
 * cannot show a usable answer, so it never satisfies a row.
 */
/**
 * The calls no operation can claim because nothing was recorded for them: a
 * request the double had no recording for, or a vendor call that failed
 * before the recorder could write it. Reported once, beside the rows; such a
 * call can never satisfy one.
 */
export function unattributedCalls(opts: { calls: CallRecord[]; recordingsDir: string }): CallRecord[] {
  return opts.calls.filter((c) => c.kind !== "fal.pricing" && recorded(opts.recordingsDir, c) === null);
}

export function evaluateCoverage(opts: { mode: Mode; variant: Variant; calls: CallRecord[]; recordingsDir: string; photoSha256: string }): Row[] {
  const loaded = opts.calls.map((c) => ({ call: c, rec: recorded(opts.recordingsDir, c) }));
  return operations(opts.photoSha256).map((op) => {
    const mine = loaded.filter(({ call, rec }) => call.kind === op.kind && op.target.test(call.target) && rec !== null && op.matches(rec.request));
    const good = mine.filter(({ call, rec }) => call.ok && rec?.response !== undefined && op.usable(rec.response));
    const required = op.required(opts.mode, opts.variant);
    const satisfied = good.length >= op.min;
    const detail = `${good.length} usable of ${mine.length} attributed call(s), ${op.min} needed`;
    return {
      key: op.key,
      journey: op.journey,
      description: op.description,
      status: !required ? "not-required" : satisfied ? "satisfied" : "missing",
      calls: mine.length,
      detail,
    };
  });
}
