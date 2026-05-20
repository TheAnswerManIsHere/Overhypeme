/**
 * Sticky-top preview for Step 2 (video). Renders the chosen source still
 * inside the selected aspect-ratio frame, plus a one-line settings summary.
 *
 * The preview is "locked" in the sense that it never reacts to drag/pan —
 * for video, the framing is fixed and the user only edits the source +
 * style + motion.
 */

import { cn } from "@/lib/utils";
import type { AspectRatio } from "../../types";
import { ImageIcon } from "lucide-react";

interface Props {
  sourceUrl: string | null;
  aspectRatio: AspectRatio;
  summary: {
    styleLabel?: string;
    motionLabel?: string;
    lengthSec?: number;
    resolution?: string;
  };
}

const ASPECT_CLASS: Record<AspectRatio, string> = {
  landscape: "aspect-[16/9]",
  square: "aspect-square",
  portrait: "aspect-[9/16]",
};

export function LockedVideoPreview({ sourceUrl, aspectRatio, summary }: Props) {
  const summaryLine = formatSummary(summary);

  return (
    <div
      className="sticky top-0 z-10 -mx-5 mb-4 bg-[#111] px-5 pt-2 pb-3"
      data-testid="locked-video-preview"
    >
      <div
        className={cn(
          "mx-auto w-full max-w-sm overflow-hidden rounded-xl border border-white/10 bg-black",
          ASPECT_CLASS[aspectRatio],
        )}
      >
        {sourceUrl ? (
          <img
            src={sourceUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-white/30">
            <ImageIcon className="h-8 w-8" />
            <span className="font-mono text-[10px] uppercase tracking-widest">
              Pick a photo
            </span>
          </div>
        )}
      </div>

      {summaryLine && (
        <p
          className="mt-2 text-center font-mono text-[10px] uppercase tracking-widest text-white/50"
          data-testid="locked-video-preview-summary"
        >
          {summaryLine}
        </p>
      )}
    </div>
  );
}

function formatSummary(s: Props["summary"]): string {
  const parts: string[] = [];
  if (s.styleLabel) parts.push(`Style: ${s.styleLabel}`);
  if (s.motionLabel) parts.push(`Motion: ${s.motionLabel}`);
  if (s.lengthSec) parts.push(`Length: ${s.lengthSec}s`);
  if (s.resolution) parts.push(`Quality: ${s.resolution}`);
  return parts.join(" · ");
}
