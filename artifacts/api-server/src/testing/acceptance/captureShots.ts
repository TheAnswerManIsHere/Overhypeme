/**
 * The real-render capture run's pure parts (Launch Phase 2, increment 8, #631;
 * `docs/plans/PLAN_PHASE2_INC8_CAPTURE.md` D6, D7): the refusals
 * `scripts/acceptance-run.ts --mode capture` applies before anything is
 * created, and the shot writer, whose manifest line has exactly the shape the
 * browser capture kit writes (`artifacts/overhype-me/e2e/capture/captureKit.ts`,
 * `saveShot`), so one evidence store reads both.
 *
 * A capture that ran has proved only that an image exists; the UAT step's
 * result is Claude's reading of it (D2). The images are written full size and
 * unaltered: the recorder returns the vendor's original result to the
 * application and these are the bytes the API serves.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The approved per-run allowance (plan D7, amendment 1: $3.00, David 2026-10-16). */
export const CAPTURE_ALLOWANCE_CAP_USD = 3;

/**
 * The real-render captures, by the UAT doc they answer, with the shots each
 * one must produce. A capture run drives exactly one doc (`--doc`), as `/uat`
 * runs one doc, so one doc's failure or spend never reaches another's run and
 * its evidence fits the declared `<UAT doc stem>/...` directory (#708 round 1,
 * 4291262774).
 */
export const CAPTURE_DOCS = {
  PR229_BUBBLE_CONTROLS_UAT: ["pr229-s6-render"],
} as const satisfies Record<string, readonly string[]>;

export type CaptureDoc = keyof typeof CAPTURE_DOCS;

export function isCaptureDoc(v: string | undefined): v is CaptureDoc {
  return v !== undefined && Object.hasOwn(CAPTURE_DOCS, v);
}

export interface ShotMeta {
  /** The UAT doc's filename stem, e.g. PR229_BUBBLE_CONTROLS_UAT: `docs/tests/UAT/<doc>.md` exists, and the evidence store files the shot under it. */
  doc: string;
  /** The step id within the doc. */
  step: string;
  /** What the image shows, in the words a reader checks it against. */
  shows: string;
}

export interface ManifestLine extends ShotMeta {
  shot: string;
  file: string;
  commit: string;
  sha256: string;
  bytes: number;
}

/** One manifest line, keys in the capture kit's order. */
export function manifestLine(shot: string, file: string, meta: ShotMeta, commit: string, bytes: Buffer): ManifestLine {
  return {
    shot,
    file,
    doc: meta.doc,
    step: meta.step,
    shows: meta.shows,
    commit,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

/** The file extension for a decoded image format (`sharp`'s name). */
export function extForFormat(format: string): string {
  return format === "jpeg" ? "jpg" : format;
}

/** Write one shot, unaltered, and append its manifest line. Refuses an empty image, as the kit does. */
export function writeShot(dir: string, shot: string, bytes: Buffer, format: string, meta: ShotMeta, commit: string): ManifestLine {
  if (bytes.length <= 1000) throw new Error(`shot ${shot} is ${bytes.length} bytes; an image is expected`);
  const file = `${shot}.${extForFormat(format)}`;
  fs.writeFileSync(path.join(dir, file), bytes);
  const line = manifestLine(shot, file, meta, commit, bytes);
  fs.appendFileSync(path.join(dir, "manifest.jsonl"), JSON.stringify(line) + "\n");
  return line;
}

export interface CaptureRunArgs {
  env: NodeJS.ProcessEnv;
  /** `--allowance`, as given. */
  allowance: string | undefined;
  /** `--allowance-raised-by-david`, as given. */
  raisedBy: string | undefined;
  /** `--out`, as given. */
  out: string | undefined;
  /** `--doc`, as given: the one UAT doc this run captures. */
  doc: string | undefined;
  variant: string;
  control: string | undefined;
}

/** Why a capture run must not start; empty when it may. Reads the filesystem only to check `--out`. */
export function captureRefusals(a: CaptureRunArgs): string[] {
  const refusals: string[] = [];
  if (a.env.CI) refusals.push("the capture run never runs in CI");
  if (!(a.env.FAL_AI_API_KEY || a.env.FAL_KEY) || !a.env.OPENAI_API_KEY) refusals.push("capture mode needs FAL_AI_API_KEY (or FAL_KEY) and OPENAI_API_KEY");
  if (a.variant !== "fixture") refusals.push("the capture run uses the fixture variant only: pass --variant fixture or omit it");
  if (a.control !== undefined) refusals.push("a capture run takes no --control");
  const allowance = Number(a.allowance);
  if (a.allowance === undefined || a.allowance === "") refusals.push("capture mode needs --allowance <usd>, the approved spending ceiling");
  else if (!(allowance > 0)) refusals.push("--allowance must be a positive dollar amount");
  else if (allowance > CAPTURE_ALLOWANCE_CAP_USD && !/^\d{4}-\d{2}-\d{2}$/.test(a.raisedBy ?? "")) {
    refusals.push(`the capture run's cap is $${CAPTURE_ALLOWANCE_CAP_USD.toFixed(2)} per run (plan D7, amendment 1, David, 2026-10-16); a higher --allowance needs --allowance-raised-by-david <YYYY-MM-DD>`);
  }
  if (!isCaptureDoc(a.doc)) {
    refusals.push(`capture mode needs --doc <UAT doc stem>, one of: ${Object.keys(CAPTURE_DOCS).join(", ")}${a.doc === undefined ? "" : ` (got ${a.doc})`}`);
  }
  if (!a.out) refusals.push("capture mode needs --out <dir>, an empty directory for the images and their manifest");
  else if (fs.existsSync(a.out)) {
    if (!fs.statSync(a.out).isDirectory()) refusals.push(`--out ${a.out} is not a directory`);
    else if (fs.readdirSync(a.out).length > 0) refusals.push(`--out ${a.out} is not empty; a capture run writes into an empty directory`);
  }
  return refusals;
}
