import { useEffect, useState } from "react";

/**
 * Returns the input value, delayed by `delayMs`. While the input keeps
 * changing, the returned value stays at its previous setting; once `delayMs`
 * has elapsed since the last input change, it catches up.
 *
 * Used by the stock image picker so scrubbing through thumbnails doesn't
 * spam /api/render-preview.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
