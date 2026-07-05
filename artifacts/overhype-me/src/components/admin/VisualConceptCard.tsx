/**
 * "Visual concept — describe the picture" — the moderator's primary lever for
 * getting the render right. One prominent textarea that writes
 * `enrichment.visualPromptStrategyOverride.coreSceneOverride` (auto-enabling
 * the override via `withCoreSceneOverride`); the compiler emits it as the
 * required, never-compressed CORE SCENE and the planner LLM is directed to
 * realize exactly this scene. The same field appears inside the Visual
 * Strategy Override panel (Advanced Options) — both edit the same blob through
 * the same draft, so there is no conflict.
 */
import { useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import {
  firstOverrideTokenError,
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import {
  withCoreSceneOverride,
  insertTokenIntoTextControl,
  OVERRIDE_TOKEN_CHIPS,
  CORE_SCENE_MAX_CHARS,
} from "./EnrichmentEditor";

const VISUAL_CONCEPT_TOKEN_EXAMPLES: Record<(typeof OVERRIDE_TOKEN_CHIPS)[number], string> = {
  "{NAME}": "David",
  "{NAME_POSSESSIVE}": "David’s",
  "{SUBJ}": "he",
  "{OBJ}": "him",
  "{POSS}": "his",
  "{POSS_PRO}": "his",
  "{REFL}": "himself",
};

export function VisualConceptCard({
  value,
  onChange,
  disabled,
}: {
  value: VisualPromptStrategyOverride | undefined;
  onChange: (next: VisualPromptStrategyOverride) => void;
  disabled?: boolean;
}) {
  const ov = value ?? EMPTY_VISUAL_STRATEGY_OVERRIDE;
  const text = ov.coreSceneOverride ?? "";
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const [chipNote, setChipNote] = useState<string | null>(null);

  const tokenErr = text.trim() ? firstOverrideTokenError({ ...ov, coreSceneOverride: text }) : null;

  const handleChip = (token: string) => {
    const el = fieldRef.current;
    if (el && el.isConnected) {
      insertTokenIntoTextControl(el, token);
      setChipNote(null);
      return;
    }
    setChipNote(`Click into the field first, then click ${token}.`);
  };

  return (
    <div className="bg-background border-2 border-border rounded-sm p-4 space-y-2" data-testid="visual-concept-card">
      <div>
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">
          Visual concept — describe the picture
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Describe the picture: subject, action, setting, objects, composition. This wins over the AI's
          scene. Don't write engine instructions ("preserve identity", "use the reference photo",
          "no logos") — the compiler owns those and will strip them.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-1">Insert token:</span>
        {OVERRIDE_TOKEN_CHIPS.map((token) => (
          <button
            key={token}
            type="button"
            data-testid="visual-concept-token-chip"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleChip(token)}
            className="inline-flex items-baseline gap-1 px-1.5 py-0.5 text-[11px] rounded-sm border border-border bg-background hover:bg-muted text-foreground"
            disabled={disabled}
          >
            <span className="font-mono">{token}</span>
            <span className="text-muted-foreground">{VISUAL_CONCEPT_TOKEN_EXAMPLES[token]}</span>
          </button>
        ))}
      </div>
      {chipNote && <p className="text-[11px] text-muted-foreground">{chipNote}</p>}

      <textarea
        ref={fieldRef}
        className="w-full rounded-sm border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none disabled:opacity-60"
        rows={3}
        placeholder='e.g. {NAME} triumphantly holds a participation trophy the size of a grain of rice, photographed like a championship victory.'
        data-token-insert-target="true"
        data-testid="visual-concept-textarea"
        maxLength={CORE_SCENE_MAX_CHARS}
        value={text}
        disabled={disabled}
        onChange={(ev) => onChange(withCoreSceneOverride(value, ev.target.value))}
      />

      <div className="flex items-start justify-between gap-2">
        {tokenErr ? (
          <p className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1">
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
            Invalid token: {tokenErr}. Use {"{NAME}"}, {"{NAME_POSSESSIVE}"}, and pronoun tokens only.
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Saved with the Visual Strategy draft below — test renders flag stale automatically.
          </p>
        )}
        <p className="text-[10px] text-muted-foreground shrink-0">
          {text.length}/{CORE_SCENE_MAX_CHARS}
        </p>
      </div>
    </div>
  );
}
