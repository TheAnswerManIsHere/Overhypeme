import { useCallback, useState } from "react";

export type UploadStatus = "idle" | "previewing" | "uploading" | "moderating" | "ready" | "error";

export type UploadError = "too-large" | "invalid-format" | "rejected" | "network";

export interface UploadedImage {
  objectPath: string;
  width: number;
  height: number;
  isLowRes: boolean;
  fileSizeBytes: number;
  /** Local blob URL for instant preview before/after upload. */
  previewBlobUrl: string;
}

interface State {
  status: UploadStatus;
  error: UploadError | null;
  image: UploadedImage | null;
  progress: number;
}

const INITIAL: State = { status: "idle", error: null, image: null, progress: 0 };

const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 15 * 1024 * 1024;

/**
 * Wraps the existing `POST /api/storage/upload-meme` route. Maps server
 * statuses (200 / 413 / 415 / 422 / 503) to the four user-facing error
 * classes so the surrounding UI can show the right copy.
 *
 * The route runs the Phase-1 moderation pipeline (Arachnid + fal.ai NSFW
 * classifier) before returning. We treat the round-trip as one "uploading"
 * phase from the user's POV — moderation is server-side and synchronous.
 */
export function useUploadModeration() {
  const [state, setState] = useState<State>(INITIAL);

  const reset = useCallback(() => setState(INITIAL), []);

  const upload = useCallback(async (file: File): Promise<UploadedImage | null> => {
    if (!ACCEPTED.has(file.type)) {
      setState({ status: "error", error: "invalid-format", image: null, progress: 0 });
      return null;
    }
    if (file.size > MAX_BYTES) {
      setState({ status: "error", error: "too-large", image: null, progress: 0 });
      return null;
    }

    const previewBlobUrl = URL.createObjectURL(file);
    setState({ status: "uploading", error: null, image: null, progress: 0 });

    try {
      const buffer = await file.arrayBuffer();
      const res = await fetch("/api/storage/upload-meme", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": file.type },
        body: buffer,
      });

      if (res.status === 413) {
        setState({ status: "error", error: "too-large", image: null, progress: 0 });
        URL.revokeObjectURL(previewBlobUrl);
        return null;
      }
      if (res.status === 415) {
        setState({ status: "error", error: "invalid-format", image: null, progress: 0 });
        URL.revokeObjectURL(previewBlobUrl);
        return null;
      }
      if (res.status === 422) {
        // Moderation rejection — never reveal classifier details.
        setState({ status: "error", error: "rejected", image: null, progress: 0 });
        URL.revokeObjectURL(previewBlobUrl);
        return null;
      }
      if (!res.ok) {
        setState({ status: "error", error: "network", image: null, progress: 0 });
        URL.revokeObjectURL(previewBlobUrl);
        return null;
      }

      const data = (await res.json()) as {
        objectPath: string;
        width: number;
        height: number;
        isLowRes: boolean;
        fileSizeBytes: number;
      };
      const image: UploadedImage = { ...data, previewBlobUrl };
      setState({ status: "ready", error: null, image, progress: 100 });
      return image;
    } catch {
      URL.revokeObjectURL(previewBlobUrl);
      setState({ status: "error", error: "network", image: null, progress: 0 });
      return null;
    }
  }, []);

  return { ...state, upload, reset };
}
