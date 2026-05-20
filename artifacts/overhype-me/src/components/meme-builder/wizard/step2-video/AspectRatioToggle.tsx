/**
 * Three-way aspect ratio toggle (landscape / square / portrait).
 *
 * Step 2 (image) will eventually own a sibling of this file; until that
 * lands, the video step keeps a local copy here.
 */

import { cn } from "@/lib/utils";
import type { AspectRatio } from "../../types";

interface Props {
  value: AspectRatio;
  onChange: (next: AspectRatio) => void;
  /** Restrict the choices to a subset (engine-aware). Defaults to all three. */
  allowed?: AspectRatio[];
}

const OPTIONS: { value: AspectRatio; label: string; aspect: string }[] = [
  { value: "landscape", label: "16:9", aspect: "aspect-[16/9]" },
  { value: "square", label: "1:1", aspect: "aspect-square" },
  { value: "portrait", label: "9:16", aspect: "aspect-[9/16]" },
];

export function AspectRatioToggle({ value, onChange, allowed }: Props) {
  const visible = allowed
    ? OPTIONS.filter((o) => allowed.includes(o.value))
    : OPTIONS;

  return (
    <div
      className="flex gap-2"
      role="radiogroup"
      aria-label="Aspect ratio"
    >
      {visible.map((opt) => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex-1 rounded-md border px-3 py-2 text-xs font-mono uppercase tracking-widest transition",
              isActive
                ? "border-[#ff6b35] bg-[#ff6b35]/15 text-white"
                : "border-white/15 text-white/70 hover:border-white/30",
            )}
            data-testid={`aspect-ratio-${opt.value}`}
          >
            <div
              className={cn(
                "mx-auto mb-1 w-8 rounded-sm border border-current",
                opt.aspect,
              )}
              aria-hidden
            />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
