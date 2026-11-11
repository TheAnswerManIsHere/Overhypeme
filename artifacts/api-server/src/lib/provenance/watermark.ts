/**
 * @purpose The invisible watermark (plan docs/plans/PLAN_IMAGE_TRACING.md, increment 2): marks a composed picture's pixels with its provenance record id using Adobe's TrustMark Q, and reads an id back from any picture, so a meme traces to its record after its metadata has been stripped, it has been recompressed by a messaging app, resized by a social feed, or screenshotted.
 *
 * Marking follows TrustMark's reference encoder: the picture (or, past a 2:1 aspect ratio, its centre square) is
 * shrunk to 256x256, the network proposes a marked version, and only the difference — centred per colour channel
 * so no tint is added — is scaled back up and added to the full-resolution pixels. Reading shrinks the picture the
 * same way and asks the decoder network for 100 bits, then the BCH code in watermarkPayload.ts for the id.
 *
 * The models are Adobe's own ONNX exports, committed under src/assets/trustmark/ and checked against their pinned
 * hashes when loaded: a model that does not match is refused rather than producing marks nothing can read.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type { InferenceSession, Tensor } from "onnxruntime-node";
import { decodeWatermarkPayload, encodeWatermarkPayload } from "./watermarkPayload";

export const WATERMARK_SCHEME = "trustmark-q/bch5/v1";

/** The marker itself failed (a model missing or refused): a fault of the server, never of the picture. */
export class WatermarkError extends Error {
  constructor(readonly cause: unknown) {
    super(`watermark failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "WatermarkError";
  }
}

const S = 256;
const ASPECT_RATIO_LIM = 2.0;
const FEATHER = 50;
const MODELS = {
  encoder: { file: "encoder_Q.onnx", sha256: "19b3d1b25836130ffd78775a8f61539f993375d1823ef0e59ba5b8dffb4f892d" },
  decoder: { file: "decoder_Q.onnx", sha256: "ee3268f057c9dabef680e169302f5973d0589feea86189ed229a896cc3aa88df" },
} as const;

type Ort = typeof import("onnxruntime-node");
let ortPromise: Promise<Ort> | null = null;
const sessions = new Map<keyof typeof MODELS, Promise<InferenceSession>>();

/** src/assets in development and tests; the copy next to dist/ in a built server (build.mjs copies both). */
function modelDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "../assets/trustmark"), path.resolve(here, "../../assets/trustmark")];
  const found = candidates.find((dir) => existsSync(path.join(dir, MODELS.encoder.file)));
  if (!found) throw new Error(`TrustMark models not found (looked in ${candidates.join(", ")})`);
  return found;
}

function session(which: keyof typeof MODELS): Promise<InferenceSession> {
  let s = sessions.get(which);
  if (!s) {
    s = (async () => {
      ortPromise ??= import("onnxruntime-node").then((m) => (m as unknown as { default?: Ort }).default ?? (m as Ort));
      const ort = await ortPromise;
      const { file, sha256 } = MODELS[which];
      const bytes = readFileSync(path.join(modelDir(), file));
      const got = createHash("sha256").update(bytes).digest("hex");
      if (got !== sha256) throw new Error(`TrustMark ${file} does not match its pinned hash (got ${got})`);
      // The arena off: measured for #912, it saves about 40% of each model's resident memory at no measurable cost in speed.
      return ort.InferenceSession.create(bytes, { intraOpNumThreads: 2, interOpNumThreads: 1, enableCpuMemArena: false });
    })();
    s.catch(() => sessions.delete(which));
    sessions.set(which, s);
  }
  return s;
}

/**
 * Load the marker now rather than on the first meme (server start-up). The reader is loaded on the first trace
 * instead: only admins trace, and it is the larger of the two (measured for #912 with the memory arena off: the
 * marker adds about 140 MB to the server's memory, the reader about 200 MB more).
 */
export async function warmWatermarkMarker(): Promise<void> {
  await session("encoder");
}

/** The part of a w x h picture TrustMark works on: all of it, or the centre square past 2:1. */
function region(w: number, h: number): { left: number; top: number; width: number; height: number; square: boolean } {
  const aspect = Math.max(w, h) / Math.min(w, h);
  if (aspect <= ASPECT_RATIO_LIM) return { left: 0, top: 0, width: w, height: h, square: false };
  const side = Math.min(w, h);
  return { left: (w - side) >> 1, top: (h - side) >> 1, width: side, height: side, square: true };
}

/** 256x256 RGB of a region of raw pixels, planar and scaled to [-1, 1] as the networks expect. */
async function modelInput(raw: Buffer, w: number, h: number, channels: 3 | 4, r: ReturnType<typeof region>): Promise<Float32Array> {
  const small = await sharp(raw, { raw: { width: w, height: h, channels } })
    .extract({ left: r.left, top: r.top, width: r.width, height: r.height })
    .removeAlpha()
    .resize(S, S, { fit: "fill", kernel: "linear" })
    .raw()
    .toBuffer();
  const out = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) for (let c = 0; c < 3; c++) out[c * S * S + i] = (small[i * 3 + c] / 255) * 2 - 1;
  return out;
}

async function tensor(data: Float32Array, dims: number[]): Promise<Tensor> {
  ortPromise ??= import("onnxruntime-node").then((m) => (m as unknown as { default?: Ort }).default ?? (m as Ort));
  const ort = await ortPromise;
  return new ort.Tensor("float32", data, dims);
}

/**
 * Mark raw pixels in place with record `id`. `pixels` is RGB or RGBA, row-major, `channels` per pixel; alpha is
 * left alone. The change is invisible at normal viewing (measured in the plan's spike: no artefact a person could see).
 */
export async function watermarkPixels(pixels: Buffer | Uint8ClampedArray, width: number, height: number, channels: 3 | 4, id: number): Promise<void> {
  try {
    await mark(pixels, width, height, channels, id);
  } catch (err) {
    throw err instanceof WatermarkError ? err : new WatermarkError(err);
  }
}

async function mark(pixels: Buffer | Uint8ClampedArray, width: number, height: number, channels: 3 | 4, id: number): Promise<void> {
  const raw = Buffer.isBuffer(pixels) ? pixels : Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const r = region(width, height);
  const cover = await modelInput(raw, width, height, channels, r);
  const enc = await session("encoder");
  const out = await enc.run({
    [enc.inputNames[0]]: await tensor(cover, [1, 3, S, S]),
    [enc.inputNames[1]]: await tensor(Float32Array.from(encodeWatermarkPayload(id)), [1, 100]),
  });
  const stego = out[enc.outputNames[0]].data as Float32Array;

  // residual = clamp(stego) - cover, minus its per-channel mean (TrustMark removes colour shifts the same way)
  const res = new Float32Array(3 * S * S);
  for (let c = 0; c < 3; c++) {
    const b = c * S * S;
    let sum = 0;
    for (let i = 0; i < S * S; i++) {
      const v = Math.min(1, Math.max(-1, stego[b + i])) - cover[b + i];
      res[b + i] = v;
      sum += v;
    }
    const mean = sum / (S * S);
    for (let i = 0; i < S * S; i++) res[b + i] -= mean;
  }

  // Bilinear upsample to the region (half-pixel centres, as torch's align_corners=False), added in 0..255 units.
  const W = r.width, H = r.height;
  const x0 = new Int32Array(W), x1 = new Int32Array(W), wx = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const fx = Math.max(0, (x + 0.5) * (S / W) - 0.5);
    x0[x] = Math.floor(fx); x1[x] = Math.min(x0[x] + 1, S - 1); wx[x] = fx - x0[x];
  }
  const feather = r.square ? Math.max(1, Math.min(FEATHER, Math.floor(Math.min(W, H) * 0.1))) : 0;
  for (let y = 0; y < H; y++) {
    const fy = Math.max(0, (y + 0.5) * (S / H) - 0.5);
    const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, S - 1), wy = fy - y0;
    const rowAlpha = feather ? Math.min(1, (Math.min(y, H - 1 - y) + 1) / feather) : 1;
    let p = ((r.top + y) * width + r.left) * channels;
    for (let x = 0; x < W; x++, p += channels) {
      const alpha = feather ? rowAlpha * Math.min(1, (Math.min(x, W - 1 - x) + 1) / feather) : 1;
      const a = x0[x], bb = x1[x], fxw = wx[x];
      for (let c = 0; c < 3; c++) {
        const base = c * S * S;
        const top = res[base + y0 * S + a] + (res[base + y0 * S + bb] - res[base + y0 * S + a]) * fxw;
        const bot = res[base + y1 * S + a] + (res[base + y1 * S + bb] - res[base + y1 * S + a]) * fxw;
        const v = raw[p + c] + (top + (bot - top) * wy) * 127.5 * alpha;
        raw[p + c] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
      }
    }
  }
}

/** The 100 bits the decoder reads from a decoded picture's pixels (1 where its logit is above 0). */
async function readBits(raw: Buffer, w: number, h: number, channels: 3 | 4): Promise<number[]> {
  const input = await modelInput(raw, w, h, channels, region(w, h));
  const dec = await session("decoder");
  const out = await dec.run({ [dec.inputNames[0]]: await tensor(input, [1, 3, S, S]) });
  return Array.from(out[dec.outputNames[0]].data as Float32Array, (v) => (v > 0 ? 1 : 0));
}

/** Bounds of a picture without uniform bars around it (a screenshot's or a letterbox's), or null when there are none. */
function contentBox(raw: Buffer, w: number, h: number, channels: number): { left: number; top: number; width: number; height: number } | null {
  const at = (x: number, y: number) => (y * w + x) * channels;
  const same = (p: number, q: number) =>
    Math.abs(raw[p] - raw[q]) <= 12 && Math.abs(raw[p + 1] - raw[q + 1]) <= 12 && Math.abs(raw[p + 2] - raw[q + 2]) <= 12;
  const corner = at(0, 0);
  const rowBlank = (y: number) => { for (let x = 0; x < w; x++) if (!same(at(x, y), corner)) return false; return true; };
  const colBlank = (x: number, t: number, b: number) => { for (let y = t; y <= b; y++) if (!same(at(x, y), corner)) return false; return true; };
  let top = 0, bottom = h - 1;
  while (top < bottom && rowBlank(top)) top++;
  while (bottom > top && rowBlank(bottom)) bottom--;
  let left = 0, right = w - 1;
  while (left < right && colBlank(left, top, bottom)) left++;
  while (right > left && colBlank(right, top, bottom)) right--;
  const width = right - left + 1, height = bottom - top + 1;
  if (width === w && height === h) return null;
  if (width < 64 || height < 64) return null;
  return { left, top, width, height };
}

export interface WatermarkReading {
  id: number;
  /** Bits the error-correcting code repaired (0-5): how worn the mark was. */
  corrected: number;
  /** True when the id was read only after cutting away uniform bars round the picture. */
  trimmed: boolean;
}

/** Read a record id from a picture file, as it is and then with any uniform bars cut away. null when no mark is found. */
export async function readWatermark(file: Buffer): Promise<WatermarkReading | null> {
  const { data, info } = await sharp(file, { failOn: "none" }).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  if (w < 32 || h < 32) return null;
  const direct = decodeWatermarkPayload(await readBits(data, w, h, 3));
  if (direct) return { ...direct, trimmed: false };
  const box = contentBox(data, w, h, 3);
  if (!box) return null;
  const cropped = await sharp(data, { raw: { width: w, height: h, channels: 3 } }).extract(box).raw().toBuffer();
  const trimmed = decodeWatermarkPayload(await readBits(cropped, box.width, box.height, 3));
  return trimmed ? { ...trimmed, trimmed: true } : null;
}
