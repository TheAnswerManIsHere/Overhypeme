import { Button } from "@/components/ui/Button";
import { STYLIZE_TOGGLE_COPY } from "../copy";

interface Props {
  open: boolean;
  /** 0..1 progress estimate. */
  progress: number;
  onCancel: () => void;
}

/**
 * Blocking overlay shown while PuLID is generating. Per Phase-3 product
 * decision (O10): PuLID generation can take 30+ seconds, but we keep the
 * builder modal open and prevent further interaction until it completes.
 *
 * The progress bar is an estimate (no real progress signal from fal.subscribe);
 * we just cap it at 95% until the request completes.
 */
export function PulidProgressOverlay({ open, progress, onCancel }: Props) {
  if (!open) return null;
  const pct = Math.min(95, Math.max(0, Math.round(progress * 100)));
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="w-[min(92vw,420px)] space-y-4 rounded-md border border-border bg-background p-6 text-center">
        <p className="font-display text-xl uppercase">{STYLIZE_TOGGLE_COPY.inProgress}</p>
        <p className="text-sm text-muted-foreground">{STYLIZE_TOGGLE_COPY.inProgressNote}</p>
        <div className="h-2 overflow-hidden rounded-full bg-secondary/40" role="progressbar" aria-valuenow={pct}>
          <div className="h-full bg-primary transition-[width] duration-300 ease-out" style={{ width: `${pct}%` }} />
        </div>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {STYLIZE_TOGGLE_COPY.cancel}
        </Button>
      </div>
    </div>
  );
}
