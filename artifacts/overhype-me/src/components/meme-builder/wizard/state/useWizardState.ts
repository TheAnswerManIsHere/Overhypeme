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
  captureWizardState,
  clearWizardState,
  restoreWizardState,
  type FramingOffset,
  type PendingWizardState,
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

export interface UseWizardStateArgs {
  factId: string;
  entryFlow: EntryFlow;
  initialName?: string;
  initialPronouns?: string;
}

export interface UseWizardStateReturn {
  state: WizardRuntimeState;
  dispatch: React.Dispatch<WizardAction>;
  /** Clears the persisted draft (e.g. after a successful save). */
  clearDraft: () => void;
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
    const pending = restoreWizardState(factId);
    return pending ? reducer(base, { type: "hydrate", pending }) : base;
  });

  // Persist every state change. Generation status is excluded from the
  // serialized shape.
  useEffect(() => {
    const snapshot: PendingWizardState = {
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
    };
    captureWizardState(snapshot);
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
  ]);

  const clearDraft = useCallback(() => {
    clearWizardState(factId);
  }, [factId]);

  return { state, dispatch, clearDraft };
}
