/**
 * Tier-1 source-image classifier — fal-hosted detector.
 *
 * Calls the configured Phase 2 detector engine (default: fal-yolo-world; see
 * `getImageClassifierEngineId` in `imagePromptConfig.ts`) and returns a flat
 * list of detections. The Tier-2 heuristics map detections → SourceSubjectKind.
 *
 * Engine swap path: the active classifier engine id lives in admin_config
 * under `fact_source_classifier_engine_id`. Add new detector engines to the
 * catalogue (per the engine-workbench plumbing) and flip the key to switch.
 *
 * NOTE on endpoint shape: fal's yolo-world endpoint accepts an image URL +
 * comma-separated class names and returns a `detections` array with label /
 * confidence / box. This module normalizes whatever the engine produces into
 * a `SourceImageDetection[]`. When wiring a new detector with a different
 * output shape, extend `normalizeDetections()` rather than touching callers.
 */

import { fal, ensureFalConfigured } from "../falClient";
import { loadEngine } from "../engineInterpreter";
import { logger } from "../logger";
import { getImageClassifierEngineId, DEFAULT_IMAGE_CLASSIFIER_ENGINE_ID } from "../imagePromptConfig";
import type { SourceImageDetection } from "@workspace/api-zod";

export interface Tier1Result {
  detections: SourceImageDetection[];
  engineId: string;
  durationMs: number;
}

export class Tier1DetectorError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "Tier1DetectorError";
  }
}

/**
 * Run the configured Tier-1 detector against an image URL. Throws on
 * fal/network failure; the analyzer's main loop catches and falls through
 * to Tier-3 AI vision (or surfaces detection_failed when AI is disabled).
 */
export async function runTier1Detector(imageUrl: string): Promise<Tier1Result> {
  ensureFalConfigured();
  const engineId = (await getImageClassifierEngineId()) || DEFAULT_IMAGE_CLASSIFIER_ENGINE_ID;
  const engine = await loadEngine(engineId);
  if (!engine) {
    throw new Tier1DetectorError(`source classifier engine "${engineId}" not found in catalogue`);
  }
  const startedAt = Date.now();
  try {
    // We pass the raw image URL + the engine's default class list (from
    // paramSchema). `loadEngine` returns the static defaults; the analyzer
    // doesn't override them in v1 — the detector's default vocabulary
    // covers the COCO-superset subject taxonomy we care about.
    const defaults = extractStaticDefaultsFromParamSchema(engine.paramSchema);
    const input: Record<string, unknown> = { image_url: imageUrl, ...defaults };
    const response = await fal.subscribe(engine.endpointId, { input, logs: false });
    const durationMs = Date.now() - startedAt;
    const raw = (response as { data?: unknown })?.data ?? response;
    const detections = normalizeDetections(raw);
    return { detections, engineId, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    logger.warn({ err, engineId, durationMs }, "[tier1FalDetector] fal call failed");
    throw new Tier1DetectorError(
      err instanceof Error ? err.message : `Tier-1 detector "${engineId}" failed`,
      err,
    );
  }
}

/**
 * Convert the engine's paramSchema defaults (those NOT bound to a `from`
 * field that the caller would supply) into a static input object. Lets us
 * call fal without re-implementing every detector's expected params in
 * code — the catalogue is the source of truth.
 */
function extractStaticDefaultsFromParamSchema(paramSchema: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!paramSchema || typeof paramSchema !== "object") return out;
  const params = (paramSchema as { params?: Array<{ name?: string; from?: string; default?: unknown }> }).params ?? [];
  for (const p of params) {
    if (!p.name) continue;
    // Skip the input image binding — we supply image_url directly.
    if (p.from === "imageUrl") continue;
    if (p.default !== undefined && p.default !== null) {
      out[p.name] = p.default;
    }
  }
  return out;
}

/**
 * Normalize a heterogeneous detector output into a flat detections list.
 * Different fal endpoints return slightly different shapes; this absorbs
 * the variance. When adding a new detector with a novel shape, extend
 * this function rather than special-casing call sites.
 */
function normalizeDetections(raw: unknown): SourceImageDetection[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  // YOLO-World-style: { detections: [{ label, confidence, box: { x, y, w, h }}], ... }
  if (Array.isArray(obj["detections"])) {
    return obj["detections"]
      .map((d) => normalizeOne(d))
      .filter((d): d is SourceImageDetection => d !== null);
  }
  // SAM-style: { masks: [...] } — unsupported for now; falls through to empty.
  if (Array.isArray(obj["results"])) {
    return obj["results"]
      .map((d) => normalizeOne(d))
      .filter((d): d is SourceImageDetection => d !== null);
  }
  return [];
}

function normalizeOne(raw: unknown): SourceImageDetection | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const label = typeof d["label"] === "string"
    ? d["label"]
    : typeof d["class"] === "string"
      ? d["class"]
      : typeof d["category"] === "string"
        ? d["category"]
        : null;
  if (!label) return null;
  const score = typeof d["score"] === "number"
    ? d["score"]
    : typeof d["confidence"] === "number"
      ? d["confidence"]
      : typeof d["probability"] === "number"
        ? d["probability"]
        : 0;
  const box = extractBox(d["box"] ?? d["bbox"] ?? d["bounding_box"]);
  return box ? { label, score, box } : { label, score };
}

function extractBox(raw: unknown): { x: number; y: number; width: number; height: number } | undefined {
  if (!raw) return undefined;
  if (typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  // Common shapes: { x, y, width, height } or { x, y, w, h } or [x, y, w, h] or { x1, y1, x2, y2 }.
  if (Array.isArray(raw) && raw.length >= 4) {
    return { x: Number(raw[0]), y: Number(raw[1]), width: Number(raw[2]), height: Number(raw[3]) };
  }
  if (typeof b["width"] === "number" && typeof b["height"] === "number") {
    return {
      x: Number(b["x"] ?? 0),
      y: Number(b["y"] ?? 0),
      width: Number(b["width"]),
      height: Number(b["height"]),
    };
  }
  if (typeof b["w"] === "number" && typeof b["h"] === "number") {
    return {
      x: Number(b["x"] ?? 0),
      y: Number(b["y"] ?? 0),
      width: Number(b["w"]),
      height: Number(b["h"]),
    };
  }
  if (typeof b["x1"] === "number" && typeof b["x2"] === "number") {
    const x1 = Number(b["x1"]);
    const y1 = Number(b["y1"] ?? 0);
    const x2 = Number(b["x2"]);
    const y2 = Number(b["y2"] ?? 0);
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }
  return undefined;
}
