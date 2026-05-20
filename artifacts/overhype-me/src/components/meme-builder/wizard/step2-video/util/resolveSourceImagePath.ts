/**
 * Resolves a `MyImageSource` (picker selection) to a concrete object path.
 *
 * `library` / `fresh` / `ai-styling` all carry their own objectPath. The
 * legacy `primary` discriminant was removed in task #507 — the user's
 * profile photo is now just a `library` entry tagged `is_profile=true`.
 */

import type { MyImageSource } from "../../../types";

export function resolveSourceImagePath(source: MyImageSource): string | null {
  switch (source.kind) {
    case "library":
    case "fresh":
    case "ai-styling":
      return source.objectPath;
  }
}

export function storageUrlFor(objectPath: string): string {
  return `/api/storage/objects${objectPath.replace(/^\/objects/, "")}`;
}
