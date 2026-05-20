/**
 * Typed clients for the server catalogues that drive Step 2 (video):
 *  - GET /api/look-styles
 *  - GET /api/motion-presets
 *  - GET /api/engines?kind=video
 *
 * Each fetcher is a plain async function; the hook layer (`useVideoCatalogue`)
 * wraps them with loading/error state.
 */

export interface LookStyleDTO {
  id: string;
  label: string;
  description?: string;
  previewImagePath?: string | null;
  sortOrder: number;
}

export interface MotionPresetDTO {
  id: string;
  label: string;
  description?: string;
  cameraMotion?: string;
  motionIntensity?: string;
  previewGifPath?: string | null;
  sortOrder: number;
  gradientFrom?: string | null;
  gradientTo?: string | null;
}

export interface VideoEngineDTO {
  id: string;
  label: string;
  description?: string;
  allowedDurationsSec: number[];
  defaultDurationSec: number;
  allowedResolutions: string[];
  defaultResolution: string;
  allowedAspectRatios: ("landscape" | "square" | "portrait")[];
  defaultAspectRatio: "landscape" | "square" | "portrait";
  supportedModes?: { id: string; label: string }[];
  defaultMode?: string;
  audioHandling?: string;
  isDefault: boolean;
  sortOrder: number;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { credentials: "include", signal });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchLookStyles(signal?: AbortSignal): Promise<LookStyleDTO[]> {
  const body = await getJson<LookStyleDTO[] | { rows?: LookStyleDTO[] }>(
    "/api/look-styles",
    signal,
  );
  return Array.isArray(body) ? body : Array.isArray(body.rows) ? body.rows : [];
}

export async function fetchMotionPresets(signal?: AbortSignal): Promise<MotionPresetDTO[]> {
  const body = await getJson<MotionPresetDTO[] | { rows?: MotionPresetDTO[] }>(
    "/api/motion-presets",
    signal,
  );
  return Array.isArray(body) ? body : Array.isArray(body.rows) ? body.rows : [];
}

export async function fetchVideoEngines(signal?: AbortSignal): Promise<VideoEngineDTO[]> {
  const body = await getJson<VideoEngineDTO[] | { rows?: VideoEngineDTO[] }>(
    "/api/engines?kind=video",
    signal,
  );
  return Array.isArray(body) ? body : Array.isArray(body.rows) ? body.rows : [];
}
