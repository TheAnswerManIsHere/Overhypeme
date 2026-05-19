/**
 * Single source-of-truth for meme-builder image sources.
 *
 * The picker UI, the live-preview hook, and the save/render request bodies
 * all derive from the same `BuilderImageSource` discriminated union. Adding a
 * new source kind means:
 *   1. Extend the union below.
 *   2. Add a branch to `resolveBackgroundUrl` (preview) and
 *      `toServerImageSource` (save / render).
 * The picker no longer dictates server contract; it just emits one of these
 * values via `onSelect`. The builder reducer stores it on state, and the
 * helpers below project it onto preview URLs and server-bound payloads.
 *
 * The corresponding server-side dispatch lives next to `composeMeme` in
 * `artifacts/api-server/src/lib/memeComposite.ts`, which uses an analogous
 * table keyed by `imageSource.type`.
 */

import type { Mode, MyImageSource } from "../types";
import type { BuilderInternalState } from "../state/useBuilderState";

export type BuilderImageSource =
  | { kind: "stock"; stockImageId: string; stockImageUrl: string | null }
  | MyImageSource;

/**
 * Reserved for future viewer-context plumbing. The `primaryImageObjectPath`
 * field was removed in task #507 — the profile photo is now just a library
 * entry tagged `is_profile=true` and is selected via the standard library
 * grid instead of a separate "primary" source kind.
 */
export interface BuilderViewerCtx {}

/**
 * Project the builder's reducer state onto the canonical source union. Returns
 * null when nothing is selected — callers should treat that as "no source yet"
 * (preview falls back to dark canvas, save bails).
 */
export function currentSource(
  state: Pick<BuilderInternalState, "stockImageId" | "stockImageUrl" | "myImage">,
  mode: Mode,
): BuilderImageSource | null {
  if (mode === "stock") {
    if (!state.stockImageId) return null;
    return {
      kind: "stock",
      stockImageId: state.stockImageId,
      stockImageUrl: state.stockImageUrl,
    };
  }
  return state.myImage;
}

/**
 * Resolve a source to a URL the live-preview canvas can `<img src>` against.
 * Returns null when no resolvable URL exists yet (e.g. stock photo selected
 * but URL not yet hydrated, or primary requested with no avatar on file).
 */
export function resolveBackgroundUrl(
  source: BuilderImageSource | null,
  _viewer: BuilderViewerCtx,
): string | null {
  if (!source) return null;
  switch (source.kind) {
    case "stock":
      return source.stockImageUrl;
    case "library":
    case "fresh":
    case "ai-styling":
      return toStorageUrl(source.objectPath);
  }
}

/**
 * The body shape POSTed to /api/memes, /api/render-preview, and
 * /api/render-download — must match the server's `ImageSourceSchema`.
 */
export type ServerImageSource =
  | { type: "stock"; pexelsPhotoId: number }
  | { type: "upload"; uploadKey: string };

/**
 * Project a source to the server-bound `imageSource` payload. Returns null
 * when the source cannot be saved (e.g. primary requested with no avatar).
 */
export function toServerImageSource(
  source: BuilderImageSource | null,
  _viewer: BuilderViewerCtx,
): ServerImageSource | null {
  if (!source) return null;
  switch (source.kind) {
    case "stock":
      return { type: "stock", pexelsPhotoId: parseInt(source.stockImageId, 10) };
    case "library":
    case "fresh":
    case "ai-styling":
      return { type: "upload", uploadKey: source.objectPath };
  }
}

/**
 * Resolve the storage object_path of a `self-upload` source — used by the
 * stylize flow which needs the upload key before deciding whether to call
 * the AI generator.
 */
export function selfUploadObjectPath(
  source: MyImageSource,
  _viewer: BuilderViewerCtx,
): string | null {
  return source.objectPath;
}

function toStorageUrl(objectPath: string): string {
  // Object paths are stored as `/objects/uploads/<uuid>.<ext>`. The auth-gated
  // delivery route is `/api/storage/objects/<rest>`.
  return `/api/storage/objects${objectPath.replace(/^\/objects/, "")}`;
}
