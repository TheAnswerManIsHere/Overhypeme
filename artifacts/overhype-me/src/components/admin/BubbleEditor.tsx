/**
 * BubbleEditor — the ONE speech/thought-bubble editor, rendered on BOTH
 * surfaces (first-class beside the Visual Concept card on Moderation, and
 * inside the Advanced VSO panel) editing the same
 * `enrichment.visualPromptStrategyOverride.bubbles` draft, so the two
 * placements can never drift.
 *
 * Each row: type (Speech = tailed balloon / Thought = cloud + trail), WHO —
 * picked from a dropdown of the subject, the fact's characters and this gag's
 * extra Scene Role Assignments; a saved speaker matching none of them is
 * shown as itself and saved unchanged (PLAN_BUBBLE_SPEAKERS.md, C) — and
 * the exact literal text (token-capable, ≤80 chars, soft warning at 60 —
 * legibility drops with length). Incomplete rows are ignored at compile.
 * Save flows through the existing whole-override tokenize/save path; the
 * bubble prompt-budget pool is enforced server-side with a field-specific
 * error.
 */
import { AlertTriangle, Plus, Trash2, MessageCircle } from "lucide-react";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  canonicalizeNameToken,
  BUBBLE_TEXT_MAX_CHARS,
  BUBBLE_TEXT_SOFT_WARN,
  MAX_BUBBLES,
  type FactCharacter,
  type VisualPromptStrategyOverride,
  type VisualStrategyBubble,
} from "@workspace/api-zod";
import { FieldLabel } from "./FieldInfo";
import { useFactCharacters } from "./FactCharactersContext";
import { buildCastSpeakerOptions, buildSpeakerOptions, selectedSpeakerValue, type CastForSpeakers } from "./speakerOptions";

const INPUT_CLASS =
  "w-full px-3 py-2 bg-background border border-border rounded-sm text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary";

function TokenizeError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="text-xs text-destructive flex items-start gap-1 mt-0.5">
      <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {message}
    </p>
  );
}

/**
 * Apply a bubbles list to the override blob. Presence-based activation (the
 * enable toggle was retired): bubbles apply whenever a row carries content, so
 * there is no side effect to flip — every other field is preserved untouched.
 */
export function withBubbles(
  ov: VisualPromptStrategyOverride | undefined,
  bubbles: VisualStrategyBubble[],
): VisualPromptStrategyOverride {
  const base = ov ?? EMPTY_VISUAL_STRATEGY_OVERRIDE;
  return { ...base, bubbles };
}

