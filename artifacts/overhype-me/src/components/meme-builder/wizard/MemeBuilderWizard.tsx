/**
 * MBFO wizard shell. Full-screen takeover with a top bar and the image
 * builder (`Step2Image`) with its sticky-bottom primary action.
 *
 * The wizard once opened on an artifact-type step (image or video); video was
 * cut in launch Phase 4, so it opens directly on the image builder. This file
 * owns sessionStorage hydration via useWizardState and the
 * onComplete/onCancel contract to the parent.
 */

import { useCallback } from "react";
import type { BuilderResult, EntryFlow, ViewerContext } from "../types";
import { WizardTopBar } from "./WizardTopBar";
import { Step2Image } from "./step2-image/Step2Image";
import { useWizardState } from "./state/useWizardState";

export interface MemeBuilderWizardProps {
  factId: string;
  /** Token-laden fact text — passed through to the image builder. */
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
      <WizardTopBar onClose={handleClose} />

      <div className="absolute inset-0 pt-[calc(env(safe-area-inset-top)+48px)]">
        <div className="relative w-full h-full overflow-hidden">
          <div className="absolute inset-0 overflow-y-auto overscroll-y-none">
            <Step2Image
              factId={factId}
              factText={factText}
              viewerContext={viewerContext}
              state={state}
              dispatch={dispatch}
              onSaved={(result) => {
                clearDraft();
                onComplete({
                  kind: "saved",
                  // The wizard never resolves the memeId synchronously from
                  // the takeover; the permalink is the canonical handle.
                  memeId: "",
                  permalinkUrl: result.permalinkUrl,
                });
              }}
              onRequestSignup={onCancel}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
