/**
 * Wizard state hook. Owns the reducer for the MBFO wizard and syncs every
 * mutation to sessionStorage via wizardStorage.
 *
 * Runtime-only fields (e.g. generation status) live on this hook but are NOT
 * persisted. Persisted shape is `PendingWizardState` (schemaVersion 3).
 *
 * Hydrates from sessionStorage on first render; if nothing is stored (or it's
 * stale) we start from a clean initial state.
 */

import { useCallback, useEffect, useReducer } from "react";
import type {
  AspectRatio,
  EntryFlow,
  MemeTextOptions,
  Mode,
  MyImageSource,
} from "../../types";
import {
  captureReturnSnapshot,
  captureWizardState,
  clearPictureHandoff,
  clearReturnSnapshot,
  clearWizardState,
  readPictureHandoff,
  readReturnSnapshot,
  restoreWizardState,
  type FramingOffset,
  type PendingWizardState,
  type PictureHandoff,
  type WizardAdvancedOptions,
} from "./wizardStorage";

export type GenerationStatus =
  | { status: "idle" }
  | { status: "generating" }
  | { status: "error"; errorCode: string };

export interface WizardRuntimeState {
  mode?: Mode;
  source?: PendingWizardState["source"];
  aspectRatio?: AspectRatio;
  framingOffset?: FramingOffset;
  name?: string;
  pronouns?: string;
  textOptions?: MemeTextOptions;
  advancedOptions?: WizardAdvancedOptions;
  /** Gallery visibility; undefined means "not chosen yet" and reads as public. */
  isPublic?: boolean;
  splitIndex?: number;
  captionChosen?: boolean;
  generation: GenerationStatus;
}

export type WizardAction =
  | { type: "set-mode"; mode: Mode }
  | { type: "set-source"; source: PendingWizardState["source"] }
  | { type: "set-aspect-ratio"; aspectRatio: AspectRatio }
  | { type: "set-framing-offset"; framingOffset: FramingOffset }
  | { type: "set-name"; name: string }
  | { type: "set-pronouns"; pronouns: string }
  | { type: "set-text-options"; textOptions: MemeTextOptions }
  | { type: "set-advanced-options"; advancedOptions: WizardAdvancedOptions }
  | { type: "set-is-public"; isPublic: boolean }
  | { type: "set-split-index"; splitIndex: number }
  | { type: "set-generation"; generation: GenerationStatus }
  | { type: "hydrate"; pending: PendingWizardState }
  | { type: "reset" };

function initialState(): WizardRuntimeState {
  return {
    generation: { status: "idle" },
  };
}

function reducer(state: WizardRuntimeState, action: WizardAction): WizardRuntimeState {
  switch (action.type) {
    case "set-mode":
      return { ...state, mode: action.mode };
    case "set-source":
      return { ...state, source: action.source };
    case "set-aspect-ratio":
      return { ...state, aspectRatio: action.aspectRatio };
    case "set-framing-offset":
      return { ...state, framingOffset: action.framingOffset };
    case "set-name":
      return { ...state, name: action.name };
    case "set-pronouns":
      return { ...state, pronouns: action.pronouns };
    case "set-text-options":
      return { ...state, textOptions: action.textOptions };
    case "set-advanced-options":
      return { ...state, advancedOptions: action.advancedOptions };
    case "set-is-public":
      return { ...state, isPublic: action.isPublic };
    case "set-split-index":
      return { ...state, splitIndex: action.splitIndex };
    case "set-generation":
      return { ...state, generation: action.generation };
    case "hydrate": {
      const { schemaVersion, capturedAt, factId, entryFlow, ...rest } = action.pending;
      void schemaVersion;
      void capturedAt;
      void factId;
      void entryFlow;
      return { ...state, ...rest };
    }
    case "reset":
      return initialState();
  }
}

/**
 * A finished picture handed back from the picture flow wins once over the
 * restored draft: its background, its shape and its caption, and nothing else
 * (plan PLAN_PHASE7_AI_PICTURE_FLOW.md, *The hand-off wins once*). A picture
 * made before its caption was recorded leaves the caption as it is.
 */
