/**
 * sessionStorage-backed capture/restore for the MBFO wizard's in-progress state.
 *
 * Sibling to `meme-builder/state/pendingBuilderState.ts` (schemaVersion 1, used
 * by the meme page's remix builder), under a separate key prefix so the two
 * never collide. schemaVersion 3 dropped the artifact-type step with video
 * (launch Phase 4); a version-2 draft is discarded on restore.
 *
 * 1-hour TTL, factId-scoped. Leaving for the picture flow also keeps a return
 * snapshot (a day), and the flow hands a finished picture back through a
 * one-time hand-off (plan PLAN_PHASE7_AI_PICTURE_FLOW.md, *The builder*). Generation status is intentionally NOT persisted
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
    | { kind: "self-upload"; image: MyImageSource }
    /** One of the member's own AI pictures of this fact (launch Phase 7, increment 2). */
    | { kind: "ai-picture"; aiImageId: number; imageUrl: string };
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
  /** Where the caption splits into top and bottom text (word index). Absent means the fact's default. */
  splitIndex?: number;
  /**
   * True once the member has chosen the caption's name or pronouns themselves
   * (plan PLAN_PHASE7_AI_PICTURE_FLOW.md, *Name on the meme*). A chosen
   * identity is never replaced by the picture flow's default.
   */
  captionChosen?: boolean;
}

/**
 * A finished AI picture handed from the picture flow to the builder. The
 * builder applies its background, shape and caption over the restored draft
 * once, and nothing else.
 */
export interface PictureHandoff {
  factId: string;
  writtenAt: number;
  aiImageId: number;
  imageUrl: string;
  aspectRatio: AspectRatio;
  /** Null for a picture made before its caption was recorded: the builder's caption stays as it is. */
  caption: { name: string; pronouns: string | null; chosen: boolean } | null;
}

const KEY_PREFIX = "pending_meme_wizard_v2::";
const TTL_MS = 60 * 60 * 1000;
// The draft as the member left it for the picture flow: it outlives the
// ordinary draft's hour, for a day, and is cleared when they return or save.
const RETURN_PREFIX = "pending_meme_wizard_return::";
const RETURN_TTL_MS = 24 * 60 * 60 * 1000;
const HANDOFF_PREFIX = "pending_meme_wizard_handoff::";
const HANDOFF_TTL_MS = 60 * 60 * 1000;

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
  // Quota / private mode — silently skipped; the user loses their draft.
  writeItem(key(state.factId), state);
}

function readItem(storageKey: string): unknown {
  if (!isStorageAvailable()) return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    removeItem(storageKey);
    return null;
  }
}

function removeItem(storageKey: string): void {
  if (!isStorageAvailable()) return;
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // Ignore.
  }
}

function writeItem(storageKey: string, value: unknown): void {
  if (!isStorageAvailable()) return;
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Quota / private mode — silently skip.
  }
}

/** A stored draft, if it is one, of this fact and younger than `ttlMs`; anything else is removed. */
function readDraft(storageKey: string, factId: string, ttlMs: number): PendingWizardState | null {
  const parsed = readItem(storageKey);
  if (parsed == null) return null;
  if (!isPendingWizardState(parsed) || parsed.factId !== factId || Date.now() - parsed.capturedAt > ttlMs) {
    removeItem(storageKey);
    return null;
  }
  return migrateDraft(parsed);
}

export function restoreWizardState(factId: string): PendingWizardState | null {
  return readDraft(key(factId), factId, TTL_MS);
}

/** Keep the draft as the member leaves for the picture flow (plan, *The draft is complete*). */
export function captureReturnSnapshot(state: PendingWizardState): void {
  writeItem(`${RETURN_PREFIX}${state.factId}`, { ...state, capturedAt: Date.now() });
}

/** The draft as the member left it for the picture flow, if they did within the day. Read-only. */
export function readReturnSnapshot(factId: string): PendingWizardState | null {
  return readDraft(`${RETURN_PREFIX}${factId}`, factId, RETURN_TTL_MS);
}

/**
 * What the picture flow takes from the builder it was opened from: the
 * meme's shape, and the caption identity when the member chose it. Only this
 * module reads the draft's fields.
 */
export function readBuilderDefaults(factId: string): {
  aspectRatio: AspectRatio | null;
  chosenCaption: { name: string; pronouns: string | null } | null;
} {
  const d = readReturnSnapshot(factId);
  return {
    aspectRatio: d?.aspectRatio ?? null,
    chosenCaption: d?.captionChosen && d.name ? { name: d.name, pronouns: d.pronouns ?? null } : null,
  };
}

export function clearReturnSnapshot(factId: string): void {
  removeItem(`${RETURN_PREFIX}${factId}`);
}

export function writePictureHandoff(handoff: Omit<PictureHandoff, "writtenAt">): void {
  writeItem(`${HANDOFF_PREFIX}${handoff.factId}`, { ...handoff, writtenAt: Date.now() });
}

/** The picture the flow handed to this fact's builder, if one is waiting. Read-only. */
export function readPictureHandoff(factId: string): PictureHandoff | null {
  const storageKey = `${HANDOFF_PREFIX}${factId}`;
  const h = readItem(storageKey) as Partial<PictureHandoff> | null;
  if (h == null) return null;
  const valid = h.factId === factId && typeof h.writtenAt === "number" && Date.now() - h.writtenAt <= HANDOFF_TTL_MS
    && typeof h.aiImageId === "number" && typeof h.imageUrl === "string"
    && (h.aspectRatio === "landscape" || h.aspectRatio === "square" || h.aspectRatio === "portrait");
  if (!valid) {
    removeItem(storageKey);
    return null;
  }
  return h as PictureHandoff;
}

export function clearPictureHandoff(factId: string): void {
  removeItem(`${HANDOFF_PREFIX}${factId}`);
}

function migrateDraft(parsed: PendingWizardState): PendingWizardState {
  let draft: PendingWizardState = parsed;

  // Launch Phase 4, removal 6: stock photos went with Pexels. A draft that had
  // the stock source selected loses that pick (the user lands back on the
  // picker) and keeps everything else; a retired "stock" mode reads as the
  // only mode left.
  if ((draft.source as { kind?: string } | undefined)?.kind === "stock") {
    draft = { ...draft, source: undefined };
  }
  if (draft.mode !== undefined && (draft.mode as string) !== "self-upload") {
    draft = { ...draft, mode: "self-upload" };
  }

  // Launch Phase 4, removal 3: AI styling went with PuLID. A draft that picked
  // an AI styling loses that pick (the user lands back on the picker); a draft
  // on an ordinary photo keeps it, without its stale stylize flag.
  if (draft.source?.kind === "self-upload") {
    const legacy = draft.source as { image: { kind: string } };
    if (legacy.image.kind === "ai-styling") {
      return { ...draft, source: undefined };
    }
    return { ...draft, source: { kind: "self-upload", image: draft.source.image } };
  }

  return draft;
}

export function clearWizardState(factId: string): void {
  removeItem(key(factId));
}

/**
 * Clear every persisted wizard draft, return snapshot and picture hand-off, regardless of factId. Call this on
 * auth transitions (login/logout) so an in-progress draft created by one
 * viewer can never leak into another viewer's session.
 */
export function clearAllWizardStates(): void {
  if (!isStorageAvailable()) return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const k = window.sessionStorage.key(i);
      if (k && (k.startsWith(KEY_PREFIX) || k.startsWith(RETURN_PREFIX) || k.startsWith(HANDOFF_PREFIX))) keysToRemove.push(k);
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
