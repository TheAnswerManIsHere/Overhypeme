/**
 * Stage-1 review checkpoint rendered inside the God Mode loading takeover
 * when the server returns phase === "stage1_review".
 *
 * Actions:
 *   - Animate it   → POST /:jobId/proceed
 *   - Try a different style → expands picker, then POST /:jobId/regenerate
 *   - Regenerate this style → POST /:jobId/regenerate (same style)
 *   - Cancel       → DELETE /:jobId
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import type { AspectRatio } from "../../types";
import type { LookStyleDTO } from "./data/videoCatalogue";

interface Props {
  stillUrl: string | null;
  aspectRatio: AspectRatio;
  currentLookStyleId: string;
  lookStyles: LookStyleDTO[];
  /** How many stylization attempts have been spent so far. */
  stage1Attempts: number;
  /** Estimated cost of the next step (formatted, e.g. "$0.18"). */
  nextStepCost?: string;
  /** Remaining budget (formatted, e.g. "$4.21"). */
  remainingBudget?: string;
  onProceed: () => void;
  onRegenerateSameStyle: () => void;
  onRegenerateWithStyle: (lookStyleId: string) => void;
  onCancel: () => void;
  /** Disables every button while an API call is in flight. */
  busy?: boolean;
  /** Shown when the last proceed/regenerate attempt failed (e.g. rate-limited). */
  errorMessage?: string | null;
}

const ASPECT_CLASS: Record<AspectRatio, string> = {
  landscape: "aspect-[16/9]",
  square: "aspect-square",
  portrait: "aspect-[9/16]",
};

export function VideoCheckpointScreen({
  stillUrl,
  aspectRatio,
  currentLookStyleId,
  lookStyles,
  stage1Attempts,
  nextStepCost,
  remainingBudget,
  onProceed,
  onRegenerateSameStyle,
  onRegenerateWithStyle,
  onCancel,
  busy,
  errorMessage,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingLookStyleId, setPendingLookStyleId] = useState(currentLookStyleId);

  return (
    <div
      className="flex h-full w-full flex-col items-center px-5 pt-4 pb-8"
      data-testid="video-checkpoint"
    >
      <div className="w-full max-w-md space-y-4">
        <header className="text-center">
          <h2 className="font-display text-2xl uppercase tracking-wide text-white">
            Your starting frame is ready
          </h2>
          <p className="mt-1 text-sm text-white/60">
            This is the still we'll animate. Approve to continue.
          </p>
        </header>

        <div
          className={cn(
            "mx-auto w-full overflow-hidden rounded-xl border border-white/10 bg-black",
            ASPECT_CLASS[aspectRatio],
          )}
        >
          {stillUrl ? (
            <img src={stillUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-white/30">
              Loading…
            </div>
          )}
        </div>

        {errorMessage && (
          <p
            className="text-center text-sm text-destructive"
            role="alert"
            data-testid="video-checkpoint-error"
          >
            {errorMessage}
          </p>
        )}

        {(nextStepCost || remainingBudget) && (
          <p
            className="text-center text-xs text-white/60"
            data-testid="video-checkpoint-cost"
          >
            Next up: video generation
            {nextStepCost ? ` (~${nextStepCost}` : ""}
            {remainingBudget ? ` of your ${remainingBudget} remaining budget)` : nextStepCost ? ")" : ""}
          </p>
        )}

        {stage1Attempts >= 2 && (
          <p
            className="text-center font-mono text-[10px] uppercase tracking-widest text-white/50"
            data-testid="video-checkpoint-attempts"
          >
            Stylizations: {stage1Attempts}
          </p>
        )}

        {stage1Attempts >= 5 && (
          <p
            className="rounded-md border border-white/15 bg-white/5 px-3 py-2 text-center text-xs text-white/70"
            data-testid="video-checkpoint-warning"
          >
            Each stylization spends from your budget. Want to try a different
            photo instead?
          </p>
        )}

        <div className="space-y-2">
          <Button
            type="button"
            disabled={busy}
            onClick={onProceed}
            className="w-full"
            data-testid="video-checkpoint-proceed"
          >
            Animate it
          </Button>

          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => setPickerOpen((v) => !v)}
            className="w-full"
            data-testid="video-checkpoint-try-different-style"
          >
            {pickerOpen ? "Hide styles" : "Try a different style"}
          </Button>

          {pickerOpen && (
            <div
              className="space-y-2 rounded-md border border-white/15 bg-black/40 p-3"
              data-testid="video-checkpoint-style-picker"
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {lookStyles.map((s) => {
                  const isSelected = pendingLookStyleId === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setPendingLookStyleId(s.id)}
                      className={cn(
                        "rounded-md border px-2 py-2 text-left text-xs transition",
                        isSelected
                          ? "border-[#ff6b35] bg-[#ff6b35]/15"
                          : "border-white/15 text-white/70 hover:border-white/30",
                      )}
                      data-testid={`video-checkpoint-style-${s.id}`}
                    >
                      <div className="font-display text-sm uppercase">{s.label}</div>
                    </button>
                  );
                })}
              </div>
              <Button
                type="button"
                disabled={busy || pendingLookStyleId === currentLookStyleId}
                onClick={() => {
                  onRegenerateWithStyle(pendingLookStyleId);
                  setPickerOpen(false);
                }}
                className="w-full"
                data-testid="video-checkpoint-style-picker-apply"
              >
                Use this style
              </Button>
            </div>
          )}

          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={onRegenerateSameStyle}
            className="w-full"
            data-testid="video-checkpoint-regenerate"
          >
            Regenerate this style
          </Button>

          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={onCancel}
            className="w-full text-white/60"
            data-testid="video-checkpoint-cancel"
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
