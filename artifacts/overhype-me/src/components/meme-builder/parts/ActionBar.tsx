import { Button } from "@/components/ui/Button";
import { ACTION_COPY } from "../copy";
import type { Action } from "../types";

interface Props {
  visibleActions: Action[];
  saveDisabled?: boolean;
  downloadDisabled?: boolean;
  onDownload: () => void;
  onSave: () => void;
  onShare: () => void;
  onSignupCta: () => void;
}

export function ActionBar({
  visibleActions,
  saveDisabled,
  downloadDisabled,
  onDownload,
  onSave,
  onShare,
  onSignupCta,
}: Props) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
      <div className="flex flex-wrap gap-2">
        {visibleActions.includes("download") && (
          <Button type="button" variant="secondary" disabled={downloadDisabled} onClick={onDownload}>
            {ACTION_COPY.download}
          </Button>
        )}
        {visibleActions.includes("save") && (
          <Button type="button" disabled={saveDisabled} onClick={onSave}>
            {ACTION_COPY.save}
          </Button>
        )}
        {visibleActions.includes("share") && (
          <Button type="button" variant="secondary" onClick={onShare}>
            {ACTION_COPY.share}
          </Button>
        )}
        {visibleActions.includes("signup-cta") && (
          <Button type="button" onClick={onSignupCta}>
            {ACTION_COPY.signupCta}
          </Button>
        )}
      </div>
    </div>
  );
}