export function applyPictureHandoff(state: WizardRuntimeState, handoff: PictureHandoff): WizardRuntimeState {
  const next: WizardRuntimeState = {
    ...state,
    source: { kind: "ai-picture", aiImageId: handoff.aiImageId, imageUrl: handoff.imageUrl },
    aspectRatio: handoff.aspectRatio,
  };
  if (handoff.caption) {
    next.name = handoff.caption.name;
    if (handoff.caption.pronouns) next.pronouns = handoff.caption.pronouns;
    next.captionChosen = handoff.caption.chosen;
  }
  return next;
}

/** The persisted shape of a runtime state. Generation status is excluded. */
export function toPendingWizardState(state: WizardRuntimeState, factId: string, entryFlow: EntryFlow): PendingWizardState {
  return {
    schemaVersion: 3,
    capturedAt: Date.now(),
    factId,
    entryFlow,
    mode: state.mode,
    source: state.source,
    aspectRatio: state.aspectRatio,
    framingOffset: state.framingOffset,
    name: state.name,
    pronouns: state.pronouns,
    textOptions: state.textOptions,
    advancedOptions: state.advancedOptions,
    isPublic: state.isPublic,
    splitIndex: state.splitIndex,
    captionChosen: state.captionChosen,
  };
}

export interface UseWizardStateArgs {
  factId: string;
  entryFlow: EntryFlow;
  initialName?: string;
  initialPronouns?: string;
}

export interface UseWizardStateReturn {
  state: WizardRuntimeState;
  dispatch: React.Dispatch<WizardAction>;
  /** Clears the persisted draft and any return snapshot (e.g. after a successful save). */
  clearDraft: () => void;
  /**
   * Keeps the draft, with the given latest values, as the member leaves for
   * the picture flow, so coming back restores everything they had set.
   */
  keepForPictureFlow: (latest: Partial<WizardRuntimeState>) => void;
}

export function useWizardState(args: UseWizardStateArgs): UseWizardStateReturn {
  const { factId, entryFlow, initialName, initialPronouns } = args;
  // Hydrate from sessionStorage in the initializer, not an effect: the image
  // builder mounts on the first render (there is no Step 1 to cover the gap
  // since video was cut) and reads its state once, so a draft restored after
  // mount would be lost.
  const [state, dispatch] = useReducer(reducer, undefined, () => {
    const base = initialState();
    if (initialName) base.name = initialName;
    if (initialPronouns) base.pronouns = initialPronouns;
    // Back from the picture flow, the draft as the member left it wins over
    // the hour-long draft, which may have expired meanwhile. Both are read
    // without being removed: the initializer can run twice.
    const pending = readReturnSnapshot(factId) ?? restoreWizardState(factId);
    const restored = pending ? reducer(base, { type: "hydrate", pending }) : base;
    const handoff = readPictureHandoff(factId);
    return handoff ? applyPictureHandoff(restored, handoff) : restored;
  });

  // The return snapshot and the hand-off are used once: the draft persisted
  // below now holds what they carried, so a reload restores it as it stands.
  useEffect(() => {
    clearReturnSnapshot(factId);
    clearPictureHandoff(factId);
  }, [factId]);

  // Persist every state change. Generation status is excluded from the
  // serialized shape.
  useEffect(() => {
    captureWizardState(toPendingWizardState(state, factId, entryFlow));
  }, [
    factId,
    entryFlow,
    state.mode,
    state.source,
    state.aspectRatio,
    state.framingOffset,
    state.name,
    state.pronouns,
    state.textOptions,
    state.advancedOptions,
    state.isPublic,
    state.splitIndex,
    state.captionChosen,
  ]);

  const clearDraft = useCallback(() => {
    clearWizardState(factId);
    clearReturnSnapshot(factId);
  }, [factId]);

  const keepForPictureFlow = useCallback((latest: Partial<WizardRuntimeState>) => {
    captureReturnSnapshot(toPendingWizardState({ ...state, ...latest }, factId, entryFlow));
  }, [state, factId, entryFlow]);

  return { state, dispatch, clearDraft, keepForPictureFlow };
}