export function BubbleEditor({
  value,
  onChange,
  disabled = false,
  fieldErrors,
  firstClass = false,
  characters: charactersProp,
  cast,
}: {
  value: VisualPromptStrategyOverride | undefined;
  onChange: (next: VisualPromptStrategyOverride) => void;
  /** Disable while a tokenize-and-save round trip is in flight. */
  disabled?: boolean;
  /** Path → tokenize error (`bubbles[i].entity` / `bubbles[i].text`) from
   *  `useFactEnrichmentEditing`'s `vsoTokenizeErrors`. */
  fieldErrors?: Record<string, string>;
  /** First-class placement (own card chrome beside the Visual Concept card);
   *  false = embedded row inside the Advanced VSO panel. */
  firstClass?: boolean;
  /** The fact's effective characters; defaults to the gags panel's context. */
  characters?: readonly FactCharacter[];
  /**
   * The gag card's cast (plan PLAN_GAG_DIRECT_RENDER.md, F). When given, the
   * speakers are the subject and the cast, not the fact's characters.
   */
  cast?: CastForSpeakers;
}) {
  const ov = value ?? EMPTY_VISUAL_STRATEGY_OVERRIDE;
  const bubbles = ov.bubbles ?? [];
  const contextCharacters = useFactCharacters();
  const characters = charactersProp ?? contextCharacters;
  // The speaker choices (PLAN_BUBBLE_SPEAKERS.md, C): the subject, the fact's
  // characters, this gag's extra roles, and any saved speaker that matches
  // none of those — shown as itself and saved unchanged.
  const speakerOptions = cast
    ? buildCastSpeakerOptions({ cast, currentSpeakers: bubbles.map((b) => b.entity) })
    : buildSpeakerOptions({
      characters,
      roleBindings: ov.roleBindings,
      currentSpeakers: bubbles.map((b) => b.entity),
    });

  const setBubbles = (next: VisualStrategyBubble[]) => onChange(withBubbles(value, next));
  const setRow = (i: number, patch: Partial<VisualStrategyBubble>) => {
    const next = bubbles.slice();
    next[i] = { ...next[i]!, ...patch };
    setBubbles(next);
  };

  // Soft warnings (advisory — the server-side compile diagnostics are the
  // durable mirror): an entity that matches neither "subject" nor any role
  // binding may still be a planner-established character, so it's a nudge,
  // never a gate; duplicate role-binding labels make tail attribution
  // ambiguous.
  const knownEntities = new Set(
    [...ov.roleBindings.map((b) => b.entity), ...characters.map((c) => c.label)]
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean),
  );
  const warnings: string[] = [];
  const castLabels = new Set((cast?.entries ?? []).map((c) => c.label.trim().toLowerCase()));
  for (const [i, b] of bubbles.entries()) {
    const entity = b.entity.trim().toLowerCase();
    if (cast) {
      // On a gag card the scene decides who can speak: a speaker it does not show stops the save.
      if (cast.read && entity && entity !== "subject" && !castLabels.has(entity)) {
        warnings.push(`Bubble ${i + 1}: the scene does not show "${b.entity.trim()}". Pick another speaker, or say in the scene that they are there; the gag will not save until you do.`);
      }
      continue;
    }
    if (!entity || entity === "subject" || knownEntities.has(entity)) continue;
    warnings.push(
      `Bubble ${i + 1}: "${b.entity.trim()}" isn't in this fact's character list or this gag's Scene Role Assignments — it still renders, but add the character to one of them so the picture is sure to include them.`,
    );
  }
  const labelCounts = new Map<string, number>();
  for (const rb of ov.roleBindings) {
    const k = rb.entity.trim().toLowerCase();
    if (k) labelCounts.set(k, (labelCounts.get(k) ?? 0) + 1);
  }
  for (const [i, b] of bubbles.entries()) {
    const k = b.entity.trim().toLowerCase();
    if (!cast && k && (labelCounts.get(k) ?? 0) > 1) {
      warnings.push(
        `Bubble ${i + 1}: more than one Scene Role Assignment is labeled "${b.entity.trim()}" — the balloon's tail may attach to the wrong one.`,
      );
    }
  }

  const body = (
    <div className="space-y-1.5">
      {bubbles.map((b, i) => {
        const len = b.text.length;
        const nearCap = len >= BUBBLE_TEXT_SOFT_WARN;
        return (
          <div key={i} data-testid="bubble-row">
            <div className="flex gap-2 items-start">
              <select
                className={`${INPUT_CLASS} max-w-[6.5rem]`}
                data-testid="bubble-type"
                disabled={disabled}
                value={b.type}
                onChange={(ev) => setRow(i, { type: ev.target.value as VisualStrategyBubble["type"] })}
              >
                <option value="speech">Speech</option>
                <option value="thought">Thought</option>
              </select>
              <div className="max-w-[12rem]">
                <select
                  className={INPUT_CLASS}
                  data-testid="bubble-entity"
                  aria-label={`Bubble ${i + 1} speaker`}
                  value={selectedSpeakerValue(speakerOptions, b.entity)}
                  disabled={disabled}
                  onChange={(ev) => setRow(i, { entity: ev.target.value })}
                >
                  {speakerOptions.map((o) => (
                    <option key={`${o.source}:${o.value}`} value={o.value} data-source={o.source}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <input
                  className={INPUT_CLASS}
                  data-token-insert-target="true"
                  data-testid="bubble-text"
                  value={b.text}
                  placeholder='exact line, e.g. "You&apos;re the man of the house now."'
                  maxLength={BUBBLE_TEXT_MAX_CHARS}
                  disabled={disabled}
                  onChange={(ev) => setRow(i, { text: canonicalizeNameToken(ev.target.value) })}
                />
                <p className={`text-[10px] text-right ${nearCap ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
                  {len}/{BUBBLE_TEXT_MAX_CHARS}
                  {nearCap ? " — shorter renders more reliably" : ""}
                </p>
              </div>
              <button
                type="button"
                disabled={disabled}
                onClick={() => setBubbles(bubbles.filter((_, idx) => idx !== i))}
                className="px-2 border border-border rounded-sm hover:bg-muted text-muted-foreground disabled:opacity-50"
                aria-label="Remove bubble"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <TokenizeError message={fieldErrors?.[`bubbles[${i}].entity`]} />
            <TokenizeError message={fieldErrors?.[`bubbles[${i}].text`]} />
          </div>
        );
      })}
      {warnings.map((w, i) => (
        <p key={i} className="text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-1">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {w}
        </p>
      ))}
      <button
        type="button"
        data-testid="bubble-add"
        disabled={disabled || bubbles.length >= MAX_BUBBLES}
        onClick={() => setBubbles([...bubbles, { type: "speech", entity: "subject", text: "" }])}
        className="inline-flex items-center gap-1 px-3 py-1.5 text-sm border border-border rounded-sm hover:bg-muted text-foreground disabled:opacity-50"
      >
        <Plus className="w-3 h-3" /> Add bubble
      </button>
      {bubbles.length >= MAX_BUBBLES && (
        <p className="text-[10px] text-muted-foreground">Maximum {MAX_BUBBLES} bubbles (1–2 works best).</p>
      )}
    </div>
  );

  if (!firstClass) {
    return (
      <div data-testid="bubble-editor">
        <FieldLabel docKey="vso.bubbles" />
        {body}
      </div>
    );
  }
  return (
    <div className="bg-background border-2 border-border rounded-sm p-4 space-y-2" data-testid="bubble-editor">
      <div className="flex items-center gap-1.5">
        <MessageCircle className="w-4 h-4 text-muted-foreground" />
        <FieldLabel docKey="vso.bubbles" />
      </div>
      <p className="text-xs text-muted-foreground">
        {cast
          ? "Make a character speak or think an exact line — the balloon and lettering are rendered into the image. Pick who says it from the subject and the people in this scene; to add someone, say in the scene that they are there. Keep the text short."
          : "Make a character speak or think an exact line — the balloon and lettering are rendered into the image. Pick who says it from the fact's characters or this gag's Scene Role Assignments; keep the text short."}
      </p>
      {body}
    </div>
  );
}
