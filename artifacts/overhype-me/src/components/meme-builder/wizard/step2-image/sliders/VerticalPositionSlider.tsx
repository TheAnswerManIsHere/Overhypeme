import { Slider } from "@/components/ui/slider";

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

/**
 * Continuous 0..100 slider with externally-supplied clamp bounds. The parent
 * computes `min`/`max` from `computeTextCollisionConstraints` so top/bottom
 * blocks never overlap.
 */
export function VerticalPositionSlider({ label, value, min, max, onChange }: Props) {
  const clamped = Math.min(Math.max(value, min), max);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{clamped}%</span>
      </div>
      <Slider
        value={[clamped]}
        min={min}
        max={max}
        step={1}
        onValueChange={(next) => {
          const n = next[0];
          if (typeof n === "number") onChange(Math.round(n));
        }}
      />
    </div>
  );
}
