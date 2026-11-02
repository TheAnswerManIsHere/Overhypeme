/**
 * Every input where a personal name is typed uses this, so each one applies
 * the shared name rule the same way (identity-flow plan, Phase 2): a
 * character the rule does not admit is refused as it is typed, pasted or
 * committed from an IME, with a short hint, rather than removed later; the
 * curly apostrophe iOS types becomes `'`; and the field stops at the 50-character
 * limit, typed or pasted, saying so (David, 2026-11-02: "simply don't allow
 * the bad behavior"), with a running count as it nears the limit. While an IME
 * composition is open nothing is refused: the composition's intermediate text
 * is not the name, and filtering it would break the keyboard.
 *
 * @purpose Input props and hint state that apply the shared personal-name rule to a text field: refuses disallowed characters on change, paste and IME commit with a hint, converts curly apostrophes, stops at the 50-grapheme limit (typed or pasted) with a hint and a running count near it, and leaves an open IME composition alone.
 * @subsystem accounts-auth
 */
import { useCallback, useRef, useState, type ChangeEvent, type CompositionEvent } from "react";
import {
  PERSONAL_NAME_HINT,
  PERSONAL_NAME_MAX_GRAPHEMES,
  countGraphemes,
  filterNameInput,
  truncateGraphemes,
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
  const [cut, setCut] = useState(false);

  const apply = useCallback(
    (raw: string) => {
      const { value: filtered, refused: didRefuse } = filterNameInput(raw);
      // The field stops at the limit (David, 2026-11-02): characters past it
      // are not taken, typed or pasted, so a name can never be too long to
      // save, and the hint says why the typing stopped.
      const next = truncateGraphemes(filtered, PERSONAL_NAME_MAX_GRAPHEMES);
      setRefused(didRefuse);
      setCut(next !== filtered);
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

  // Only a value the field never filtered (a pre-filled one) can be over.
  const length = countGraphemes(value);
  const tooLong = countGraphemes(value.trim()) > PERSONAL_NAME_MAX_GRAPHEMES;
  const atLimit = length >= PERSONAL_NAME_MAX_GRAPHEMES;
  const hint = cut || tooLong
    ? `Names can be up to ${PERSONAL_NAME_MAX_GRAPHEMES} characters, so the rest wasn't added.`
    : refused
      ? PERSONAL_NAME_HINT
      : atLimit
        ? `That's the ${PERSONAL_NAME_MAX_GRAPHEMES}-character limit for names.`
        : length >= PERSONAL_NAME_MAX_GRAPHEMES - 10
          ? `${length} of ${PERSONAL_NAME_MAX_GRAPHEMES} characters`
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
