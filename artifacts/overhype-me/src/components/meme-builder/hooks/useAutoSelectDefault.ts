import { useEffect, useRef } from "react";

/**
 * Pickers in the meme builder routinely show a default UI selection (e.g.
 * `StockImagePicker` highlights its pre-seeded `selectedId`; `MyImagePicker`
 * defaults the active tab to `"primary"` when an avatar exists). When that
 * default is purely visual the parent reducer never receives the selection,
 * the live preview can't resolve a background URL, and the canvas renders as
 * a black box behind the text. This pattern has shipped at least three times
 * — see task #495.
 *
 * This hook gives every picker the same guard: when the default becomes
 * resolvable, fire `onSelect` exactly once with the *full* source object (not
 * just an id), so the builder's reducer can put it on `state` immediately.
 *
 * The ref-based dedupe key means re-renders don't repeatedly dispatch — only
 * a change in `identityKey` (e.g. switching tabs or changing the seeded
 * stock id) re-arms the auto-select.
 */
export function useAutoSelectDefault<T>(args: {
  /** Gate flag — when false the hook does nothing. */
  enabled: boolean;
  /** Stable id for the default value; changing it re-arms the dispatch. */
  identityKey: string | null;
  /** Resolves the default value lazily. Return null if not yet resolvable. */
  resolveDefault: () => T | null;
  /** Receives the resolved default at most once per identityKey. */
  onSelect: (value: T) => void;
}): void {
  const { enabled, identityKey, resolveDefault, onSelect } = args;
  const hydratedRef = useRef<string | null>(null);
  // Refs keep `resolveDefault` / `onSelect` referentially stable so callers
  // don't need to memoize — the effect only re-runs when `identityKey` or
  // `enabled` actually change.
  const resolveRef = useRef(resolveDefault);
  resolveRef.current = resolveDefault;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!enabled || !identityKey) return;
    if (hydratedRef.current === identityKey) return;
    const value = resolveRef.current();
    if (value === null || value === undefined) return;
    hydratedRef.current = identityKey;
    onSelectRef.current(value);
  }, [enabled, identityKey]);
}
