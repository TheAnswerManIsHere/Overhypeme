/**
 * Loads a caption face in the browser from the same file the server draws
 * with, under the same internal family (names-and-fonts plan), and tracks
 * whether it is loading, ready or failed, so the preview draws only in the
 * face the saved meme will use and save and download wait until it has.
 *
 * Only the selected face is fetched; the others load when picked.
 *
 * @purpose Loads one caption font in the browser on demand (FontFace from public/fonts/caption under the catalogue's internal family) and exposes its loading, ready or failed status, with a retry, to the preview and the builders' save and download controls.
 * @subsystem meme-studio
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { captionFontById, type CaptionFontId } from "@workspace/api-zod";

export type CaptionFontStatus = "loading" | "ready" | "failed";

const status = new Map<CaptionFontId, CaptionFontStatus>();
const listeners = new Set<() => void>();

function set(id: CaptionFontId, next: CaptionFontStatus) {
  status.set(id, next);
  for (const l of listeners) l();
}

/** Start loading a face, unless it is loading or loaded already. A failed face loads again. */
export function loadCaptionFont(id: CaptionFontId): void {
  const current = status.get(id);
  if (current === "loading" || current === "ready") return;
  // Without the FontFace API (an old browser, or a test environment) there is
  // nothing to wait for: the canvas uses whatever the page has.
  if (typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) {
    set(id, "ready");
    return;
  }
  const font = captionFontById(id);
  set(id, "loading");
  const face = new FontFace(font.family, `url(/fonts/caption/${font.file}) format("truetype")`, { weight: String(font.weight) });
  face.load().then(
    (loaded) => {
      document.fonts.add(loaded);
      set(id, "ready");
    },
    () => set(id, "failed"),
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The selected face's status, loading it if needed, and a retry for a failed load. */
export function useCaptionFont(id: CaptionFontId): { status: CaptionFontStatus; retry: () => void } {
  useEffect(() => loadCaptionFont(id), [id]);
  const current = useSyncExternalStore<CaptionFontStatus>(subscribe, () => status.get(id) ?? "loading", () => "loading");
  const retry = useCallback(() => loadCaptionFont(id), [id]);
  return { status: current, retry };
}

/** Test seam: forget every face's status. */
export function resetCaptionFontsForTest(): void {
  status.clear();
}
