/**
 * Every input where a personal name is typed uses this, so each one applies
 * the shared name rule the same way (identity-flow plan, Phase 2): a
 * character the rule does not admit is refused as it is typed, pasted or
 * committed from an IME, with a short hint, rather than removed later; the
 * curly apostrophe iOS types becomes `'`; and a name over the limit is
 * reported, never cut, so a paste is not silently shortened. While an IME
 * composition is open nothing is refused: the composition's intermediate text
 * is not the name, and filtering it would break the keyboard.
 *
 * @purpose Input props and hint state that apply the shared personal-name rule to a text field: refuses disallowed characters on change, paste and IME commit with a hint, converts curly apostrophes, reports the 50-grapheme limit without cutting, and leaves an open IME composition alone.
 * @subsystem accounts-auth
 */
import { useCallback, useRef, useState, type ChangeEvent, type CompositionEvent } from "react";
import {
  PERSONAL_NAME_HINT,
  PERSONAL_NAME_MAX_GRAPHEMES,
  countGraphemes,
  filterNameInput,
} from "@workspace/api-zod";

export interface NameFieldState {
  /** Spread onto the <input>. */
  inputProps: {
    value: string;
    onChange: (e: ChangeEvent<HTMLInputElement>) => void;
    onCompositionStart: () => void;
    onCompositionEnd: (e: CompositionEvent<HTMLInputElement>) => void;
    "aria-invalid": boolean;
  };
  /** The hint to show under the field, or null. */
  hint: string | null;
  /** True when the value is over the length limit. */
  tooLong: boolean;
}

export function useNameField(value: string, onValue: (next: string) => void): NameFieldState {
  const composing = useRef(false);
  const [refused, setRefused] = useState(false);

  const apply = useCallback(
    (raw: string) => {
      const { value: next, refused: didRefuse } = filterNameInput(raw);
      setRefused(didRefuse);
      onValue(next);
    },
    [onValue],
  );

  const onChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (composing.current) {
        onValue(e.target.value);
        return;
      }
      apply(e.target.value);
    },
    [apply, onValue],
  );

  const onCompositionStart = useCallback(() => {
    composing.current = true;
  }, []);

  const onCompositionEnd = useCallback(
    (e: CompositionEvent<HTMLInputElement>) => {
      composing.current = false;
      apply(e.currentTarget.value);
    },
    [apply],
  );

  const tooLong = countGraphemes(value.trim()) > PERSONAL_NAME_MAX_GRAPHEMES;
  const hint = tooLong
    ? `Names can be up to ${PERSONAL_NAME_MAX_GRAPHEMES} characters.`
    : refused
      ? PERSONAL_NAME_HINT
      : null;

  return {
    inputProps: { value, onChange, onCompositionStart, onCompositionEnd, "aria-invalid": tooLong },
    hint,
    tooLong,
  };
}

/** The hint line under a name field. Renders nothing when there is no hint. */
export function NameFieldHint({ hint, id }: { hint: string | null; id?: string }) {
  if (!hint) return null;
  return (
    <p id={id} role="status" data-testid="name-field-hint" className="mt-1 text-xs text-muted-foreground">
      {hint}
    </p>
  );
}
