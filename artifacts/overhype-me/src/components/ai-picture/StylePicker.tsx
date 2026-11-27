import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { lookPreviewUrl, type LookStyle } from "./pictureApi";

/**
 * "Stylize it" (plan PLAN_PHASE7_AI_PICTURE_FLOW.md): a labelled dropdown with
 * a visible chevron, "No style (photoreal)" first, and under it the chosen
 * style's sample where one exists, tappable to enlarge. A style without a
 * sample shows none.
 */

interface Props {
  looks: LookStyle[];
  value: string | null;
  onChange: (id: string | null) => void;
}

export function StylePicker({ looks, value, onChange }: Props) {
  const [enlarged, setEnlarged] = useState(false);
  const chosen = looks.find((l) => l.id === value) ?? null;
  const sample = lookPreviewUrl(chosen?.previewImagePath ?? null);

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium"><label htmlFor="ai-picture-style">Stylize it</label></h2>
      <div className="relative">
        <select
          id="ai-picture-style"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          className="w-full appearance-none rounded-md border border-white/20 bg-secondary px-3 py-2 pr-9 text-sm"
          data-testid="ai-picture-style"
        >
          <option value="">No style (photoreal)</option>
          {looks.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
        <ChevronDown aria-hidden className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      </div>
      {chosen?.description && <p className="text-xs text-muted-foreground">{chosen.description}</p>}
      {sample && chosen && (
        <>
          <button type="button" onClick={() => setEnlarged(true)} aria-label={`${chosen.label} sample: view larger`} data-testid="ai-picture-style-sample">
            <img src={sample} alt="" className="h-28 rounded object-cover" loading="lazy" />
          </button>
          <Dialog open={enlarged} onOpenChange={setEnlarged}>
            <DialogContent className="max-w-2xl">
              <DialogTitle>{chosen.label}</DialogTitle>
              <img src={sample} alt={`A sample of the ${chosen.label} style`} className="w-full rounded object-contain" />
            </DialogContent>
          </Dialog>
        </>
      )}
    </section>
  );
}
