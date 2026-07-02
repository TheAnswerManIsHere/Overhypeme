import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { normalizeHashtag, isDeniedHashtag } from "@workspace/api-zod";
import { FieldLabel } from "./FieldInfo";

/**
 * The moderator-curated FINAL discovery-tag list — the tags that actually ship
 * when a fact is approved. Seeded by the caller from the submitter's tags; the
 * AI's `suggestedHashtags` become a source to pull from, not the thing that
 * ships.
 *
 * This lived inside EnrichmentEditor's "review mode" (buried in Advanced
 * Options). It is now a first-class section of the Visual review step — see
 * FactVisualReviewGrid, which renders it between "How the AI read this fact"
 * and "Run test renders" — so the moderator sets discovery tags without
 * expanding the technical enrichment panel. Behaviour is unchanged; only the
 * placement moved.
 */
export function FinalHashtagsEditor({
  finalHashtags,
  onFinalHashtagsChange,
  aiSuggestions,
}: {
  finalHashtags: string[];
  onFinalHashtagsChange: (tags: string[]) => void;
  /** The AI's suggested tags — offered as a source to add from, not shipped. */
  aiSuggestions: string[];
}) {
  const [input, setInput] = useState("");
  const [rejected, setRejected] = useState<string | null>(null);
  const finalTags = finalHashtags;

  // Reject denied tags (subject name, app name, generic-humor) at Add time
  // rather than accepting them and stripping silently at approval — the admin
  // gets immediate feedback and the junk tag never enters the list.
  const addHashtag = (raw: string) => {
    const h = normalizeHashtag(raw);
    if (!h) { setInput(""); return; }
    if (isDeniedHashtag(h)) {
      setRejected(h);
      return; // keep the text in the box so the admin can edit it
    }
    if (!finalTags.includes(h)) onFinalHashtagsChange([...finalTags, h]);
    setRejected(null);
    setInput("");
  };
  const removeHashtag = (h: string) => onFinalHashtagsChange(finalTags.filter((x) => x !== h));
  // AI suggestions are denylist-stripped upstream, but filter defensively so a
  // stale/legacy suggestion can never be pulled in or swept in by "Add all".
  const aiSuggestionsNotInFinal = aiSuggestions.filter((t) => !finalTags.includes(t) && !isDeniedHashtag(t));

  return (
    <div className="rounded-sm border border-border bg-card p-3 space-y-3" data-testid="final-hashtags-editor">
      <div>
        <FieldLabel docKey="finalHashtags" />
        {finalTags.length === 0 ? (
          <p className="text-xs text-destructive flex items-center gap-1.5 mb-2" data-testid="final-hashtags-empty-warning">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            Add at least one hashtag — a fact can't be approved without tags. Clearing them all is usually a mistake.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground mb-2">
            The submitter's edited tags, ready for review. Remove or add as you see fit.
          </p>
        )}
        {finalTags.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">None</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {finalTags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border bg-primary/15 border-primary/40 text-primary"
              >
                {tag}
                <button type="button" onClick={() => removeHashtag(tag)} className="hover:opacity-70">
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2 mt-2">
          <input
            className="w-full px-3 py-2 bg-background border border-border rounded-sm text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            placeholder="Add hashtag…"
            value={input}
            onChange={(ev) => { setInput(ev.target.value); if (rejected) setRejected(null); }}
            onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); addHashtag(input); } }}
          />
          <button type="button" onClick={() => addHashtag(input)} className="px-3 py-1.5 text-sm border border-border rounded-sm hover:bg-muted text-foreground">Add</button>
        </div>
        {rejected && (
          <p className="text-xs text-destructive flex items-center gap-1.5 mt-1.5" data-testid="final-hashtags-rejected">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            "{rejected}" can't be a hashtag — subject names, the app name, and generic-humor tags (funny, joke, comedy, …) aren't allowed. Tag the fact's topic instead.
          </p>
        )}
        <p className="text-[11px] text-muted-foreground/70 mt-1.5">
          Subject names, the app's own tag, and generic-humor tags are rejected here and stripped on approval. At least one tag is required.
        </p>
      </div>

      {/* AI suggested — a source the moderator can pull from (not what ships). */}
      {aiSuggestionsNotInFinal.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <FieldLabel docKey="aiSuggestedHashtags" className="mb-0" />
            <button
              type="button"
              onClick={() => onFinalHashtagsChange(Array.from(new Set([...finalTags, ...aiSuggestionsNotInFinal])))}
              className="text-xs text-primary hover:underline"
            >
              Add all
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {aiSuggestionsNotInFinal.map((tag) => (
              <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border bg-muted/60 border-border text-muted-foreground">
                {tag}
                <button
                  type="button"
                  title="Add to final hashtags"
                  onClick={() => addHashtag(tag)}
                  className="hover:text-primary transition-colors"
                >
                  +
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
