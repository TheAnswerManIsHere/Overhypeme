/**
 * sessionStorage-backed capture/restore for the MBFO wizard's in-progress state.
 *
 * Sibling to `meme-builder/state/pendingBuilderState.ts` (schemaVersion 1, used
 * by the meme page's remix builder), under a separate key prefix so the two
 * never collide. schemaVersion 3 dropped the artifact-type step with video
 * (launch Phase 4); a version-2 draft is discarded on restore.
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

export interface FramingOffset {
  x: number;
  y: number;
}

export interface WizardAdvancedOptions {
  /** Image engine id. Populated in later phases. */
  imageEngineId?: string;
}

export interface PendingWizardState {
  schemaVersion: 3;
  capturedAt: number;
  factId: string;
  entryFlow: EntryFlow;
  mode?: Mode;
  source?:
    | { kind: "stock"; stockImageId: string }
    | { kind: "self-upload"; image: MyImageSource };
  aspectRatio?: AspectRatio;
  framingOffset?: FramingOffset;
  name?: string;
  pronouns?: string;
  textOptions?: MemeTextOptions;
  advancedOptions?: WizardAdvancedOptions;
  /**
   * Gallery visibility for the meme this draft will save (Legendary-level by
   * default, or any tier an operator has granted `meme_private_visibility`
   * via Admin → Features; a caller with neither requesting `false` gets a
   * 403 from the save, not a silent downgrade). Absent on drafts captured
   * before this field existed — consumers default to `true`, matching both
   * the server default and the pre-restore state of the control.
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

  // Launch Phase 4, removal 3: AI styling went with PuLID. A draft that picked
  // an AI styling loses that pick (the user lands back on the picker); a draft
  // on an ordinary photo keeps it, without its stale stylize flag.
  if (parsed.source?.kind === "self-upload") {
    const legacy = parsed.source as { image: { kind: string }; stylizeWithAi?: boolean };
    if (legacy.image.kind === "ai-styling" || legacy.stylizeWithAi) {
      return { ...parsed, source: undefined };
    }
    return { ...parsed, source: { kind: "self-upload", image: parsed.source.image } };
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
  if (o.schemaVersion !== 3) return false;
  if (typeof o.capturedAt !== "number") return false;
  if (typeof o.factId !== "string") return false;
  if (typeof o.entryFlow !== "string") return false;
  return true;
}
