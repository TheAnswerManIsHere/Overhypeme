/**
 * Step 2 of the MBFO wizard: background + text.
 *
 * Dispatches to the video orchestrator (`Step2Video`) when artifactType is
 * "video"; the image branch is still the MBFO-3 placeholder.
 */

import type { ArtifactType } from "../state/wizardStorage";
import type { WizardRuntimeState, WizardAction } from "../state/useWizardState";
import type { ViewerContext } from "../../types";
import { Step2Video } from "../step2-video/Step2Video";

interface Props {
  artifactType: ArtifactType | null;
  factId: string;
  factText: string;
  viewerContext: ViewerContext;
  state: WizardRuntimeState;
  dispatch: React.Dispatch<WizardAction>;
  onComplete: (permalinkUrl: string) => void;
  onCancel: () => void;
}

export function Step2BackgroundAndText(props: Props) {
  const {
    artifactType,
    factId,
    factText,
    viewerContext,
    state,
    dispatch,
    onComplete,
    onCancel,
  } = props;

  if (artifactType === "video") {
    return (
      <Step2Video
        factId={factId}
        factText={factText}
        viewerContext={viewerContext}
        state={state}
        // Cast to the wider `unknown` shape Step2Video accepts internally.
        // The runtime types are compatible — the orchestrator dispatches
        // proper WizardAction objects under the hood.
        dispatch={dispatch as unknown as React.Dispatch<{
          type: string;
          [key: string]: unknown;
        }>}
        onComplete={onComplete}
        onCancel={onCancel}
      />
    );
  }

  // Image path is implemented in a separate pass — keep the placeholder.
  return (
    <div className="flex flex-col gap-6 px-5 pt-20 pb-32 max-w-md mx-auto">
      <header className="text-center">
        <h1 className="text-white text-3xl font-[Bebas_Neue,sans-serif] tracking-wide uppercase">
          Build your meme
        </h1>
        <p className="text-white/60 text-sm mt-2">
          Pick a photo, add your name. Tweak the placement.
        </p>
      </header>

      <div className="rounded-2xl border-2 border-dashed border-white/15 bg-white/[0.02] p-8 text-center">
        <div className="text-white/40 text-sm">
          Step 2 (image) controls land in the next MBFO session.
        </div>
        <div className="text-white/30 text-xs mt-2">
          Source picker · name · pronouns · live preview · framing · text split
        </div>
      </div>
    </div>
  );
}
