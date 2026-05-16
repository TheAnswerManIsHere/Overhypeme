import type { AspectRatio } from "../../types";

interface Props {
  value: AspectRatio;
  onChange: (next: AspectRatio) => void;
}

interface Option {
  id: AspectRatio;
  label: string;
  /** SVG box dimensions inside a 24×24 viewport. */
  rect: { w: number; h: number };
}

const OPTIONS: Option[] = [
  { id: "landscape", label: "Landscape 16:9", rect: { w: 20, h: 12 } },
  { id: "square",    label: "Square 1:1",     rect: { w: 16, h: 16 } },
  { id: "portrait",  label: "Portrait 9:16",  rect: { w: 12, h: 20 } },
];

export function AspectRatioToggle({ value, onChange }: Props) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">Ratio</span>
      <div
        role="radiogroup"
        aria-label="Aspect ratio"
        className="flex gap-1 rounded-full bg-white/5 p-1"
      >
        {OPTIONS.map((opt) => {
          const isActive = value === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={isActive}
              aria-label={opt.label}
              data-testid={`aspect-${opt.id}`}
              onClick={() => onChange(opt.id)}
              className={[
                "flex h-9 w-9 items-center justify-center rounded-full transition-colors",
                isActive ? "bg-[#ff6b35] text-white" : "text-white/70 hover:text-white",
              ].join(" ")}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <rect
                  x={(24 - opt.rect.w) / 2}
                  y={(24 - opt.rect.h) / 2}
                  width={opt.rect.w}
                  height={opt.rect.h}
                  rx={2}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.6}
                />
              </svg>
            </button>
          );
        })}
      </div>
    </div>
  );
}
