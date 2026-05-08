import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { STYLIZE_TOGGLE_COPY } from "../copy";

interface Props {
  enabled: boolean;
  onChange: (next: boolean) => void;
  /** When true, disables the toggle (e.g. user picked an existing AI styling already). */
  disabled?: boolean;
  disabledReason?: string;
}

export function StylizeToggle({ enabled, onChange, disabled, disabledReason }: Props) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-start gap-3">
        <Switch
          id="meme-builder-stylize"
          checked={enabled}
          onCheckedChange={onChange}
          disabled={disabled}
        />
        <div className="grid gap-1">
          <Label htmlFor="meme-builder-stylize" className="font-display text-base uppercase">
            {STYLIZE_TOGGLE_COPY.label}
          </Label>
          <p className="text-xs text-muted-foreground">
            {disabled && disabledReason ? disabledReason : STYLIZE_TOGGLE_COPY.helper}
          </p>
        </div>
      </div>
    </div>
  );
}
