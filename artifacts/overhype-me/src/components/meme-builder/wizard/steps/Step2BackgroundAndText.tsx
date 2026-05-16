/**
 * Step 2 of the MBFO wizard: background + text.
 *
 * Dispatches to the image flow (MBFO-3) or the video flow (MBFO-4) based on
 * the artifact type selected in Step 1. The image flow lives in
 * `step2-image/Step2Image.tsx`; the video flow is still placeholder pending
 * MBFO-4.
 */

import type { ArtifactType } from "../state/wizardStorage";
import type { ViewerContext } from "../../types";
import type { WizardAction, WizardRuntimeState } from "../state/useWizardState";
import type { PendingWizardState } from "../state/wizardStorage";
import { Step2Image } from "../step2-image/Step2Image";

interface Props {
  artifactType: ArtifactType | null;
  factId: string;
  factText: string;
  factSplitTokenIndex?: number | null;
  viewerContext: ViewerContext;
  state: WizardRuntimeState;
  dispatch: (action: WizardAction) => void;
  onSaved: (result: { memeId: string; permalinkUrl: string }) => void;
  onRequestSignup: (pending: Partial<PendingWizardState>) => void;
}

export function Step2BackgroundAndText({
  artifactType,
  factId,
  factText,
  factSplitTokenIndex,
  viewerContext,
  state,
  dispatch,
  onSaved,
  onRequestSignup,
}: Props) {
  if (artifactType === "image") {
    return (
      <Step2Image
        factId={factId}
        factText={factText}
        factSplitTokenIndex={factSplitTokenIndex}
        viewerContext={viewerContext}
        state={state}
        dispatch={dispatch}
        onSaved={onSaved}
        onRequestSignup={onRequestSignup}
      />
    );
  }

  // Video flow lands in MBFO-4.
  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 px-5 pb-32 pt-20">
      <header className="text-center">
        <h1 className="font-display text-3xl uppercase tracking-wide text-white">
          Build your meme
        </h1>
        <p className="mt-2 text-sm text-white/60">
          Video flow coming in MBFO-4.
        </p>
      </header>
      <div className="rounded-2xl border-2 border-dashed border-white/15 bg-white/[0.02] p-8 text-center">
        <div className="text-sm text-white/40">Video Step 2 lands in the next MBFO session.</div>
      </div>
    </div>
  );
}
