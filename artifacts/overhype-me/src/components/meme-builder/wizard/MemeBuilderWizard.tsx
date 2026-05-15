/**
 * MBFO wizard shell. Full-screen takeover with a top progress bar, two
 * sliding step containers, and (on Step 2) the image-flow surface from
 * `step2-image/Step2Image.tsx` (image) or a placeholder for video pending
 * MBFO-4.
 *
 * The wizard owns navigation, sessionStorage hydration via useWizardState,
 * and the onComplete/onCancel contract to the parent. Step 2 internals own
 * their own primary action (the save flow branches for PuLID vs. direct
 * save), so the wizard no longer renders a global "Make my meme" button.
 */

import { useCallback, useRef, useState } from "react";
import type { BuilderResult, EntryFlow, ViewerContext, PendingBuilderState } from "../types";
import { WizardTopBar } from "./WizardTopBar";
import { WizardStepContainer } from "./WizardStepContainer";
import { Step1ArtifactType } from "./steps/Step1ArtifactType";
import { Step2BackgroundAndText } from "./steps/Step2BackgroundAndText";
import { useWizardState } from "./state/useWizardState";
import type { PendingWizardState } from "./state/wizardStorage";

export interface MemeBuilderWizardProps {
  factId: string;
  /** Token-laden fact text — passed through to Step 2 internals in MBFO-3/4. */
  factText: string;
  /** Server-supplied default split for the text-position slider; falls back to client `intelligentSplit`. */
  factSplitTokenIndex?: number | null;
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
    factSplitTokenIndex,
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

  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const lastStepRef = useRef(state.currentStep);
  if (lastStepRef.current !== state.currentStep) {
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
    onCancel();
  }, [state.currentStep, dispatch, onCancel]);

  const handleClose = useCallback(() => {
    onCancel();
  }, [onCancel]);

  const handleSaved = useCallback(
    (result: { memeId: string; permalinkUrl: string }) => {
      clearDraft();
      onComplete({
        kind: "saved",
        memeId: result.memeId,
        permalinkUrl: result.permalinkUrl,
      });
    },
    [clearDraft, onComplete],
  );

  const handleRequestSignup = useCallback(
    (pending: Partial<PendingWizardState>) => {
      // Translate the schema-v2 wizard snapshot into the v1 PendingBuilderState
      // the existing signup wall in App.tsx understands. The v1 shape is a
      // strict subset; we drop schemaVersion-2-only fields the wall doesn't
      // need to round-trip through auth.
      const { schemaVersion: _v2, capturedAt: _ca, factId: _fid, ...pendingFields } = pending;
      void _v2; void _ca; void _fid;
      const v1: PendingBuilderState = {
        schemaVersion: 1,
        capturedAt: Date.now(),
        factId,
        entryFlow,
        mode: state.mode ?? "stock",
        name: state.name,
        pronouns: state.pronouns,
        source: state.source,
        textOptions: state.textOptions,
        aspectRatio: state.aspectRatio,
        ...pendingFields,
      };
      onComplete({ kind: "signup-required", pendingState: v1 });
    },
    [factId, entryFlow, state, onComplete],
  );

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
              factSplitTokenIndex={factSplitTokenIndex}
              viewerContext={viewerContext}
              state={state}
              dispatch={dispatch}
              onSaved={handleSaved}
              onRequestSignup={handleRequestSignup}
            />
          )}
        </WizardStepContainer>
      </div>
    </div>
  );
}
