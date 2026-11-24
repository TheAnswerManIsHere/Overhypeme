import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { normalizeHashtag, isDeniedHashtag } from "@workspace/api-zod";
import { FieldLabel } from "./FieldInfo";

/**
 * The moderator-curated FINAL discovery-tag list — the tags that actually ship
 * when a fact is approved. Seeded by the caller from the submitter's tags.
 * Hashtags are generated once, by the AI suggester on the submit form where the
 * submitter reviews them; moderation edits that list by hand and generates none
 * of its own (David, 2026-11-24).
 *
 * A section of its own on the moderation review's Test Renders step, above the
 * gags (plan PLAN_GAG_EXAMPLES.md, which retired the review-wide render grid
 * it used to sit in), so the moderator sets discovery tags without expanding
 * the technical enrichment panel.
 */
/**
 * The editor's helper lines, by where it sits: a review being moderated, or an
 * approved fact's sheet, where each change saves at once and nothing is
 * "approved" any more (Issue #1018, the 3.2 inputs from 3.1).
 */
const COPY = {
  moderation: {
    empty: "Add at least one hashtag — a fact can't be approved without tags. Clearing them all is usually a mistake.",
    intro: "The submitter's edited tags, ready for review. Remove or add as you see fit.",
    rules: "Subject names, the app's own tag, and generic-humor tags are rejected here and stripped on approval. At least one tag is required.",
  },
  live: {
    empty: "Add at least one hashtag — a fact always keeps at least one, so this change isn't saved.",
    intro: "The hashtags members find this fact by. Each add or remove saves at once.",
    rules: "Subject names, the app's own tag, and generic-humor tags are refused. At least one tag is required.",
  },
} as const;

export function FinalHashtagsEditor({
  finalHashtags,
  onFinalHashtagsChange,
  context = "moderation",
}: {
  finalHashtags: string[];
  onFinalHashtagsChange: (tags: string[]) => void;
  /** Where the editor sits: a review being moderated (the default), or an approved fact's sheet. */
  context?: keyof typeof COPY;
}) {
  const copy = COPY[context];
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

  return (
    <div className="rounded-sm border border-border bg-card p-3 space-y-3" data-testid="final-hashtags-editor">
      <div>
        <FieldLabel docKey="finalHashtags" />
        {finalTags.length === 0 ? (
          <p className="text-xs text-destructive flex items-center gap-1.5 mb-2" data-testid="final-hashtags-empty-warning">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            {copy.empty}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground mb-2">
            {copy.intro}
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
                <button type="button" onClick={() => removeHashtag(tag)} className="hover:opacity-70" aria-label={`Remove ${tag}`}>
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
          {copy.rules}
        </p>
      </div>

    </div>
  );
}
