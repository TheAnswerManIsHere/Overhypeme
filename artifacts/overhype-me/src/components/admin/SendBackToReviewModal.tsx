import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";

/**
 * Confirm modal for "Send back to review" (stale-fact refresh). Presentational
 * — the Facts page owns the POST. Mirrors the delete-modal pattern.
 *
 * The "clear my edits" checkbox (default OFF) wipes the CANDIDATE's seeded
 * manual-edit layers only; the live fact's own overrides are never touched by
 * send-back either way.
 */
export function SendBackToReviewModal({
  factId,
  factText,
  busy,
  onCancel,
  onConfirm,
}: {
  factId: number;
  factText: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (clearOverrides: boolean) => void;
}) {
  const [clearOverrides, setClearOverrides] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" data-testid="send-back-modal">
      <div className="bg-card border border-border rounded-lg w-full max-w-sm p-6 flex flex-col gap-5 shadow-xl">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0">
            <RefreshCw className="w-5 h-5 text-blue-500" />
          </div>
          <div>
            <h2 className="font-display font-bold text-foreground uppercase tracking-wide">Send Back to Review</h2>
            <p className="text-xs text-muted-foreground mt-0.5">#{factId}</p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground line-clamp-2 italic">"{factText}"</p>
        <p className="text-sm text-muted-foreground">
          The fact <strong className="text-foreground">stays live</strong> the whole time. AI re-classifies it with the
          current pipeline into a <strong className="text-foreground">refresh candidate</strong>, which lands in the
          Moderation queue at <strong className="text-foreground">Visual Concept</strong> (Step 2) — nothing changes
          until a moderator promotes it. Existing memes, images, and hashtags are never touched.
        </p>
        <label className="flex items-start gap-2 text-sm text-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={clearOverrides}
            onChange={(e) => setClearOverrides(e.target.checked)}
            className="mt-0.5"
            data-testid="send-back-clear-overrides"
          />
          <span>
            Clear my manual edits{" "}
            <span className="text-xs text-muted-foreground block">
              Start the candidate from a clean AI baseline instead of carrying this fact's manual overrides forward.
              The live fact's own edits are kept either way.
            </span>
          </span>
        </label>
        <div className="flex gap-3">
          <Button
            onClick={() => onConfirm(clearOverrides)}
            isLoading={busy}
            className="flex-1 gap-2"
            data-testid="send-back-confirm"
          >
            <RefreshCw className="w-4 h-4" /> Start Refresh
          </Button>
          <Button variant="outline" onClick={onCancel} className="flex-1" disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
