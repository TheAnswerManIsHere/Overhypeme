import { useMemo } from "react";
import { Slider } from "@/components/ui/slider";
import { getWords } from "./splitLogic";

interface Props {
  factText: string;
  value: number;
  onChange: (value: number) => void;
  /**
   * Inclusive minimum/maximum. Defaults to 1..words.length-1 so neither half
   * is empty. The slider snaps to integer values on commit.
   */
  min?: number;
  max?: number;
}

export function SplitSlider({ factText, value, onChange, min, max }: Props) {
  const words = useMemo(() => getWords(factText), [factText]);
  const lo = min ?? 1;
  const hi = max ?? Math.max(lo, words.length - 1);
  const safeValue = Math.min(Math.max(value, lo), hi);
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  }, [lo, hi]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">
          Split position
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {safeValue} / {words.length}
        </span>
      </div>
      <div className="relative pt-1" style={{ touchAction: "none" }}>
        <Slider
          value={[safeValue]}
          min={lo}
          max={hi}
          step={1}
          onValueChange={(next) => {
            const n = next[0];
            if (typeof n === "number") onChange(Math.round(n));
          }}
        />
        <div className="mt-1 flex items-center justify-between px-1">
          {ticks.map((i) => (
            <span
              key={i}
              aria-hidden
              className={`h-1 w-px ${i === safeValue ? "bg-[#ff6b35]" : "bg-muted-foreground/30"}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
