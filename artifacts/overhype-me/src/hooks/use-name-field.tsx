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
  graphemeClusters,
  truncateGraphemes,
} from "@workspace/api-zod";

/**
 * Apply the length limit to one edit: the text before and after the span the
 * edit touched is kept as it was, and of the text the edit added only as much
 * as fits is taken. Cutting the whole new value instead would drop the end of
 * the name when someone types or pastes before it (Codex, PR #838). Measured
 * in grapheme clusters, the rule's unit. A value already over the limit (a
 * stored name from before the rule) leaves no room: additions are refused and
 * deletions still go through. `tail`, when known, is the text after the caret
 * once the edit is made — the input's own word for where the edit ended — and
 * bounds the untouched end, so a replacement that happens to share letters
 * with what it replaced is not mistaken for a shorter edit.
 */
export function limitNameEdit(previous: string, next: string, max: number, tail?: string): string {
  const before = graphemeClusters(previous);
  const after = graphemeClusters(next);
  if (after.length <= max) return next;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  const tailMax = tail !== undefined && next.endsWith(tail) ? graphemeClusters(tail).length : Infinity;
  let end = 0;
  while (
    end < tailMax &&
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) end++;
  const kept = start + end;
  const added = after.slice(start, after.length - end).join("");
  const room = Math.max(0, max - kept);
  return after.slice(0, start).join("") + truncateGraphemes(added, room) + after.slice(after.length - end).join("");
}

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
  // The name as it stood when an IME composition began. While composing, the
  // provisional text is published as the value, so at commit the edit is
  // measured against this, not against text that was never accepted (Codex,
  // PR #838 round 2).
  const beforeComposition = useRef<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [cut, setCut] = useState(false);

  const apply = useCallback(
    (raw: string, caret: number | null, previous: string = value) => {
      const { value: filtered, refused: didRefuse } = filterNameInput(raw);
      const tail = caret === null ? undefined : filterNameInput(raw.slice(caret)).value;
      // The field stops at the limit (David, 2026-11-02): characters past it
      // are not taken, typed or pasted, so a name can never be too long to
      // save, and the hint says why the typing stopped. Only the edit's own
      // addition is cut; the rest of the name is never touched.
      const next = limitNameEdit(previous, filtered, PERSONAL_NAME_MAX_GRAPHEMES, tail);
      setRefused(didRefuse);
      setCut(next !== filtered);
      onValue(next);
    },
    [onValue, value],
  );

  const onChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (composing.current) {
        onValue(e.target.value);
        return;
      }
      apply(e.target.value, e.target.selectionEnd);
    },
    [apply, onValue],
  );

  const onCompositionStart = useCallback(() => {
    if (!composing.current) beforeComposition.current = value;
    composing.current = true;
  }, [value]);

  const onCompositionEnd = useCallback(
    (e: CompositionEvent<HTMLInputElement>) => {
      composing.current = false;
      const previous = beforeComposition.current ?? value;
      beforeComposition.current = null;
      apply(e.currentTarget.value, e.currentTarget.selectionEnd, previous);
    },
    [apply, value],
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
