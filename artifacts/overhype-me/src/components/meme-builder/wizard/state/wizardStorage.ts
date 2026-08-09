/**
 * sessionStorage-backed capture/restore for the MBFO wizard's in-progress state.
 *
 * Sibling to `meme-builder/state/pendingBuilderState.ts` (schemaVersion 1, used
 * by the Phase-3 single-screen builder). This is schemaVersion 2 with a
 * separate key prefix so the two coexist without collision while the Phase-3
 * builder is still in production behind the wizard flag.
 *
 * 1-hour TTL, factId-scoped. Generation status is intentionally NOT persisted
 * — it is reconstructed from the server on remount.
 */

import type {
  AspectRatio,
  EntryFlow,
  MemeTextOptions,
  Mode,
  MyImageSource,
} from "../../types";

export type ArtifactType = "image" | "video";
export type WizardStep = 1 | 2;

export interface FramingOffset {
  x: number;
  y: number;
}

export type VideoSourceMode =
  | "stylize-then-video"
  | "use-photo-as-is"
  | "use-existing-ai-image";

export interface WizardAdvancedOptions {
  /** Image engine id (e.g. "fal-ai/flux-pulid"). Populated in later phases. */
  imageEngineId?: string;
  /** Video engine id (e.g. "xai/grok-imagine-video/image-to-video"). */
  videoEngineId?: string;
  /** Video length in seconds. */
  videoLengthSeconds?: number;
  /** Video resolution label (e.g. "480p", "720p"). */
  videoResolution?: string;
  /** How the source still is produced (defaults to "stylize-then-video"). */
  videoSourceMode?: VideoSourceMode;
  /** Look style id (server-driven catalogue, defaults to "cinematic"). */
  videoLookStyleId?: string;
  /** Motion preset id (server-driven catalogue, null = generic baseline). */
  videoMotionPresetId?: string | null;
  /** Engine mode (e.g. "normal", "fun", "custom"); shown when engine supports modes. */
  videoEngineMode?: string;
  /** Custom motion-prompt direction; only used when engineMode === "custom". */
  videoCustomModePrompt?: string;
  /** Override toggle: when source is pre-stylized AI, use a different style for the video. */
  videoOverrideLookForSource?: boolean;
}

export interface PendingWizardState {
  schemaVersion: 2;
  capturedAt: number;
  factId: string;
  entryFlow: EntryFlow;
  currentStep: WizardStep;
  artifactType: ArtifactType | null;
  mode?: Mode;
  source?:
    | { kind: "stock"; stockImageId: string }
    | { kind: "self-upload"; image: MyImageSource; stylizeWithAi: boolean };
  aspectRatio?: AspectRatio;
  framingOffset?: FramingOffset;
  name?: string;
  pronouns?: string;
  textOptions?: MemeTextOptions;
  advancedOptions?: WizardAdvancedOptions;
  /**
   * Gallery visibility for the meme this draft will save (Legendary-only;
   * lower tiers are forced public server-side). Absent on drafts captured
   * before this field existed — consumers default to `true`, matching both the
   * server default and the pre-restore state of the control.
   */
  isPublic?: boolean;
}

const KEY_PREFIX = "pending_meme_wizard_v2::";
const TTL_MS = 60 * 60 * 1000;

function key(factId: string): string {
  return `${KEY_PREFIX}${factId}`;
}

function isStorageAvailable(): boolean {
  try {
    return typeof window !== "undefined" && "sessionStorage" in window;
  } catch {
    return false;
  }
}

export function captureWizardState(state: PendingWizardState): void {
  if (!isStorageAvailable()) return;
  try {
    window.sessionStorage.setItem(key(state.factId), JSON.stringify(state));
  } catch {
    // Quota / private mode — silently skip; user loses their draft.
  }
}

export function restoreWizardState(factId: string): PendingWizardState | null {
  if (!isStorageAvailable()) return null;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(key(factId));
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearWizardState(factId);
    return null;
  }

  if (!isPendingWizardState(parsed)) {
    clearWizardState(factId);
    return null;
  }

  if (Date.now() - parsed.capturedAt > TTL_MS) {
    clearWizardState(factId);
    return null;
  }

  return parsed;
}

export function clearWizardState(factId: string): void {
  if (!isStorageAvailable()) return;
  try {
    window.sessionStorage.removeItem(key(factId));
  } catch {
    // Ignore.
  }
}

/**
 * Clear every persisted wizard draft, regardless of factId. Call this on
 * auth transitions (login/logout) so an in-progress draft created by one
 * viewer can never leak into another viewer's session.
 */
export function clearAllWizardStates(): void {
  if (!isStorageAvailable()) return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const k = window.sessionStorage.key(i);
      if (k && k.startsWith(KEY_PREFIX)) keysToRemove.push(k);
    }
    for (const k of keysToRemove) {
      window.sessionStorage.removeItem(k);
    }
  } catch {
    // Ignore.
  }
}

function isPendingWizardState(v: unknown): v is PendingWizardState {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.schemaVersion !== 2) return false;
  if (typeof o.capturedAt !== "number") return false;
  if (typeof o.factId !== "string") return false;
  if (typeof o.entryFlow !== "string") return false;
  if (o.currentStep !== 1 && o.currentStep !== 2) return false;
  if (
    o.artifactType !== null &&
    o.artifactType !== "image" &&
    o.artifactType !== "video"
  ) {
    return false;
  }
  return true;
}
