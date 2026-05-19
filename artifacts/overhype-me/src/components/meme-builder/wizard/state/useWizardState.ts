/**
 * Wizard state hook. Owns the reducer for the MBFO wizard and syncs every
 * mutation to sessionStorage via wizardStorage.
 *
 * Runtime-only fields (e.g. generation status) live on this hook but are NOT
 * persisted. Persisted shape is `PendingWizardState` (schemaVersion 2).
 *
 * Hydrates from sessionStorage on mount; if nothing is stored (or it's stale)
 * we start from a clean initial state on Step 1.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
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
  type ArtifactType,
  type FramingOffset,
  type PendingWizardState,
  type WizardAdvancedOptions,
  type WizardStep,
} from "./wizardStorage";

export type GenerationStatus =
  | { status: "idle" }
  | { status: "generating" }
  | { status: "error"; errorCode: string };

export interface WizardRuntimeState {
  currentStep: WizardStep;
  artifactType: ArtifactType | null;
  mode?: Mode;
  source?: PendingWizardState["source"];
  aspectRatio?: AspectRatio;
  framingOffset?: FramingOffset;
  name?: string;
  pronouns?: string;
  textOptions?: MemeTextOptions;
  advancedOptions?: WizardAdvancedOptions;
  generation: GenerationStatus;
}

export type WizardAction =
  | { type: "select-artifact-type"; artifactType: ArtifactType }
  | { type: "advance" }
  | { type: "back" }
  | { type: "set-mode"; mode: Mode }
  | { type: "set-source"; source: PendingWizardState["source"] }
  | { type: "set-aspect-ratio"; aspectRatio: AspectRatio }
  | { type: "set-framing-offset"; framingOffset: FramingOffset }
  | { type: "set-name"; name: string }
  | { type: "set-pronouns"; pronouns: string }
  | { type: "set-text-options"; textOptions: MemeTextOptions }
  | { type: "set-advanced-options"; advancedOptions: WizardAdvancedOptions }
  | { type: "set-generation"; generation: GenerationStatus }
  | { type: "hydrate"; pending: PendingWizardState }
  | { type: "reset" };

function initialState(): WizardRuntimeState {
  return {
    currentStep: 1,
    artifactType: null,
    generation: { status: "idle" },
  };
}

function reducer(state: WizardRuntimeState, action: WizardAction): WizardRuntimeState {
  switch (action.type) {
    case "select-artifact-type":
      // Selecting an artifact type on Step 1 advances forward.
      return {
        ...state,
        artifactType: action.artifactType,
        currentStep: 2,
      };
    case "advance":
      return state.currentStep === 2 ? state : { ...state, currentStep: 2 };
    case "back":
      return state.currentStep === 1 ? state : { ...state, currentStep: 1 };
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
    case "set-generation":
      return { ...state, generation: action.generation };
    case "hydrate": {
      // Identity (name / pronouns) is NEVER hydrated from the persisted draft.
      // The viewer's identity is owned exclusively by `usePersonName` (and is
      // kept in lock-step with auth by AuthProfileSync). The wizard receives
      // the fresh value via `initialName` / `initialPronouns` and must not
      // let a stale cached identity from a previous session leak through.
      const { schemaVersion, capturedAt, factId, entryFlow, name, pronouns, ...rest } = action.pending;
      void schemaVersion;
      void capturedAt;
      void factId;
      void entryFlow;
      void name;
      void pronouns;
      return {
        ...state,
        ...rest,
      };
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
  const [state, dispatch] = useReducer(reducer, undefined, () => {
    const base = initialState();
    if (initialName) base.name = initialName;
    if (initialPronouns) base.pronouns = initialPronouns;
    return base;
  });

  // Hydrate from sessionStorage on mount.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const pending = restoreWizardState(factId);
    if (pending) dispatch({ type: "hydrate", pending });
  }, [factId]);

  // Persist every state change. Generation status is excluded from the
  // serialized shape. Identity (name / pronouns) is intentionally NOT
  // persisted — it belongs to `usePersonName` (kept in sync with auth) and
  // flows in through `initialName` / `initialPronouns` on every wizard mount.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const snapshot: PendingWizardState = {
      schemaVersion: 2,
      capturedAt: Date.now(),
      factId,
      entryFlow,
      currentStep: state.currentStep,
      artifactType: state.artifactType,
      mode: state.mode,
      source: state.source,
      aspectRatio: state.aspectRatio,
      framingOffset: state.framingOffset,
      textOptions: state.textOptions,
      advancedOptions: state.advancedOptions,
    };
    captureWizardState(snapshot);
  }, [
    factId,
    entryFlow,
    state.currentStep,
    state.artifactType,
    state.mode,
    state.source,
    state.aspectRatio,
    state.framingOffset,
    state.textOptions,
    state.advancedOptions,
  ]);

  const clearDraft = useCallback(() => {
    clearWizardState(factId);
  }, [factId]);

  return { state, dispatch, clearDraft };
}
