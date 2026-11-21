/**
 * Text helpers for the Visual Concept card (a gag's scene): the personalization
 * token chips, inserting a token at the caret, the scene's character cap, and
 * applying a typed scene to the gag's content. They lived in the old taxonomy
 * editor (`EnrichmentEditor`), which went with the override system (plan
 * PLAN_FACT_LIFECYCLE_REBUILD.md, 2A); the Visual Concept card is their only
 * user.
 */
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  SCENE_RAW_MAX_CHARS,
  canonicalizeNameToken,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";

/**
 * Personalization tokens offered as one-click chips. Kept in lock-step with the
 * api-zod allowlist (`ALLOWED_SIMPLE_TOKENS` / `canonicalizeNameToken`); legend
 * order = display order. A unit test pins this to the intended set so the
 * duplicated list can't silently drift from the validator.
 */
export const OVERRIDE_TOKEN_CHIPS = [
  "{NAME}",
  "{NAME_POSSESSIVE}",
  "{SUBJ}",
  "{OBJ}",
  "{POSS}",
  "{POSS_PRO}",
  "{REFL}",
] as const;

/**
 * Insert `token` into a controlled <input>/<textarea> at the caret, replacing
 * any selected range. Writes through the element's native value setter and
 * dispatches a bubbling `input` event so React's controlled `onChange` fires
 * (running the field's existing `canonicalizeNameToken`). Restores the caret to
 * just after the inserted token on the next frame, so a re-render can't clobber
 * it. Returns false if the element can't be written (no native setter).
 */
export function insertTokenIntoTextControl(
  el: HTMLInputElement | HTMLTextAreaElement,
  token: string,
): boolean {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setValue) return false;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const next = el.value.slice(0, start) + token + el.value.slice(end);
  setValue.call(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  const caret = start + token.length;
  requestAnimationFrame(() => {
    try {
      el.focus();
      el.setSelectionRange(caret, caret);
    } catch {
      /* element unmounted between click and frame — nothing to restore */
    }
  });
  return true;
}

/** Max chars for the moderator-authored core scene: the zod cap itself. */
export const CORE_SCENE_MAX_CHARS = SCENE_RAW_MAX_CHARS;

/**
 * Apply a moderator-typed visual concept (core scene) to the gag's content.
 * Canonicalizes name tokens; every other field is preserved untouched.
 */
export function withCoreSceneOverride(
  ov: VisualPromptStrategyOverride | undefined,
  text: string,
): VisualPromptStrategyOverride {
  const base = ov ?? EMPTY_VISUAL_STRATEGY_OVERRIDE;
  const canonical = canonicalizeNameToken(text);
  return { ...base, coreSceneOverride: canonical };
}
