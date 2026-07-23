/**
 * BubbleEditor — the ONE speech/thought-bubble editor, rendered on BOTH
 * surfaces (first-class beside the Visual Concept card on Moderation, and
 * inside the Advanced VSO panel) editing the same
 * `enrichment.visualPromptStrategyOverride.bubbles` draft, so the two
 * placements can never drift.
 *
 * Each row: type (Speech = tailed balloon / Thought = cloud + trail), WHO
 * (same rules as a role-binding entity — "subject" or a plain role label,
 * never a token; a typed subject name collapses to "subject" on Save), and
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
  BUBBLE_ENTITY_MAX_CHARS,
  MAX_BUBBLES,
  type VisualPromptStrategyOverride,
  type VisualStrategyBubble,
} from "@workspace/api-zod";
import { FieldLabel } from "./FieldInfo";

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
}) {
  const ov = value ?? EMPTY_VISUAL_STRATEGY_OVERRIDE;
  const bubbles = ov.bubbles ?? [];

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
    ov.roleBindings.map((b) => b.entity.trim().toLowerCase()).filter(Boolean),
  );
  const warnings: string[] = [];
  for (const [i, b] of bubbles.entries()) {
    const entity = b.entity.trim().toLowerCase();
    if (!entity || entity === "subject" || knownEntities.has(entity)) continue;
    warnings.push(
      `Bubble ${i + 1}: "${b.entity.trim()}" doesn't match "subject" or any Scene Role Assignment — fine if the character is described in the Concept, but double-check for typos.`,
    );
  }
  const labelCounts = new Map<string, number>();
  for (const rb of ov.roleBindings) {
    const k = rb.entity.trim().toLowerCase();
    if (k) labelCounts.set(k, (labelCounts.get(k) ?? 0) + 1);
  }
  for (const [i, b] of bubbles.entries()) {
    const k = b.entity.trim().toLowerCase();
    if (k && (labelCounts.get(k) ?? 0) > 1) {
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
              <div className="max-w-[8rem]">
                <input
                  className={INPUT_CLASS}
                  data-testid="bubble-entity"
                  value={b.entity}
                  placeholder="subject or role label"
                  maxLength={BUBBLE_ENTITY_MAX_CHARS}
                  disabled={disabled}
                  onChange={(ev) => {
                    // NOT a chip target and NOT canonicalized — an entity is a
                    // plain "subject"/role label; a typed token is an error
                    // Save surfaces, not something to silently rewrite.
                    setRow(i, { entity: ev.target.value });
                  }}
                />
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
        Make a character speak or think an exact line — the balloon and lettering are rendered into the
        image. Attribute it to <span className="font-mono">subject</span> or a plain role label; keep the
        text short.
      </p>
      {body}
    </div>
  );
}
