/**
 * Step 2 of the MBFO wizard: background + text.
 *
 * Dispatches to the video orchestrator (`Step2Video`) when artifactType is
 * "video", and to the image orchestrator (`Step2Image`) when artifactType is
 * "image".
 */

import type { ArtifactType } from "../state/wizardStorage";
import type { WizardRuntimeState, WizardAction } from "../state/useWizardState";
import type { ViewerContext } from "../../types";
import { Step2Video } from "../step2-video/Step2Video";
import { Step2Image } from "../step2-image/Step2Image";

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
        dispatch={dispatch as unknown as React.Dispatch<{
          type: string;
          [key: string]: unknown;
        }>}
        onComplete={onComplete}
        onCancel={onCancel}
      />
    );
  }

  return (
    <Step2Image
      factId={factId}
      factText={factText}
      viewerContext={viewerContext}
      state={state}
      dispatch={dispatch}
      onSaved={(result) => onComplete(result.permalinkUrl)}
      onRequestSignup={onCancel}
    />
  );
}
