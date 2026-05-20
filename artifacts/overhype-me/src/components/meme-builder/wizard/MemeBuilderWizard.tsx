/**
 * MBFO wizard shell. Full-screen takeover with a top progress bar, two
 * sliding step containers, and (on Step 2) a sticky-bottom primary action.
 *
 * Subsequent MBFO sessions fill in the step internals; this file owns
 * navigation, sessionStorage hydration via useWizardState, and the
 * onComplete/onCancel contract to the parent.
 */

import { useCallback, useRef, useState } from "react";
import type { BuilderResult, EntryFlow, ViewerContext } from "../types";
import { WizardTopBar } from "./WizardTopBar";
import { WizardStepContainer } from "./WizardStepContainer";
import { Step1ArtifactType } from "./steps/Step1ArtifactType";
import { Step2BackgroundAndText } from "./steps/Step2BackgroundAndText";
import { useWizardState } from "./state/useWizardState";

export interface MemeBuilderWizardProps {
  factId: string;
  /** Token-laden fact text — passed through to Step 2 internals in MBFO-3/4. */
  factText: string;
  viewerContext: ViewerContext;
  entryFlow: EntryFlow;
  initialName?: string;
  initialPronouns?: string;
  onComplete: (result: BuilderResult) => void;
  onCancel: () => void;
}

export function MemeBuilderWizard(props: MemeBuilderWizardProps) {
  const {
    factId,
    factText,
    viewerContext,
    entryFlow,
    initialName,
    initialPronouns,
    onComplete,
    onCancel,
  } = props;
  const { state, dispatch, clearDraft } = useWizardState({
    factId,
    entryFlow,
    initialName,
    initialPronouns,
  });

  // Direction tracks whether the most recent transition was forward or back,
  // which feeds the slide animation. Updated by callers, not derived from
  // step number alone (so a "back" from step 2 → 1 animates correctly).
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const lastStepRef = useRef(state.currentStep);
  if (lastStepRef.current !== state.currentStep) {
    // Catch hydrate-from-storage transitions: if storage restored step 2 on
    // mount, treat as a "forward" entry (no animation flicker either way).
    lastStepRef.current = state.currentStep;
  }

  const handleSelectArtifactType = useCallback(
    (artifactType: "image" | "video") => {
      setDirection("forward");
      dispatch({ type: "select-artifact-type", artifactType });
    },
    [dispatch],
  );

  const handleBack = useCallback(() => {
    if (state.currentStep === 2) {
      setDirection("back");
      dispatch({ type: "back" });
      return;
    }
    // On Step 1, back arrow is hidden — but if invoked, treat as cancel.
    onCancel();
  }, [state.currentStep, dispatch, onCancel]);

  const handleClose = useCallback(() => {
    // MBFO-1 does not prompt-to-discard; the next session adds a
    // confirm-discard toast/dialog when there's unsaved input.
    onCancel();
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 bg-[#111] text-white"
      role="dialog"
      aria-modal="true"
      aria-label="Meme builder"
      data-testid="meme-builder-wizard"
    >
      <WizardTopBar
        currentStep={state.currentStep}
        onBack={handleBack}
        onClose={handleClose}
      />

      <div className="absolute inset-0 pt-[calc(env(safe-area-inset-top)+48px+3px)]">
        <WizardStepContainer currentStep={state.currentStep} direction={direction}>
          {state.currentStep === 1 ? (
            <Step1ArtifactType
              selected={state.artifactType}
              onSelect={handleSelectArtifactType}
              tier={viewerContext.tier}
            />
          ) : (
            <Step2BackgroundAndText
              artifactType={state.artifactType}
              factId={factId}
              factText={factText}
              viewerContext={viewerContext}
              state={state}
              dispatch={dispatch}
              onComplete={(permalinkUrl) => {
                clearDraft();
                onComplete({
                  kind: "saved",
                  // The wizard never resolves the memeId synchronously from
                  // the takeover; the permalink is the canonical handle.
                  memeId: "",
                  permalinkUrl,
                });
              }}
              onCancel={onCancel}
            />
          )}
        </WizardStepContainer>
      </div>

    </div>
  );
}
