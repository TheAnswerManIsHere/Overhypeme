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
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  }, [lo, hi]);

  const topHalf = words.slice(0, value).join(" ");
  const bottomHalf = words.slice(value).join(" ");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">
          Split position
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {value} / {words.length}
        </span>
      </div>
      <div className="relative pt-1">
        <Slider
          value={[value]}
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
              className={`h-1 w-px ${i === value ? "bg-[#ff6b35]" : "bg-muted-foreground/30"}`}
            />
          ))}
        </div>
      </div>
      <div className="grid gap-1 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs">
        <div>
          <span className="mr-2 uppercase tracking-wider text-muted-foreground">Top</span>
          <span className="font-medium">{topHalf || <em className="text-muted-foreground">empty</em>}</span>
        </div>
        <div>
          <span className="mr-2 uppercase tracking-wider text-muted-foreground">Bottom</span>
          <span className="font-medium">{bottomHalf || <em className="text-muted-foreground">empty</em>}</span>
        </div>
      </div>
    </div>
  );
}
