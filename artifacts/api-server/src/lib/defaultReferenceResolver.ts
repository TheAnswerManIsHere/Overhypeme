/**
 * Default reference-image resolver for moderation i2i test renders.
 *
 * The Step-2 visual-review grid renders i2i scenarios against canonical default
 * reference images (one per identity type). This module owns where those assets
 * live, how they're versioned, and how they become fal-fetchable URLs — reusing
 * the same lazy upload-to-fal seam the Engine workbench uses
 * (`adminEngines.getBundledTestFaceUrl`), generalized per asset.
 *
 * MALE is satisfied by the already-bundled `src/assets/test-face.jpg` — a real
 * 3088×2316 photograph (NOT the "1×1 placeholder" an old code comment claimed).
 * FEMALE / NON-HUMAN assets are dropped into `src/assets/render-references/`
 * (see that dir's README). Until an asset is present, its scenario fails
 * honestly with a clear "reference not configured" message — never a silent
 * low-quality render — and `referenceAssetHealth()` reports it missing.
 *
 * Server-side selection ONLY: routes never accept a client-supplied reference
 * URL for a default scenario.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReferenceIdentityType } from "@workspace/api-zod";
import { DEFAULT_REFERENCE_ASSET_VERSION } from "./factRenderScenarios";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, "../assets");
const REFERENCES_DIR = path.join(ASSETS_DIR, "render-references");

/** Files smaller than this are treated as broken/placeholder, not real references. */
const MIN_REAL_ASSET_BYTES = 4096;

export interface ReferenceAssetMeta {
  identityType: ReferenceIdentityType;
  /** Absolute path to the bundled asset file. */
  filePath: string;
  contentType: string;
  version: string;
  license: string;
  source: string;
}

/**
 * Canonical asset registry. MALE reuses the bundled Engine-workbench photo;
 * the rest are sourced into render-references/ (licensed/synthetic — see README).
 */
const REFERENCE_ASSETS: Record<ReferenceIdentityType, Omit<ReferenceAssetMeta, "version">> = {
  male: {
    identityType: "male",
    filePath: path.join(REFERENCES_DIR, "male.jpg"),
    contentType: "image/jpeg",
    license: "Project-owned (provided by David). Upright-normalized copy of the bundled Engine-workbench photo.",
    source: "src/assets/render-references/male.jpg",
  },
  female: {
    identityType: "female",
    filePath: path.join(REFERENCES_DIR, "female.jpg"),
    contentType: "image/jpeg",
    license: "Pending: licensed/synthetic asset to be provided.",
    source: "src/assets/render-references/female.jpg",
  },
  nonhuman_animal: {
    identityType: "nonhuman_animal",
    filePath: path.join(REFERENCES_DIR, "nonhuman-animal.jpg"),
    contentType: "image/jpeg",
    license: "Pending: licensed/synthetic asset to be provided.",
    source: "src/assets/render-references/nonhuman-animal.jpg",
  },
  nonhuman_object_vehicle: {
    identityType: "nonhuman_object_vehicle",
    filePath: path.join(REFERENCES_DIR, "nonhuman-object-vehicle.jpg"),
    contentType: "image/jpeg",
    license: "Pending: licensed/synthetic asset to be provided.",
    source: "src/assets/render-references/nonhuman-object-vehicle.jpg",
  },
};

export function referenceAssetMeta(identityType: ReferenceIdentityType): ReferenceAssetMeta {
  return { ...REFERENCE_ASSETS[identityType], version: DEFAULT_REFERENCE_ASSET_VERSION[identityType] ?? "1" };
}

/** Thrown when a scenario needs a default reference that isn't configured yet. */
export class ReferenceAssetUnavailableError extends Error {
  constructor(public identityType: ReferenceIdentityType, public detail: string) {
    super(`Default ${identityType} reference image not configured: ${detail}`);
    this.name = "ReferenceAssetUnavailableError";
  }
}

// Test seam: replace the fal upload so tests never hit the network.
type FalUpload = (bytes: Uint8Array, contentType: string) => Promise<string>;
let falUploadOverride: FalUpload | null = null;
export function __setReferenceFalUploadForTest(fn: FalUpload | null): void {
  falUploadOverride = fn;
  urlCache.clear();
}

// Memoized fal URL per (identityType@version) — the asset never changes within a version.
const urlCache = new Map<string, Promise<string>>();

async function statRealAsset(meta: ReferenceAssetMeta): Promise<number> {
  let size: number;
  try {
    size = (await fs.stat(meta.filePath)).size;
  } catch {
    throw new ReferenceAssetUnavailableError(meta.identityType, `missing file ${meta.source}`);
  }
  if (size < MIN_REAL_ASSET_BYTES) {
    throw new ReferenceAssetUnavailableError(
      meta.identityType,
      `file ${meta.source} is ${size}B — looks like a placeholder, not a real reference image`,
    );
  }
  return size;
}

async function uploadToFal(buf: Buffer, contentType: string): Promise<string> {
  if (falUploadOverride) return falUploadOverride(new Uint8Array(buf), contentType);
  const { fal, ensureFalConfigured } = await import("./falClient.js");
  ensureFalConfigured();
  return fal.storage.upload(new Blob([new Uint8Array(buf)], { type: contentType }));
}

/**
 * Resolve a fal-fetchable URL for a default reference image. Throws
 * `ReferenceAssetUnavailableError` when the asset is missing/placeholder so the
 * caller can record the scenario as failed BEFORE any paid render work.
 */
export async function resolveDefaultReferenceUrl(
  identityType: ReferenceIdentityType,
): Promise<{ url: string; version: string }> {
  const meta = referenceAssetMeta(identityType);
  const cacheKey = `${identityType}@${meta.version}`;
  let pending = urlCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      await statRealAsset(meta);
      const buf = await fs.readFile(meta.filePath);
      return uploadToFal(buf, meta.contentType);
    })().catch((err) => {
      urlCache.delete(cacheKey); // allow retry on a later request
      throw err;
    });
    urlCache.set(cacheKey, pending);
  }
  return { url: await pending, version: meta.version };
}

export interface ReferenceAssetHealth {
  identityType: ReferenceIdentityType;
  present: boolean;
  /** True when the file is missing or too small to be a real reference. */
  isPlaceholderOrMissing: boolean;
  bytes: number | null;
  version: string;
  license: string;
  source: string;
}

/**
 * Report per-identity-type readiness WITHOUT a network call (presence + size).
 * fal-fetchability is verified lazily on first `resolveDefaultReferenceUrl`.
 */
export async function referenceAssetHealth(): Promise<ReferenceAssetHealth[]> {
  const types = Object.keys(REFERENCE_ASSETS) as ReferenceIdentityType[];
  return Promise.all(
    types.map(async (identityType) => {
      const meta = referenceAssetMeta(identityType);
      let bytes: number | null = null;
      try {
        bytes = (await fs.stat(meta.filePath)).size;
      } catch {
        bytes = null;
      }
      const isPlaceholderOrMissing = bytes === null || bytes < MIN_REAL_ASSET_BYTES;
      return {
        identityType,
        present: bytes !== null,
        isPlaceholderOrMissing,
        bytes,
        version: meta.version,
        license: meta.license,
        source: meta.source,
      };
    }),
  );
}
