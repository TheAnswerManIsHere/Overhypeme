import { useState } from "react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { HighlightedFactText } from "@/components/facts/HighlightedFactText";
import type { GagOption } from "./pictureApi";

/**
 * "Fact Visualization Options" (plan PLAN_PHASE7_AI_PICTURE_FLOW.md): each
 * gag the fact offers is a card of large thumbnails; tapping one opens a large
 * view with the gag's one-line description in the subject's name, "Select this
 * visualization option" and Close. With one gag nothing reads as a choice: the
 * card is "This fact's visualization" and its dialog has Close only. Several
 * examples of one gag illustrate that one option; they are not options.
 */

interface Props {
  gags: GagOption[];
  selectedGagId: number | null;
  onSelect: (gagId: number) => void;
  /** The picture's subject, whose name and pronouns the description is read in. */
  subjectName: string;
  subjectPronouns: string;
}

function shotsOf(g: GagOption): string[] {
  return [g.examples.male, g.examples.female, g.examples.pet].filter((u): u is string => !!u);
}

export function GagOptions({ gags, selectedGagId, onSelect, subjectName, subjectPronouns }: Props) {
  const [openId, setOpenId] = useState<number | null>(null);
  const single = gags.length === 1;
  const open = gags.find((g) => g.gagId === openId) ?? null;
  const optionLabel = (i: number) => (single ? "This fact's visualization" : `Option ${i + 1}`);

  return (
    <section className="space-y-2" aria-labelledby="gag-options-heading">
      <h2 id="gag-options-heading" className="text-sm font-medium">
        {single ? "This fact's visualization" : "Fact Visualization Options"}
      </h2>
      <div className={single ? "" : "grid grid-cols-1 gap-3 sm:grid-cols-2"}>
        {gags.map((g, i) => {
          const picked = !single && g.gagId === selectedGagId;
          const shots = shotsOf(g);
          return (
            <button
              key={g.gagId}
              type="button"
              onClick={() => setOpenId(g.gagId)}
              aria-label={`${optionLabel(i)}: view larger`}
              aria-current={picked ? "true" : undefined}
              className={`w-full rounded-lg border-2 p-2 text-left transition-colors ${picked ? "border-primary bg-primary/10" : "border-white/15 hover:border-white/30"}`}
              data-testid="ai-picture-gag"
            >
              <span className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>{single ? "Tap to view larger" : optionLabel(i)}</span>
                {picked && <span className="font-medium text-primary">Selected</span>}
              </span>
              <span className="flex gap-2">
                {shots.map((u) => (
                  <img key={u} src={u} alt="" className="aspect-[3/4] min-w-0 flex-1 rounded object-cover" loading="lazy" />
                ))}
                {shots.length === 0 && <span className="py-6 text-xs text-muted-foreground">No examples yet</span>}
              </span>
            </button>
          );
        })}
      </div>

      <Dialog open={open !== null} onOpenChange={(o) => { if (!o) setOpenId(null); }}>
        {open && (
          <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" data-testid="ai-picture-gag-dialog">
            <DialogTitle>{optionLabel(gags.indexOf(open))}</DialogTitle>
            <DialogDescription data-testid="ai-picture-gag-description">
              {open.description ? <HighlightedFactText template={open.description} name={subjectName} pronouns={subjectPronouns} /> : null}
            </DialogDescription>
            <div className="flex flex-col gap-3 sm:flex-row">
              {shotsOf(open).map((u) => (
                <img key={u} src={u} alt="An example of this visualization" className="min-w-0 flex-1 rounded object-contain" />
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <button type="button" className="rounded-md border border-white/20 px-4 py-2 text-sm">Close</button>
              </DialogClose>
              {!single && (
                <button
                  type="button"
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                  onClick={() => { onSelect(open.gagId); setOpenId(null); }}
                  data-testid="ai-picture-gag-select"
                >
                  Select this visualization option
                </button>
              )}
            </div>
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}
