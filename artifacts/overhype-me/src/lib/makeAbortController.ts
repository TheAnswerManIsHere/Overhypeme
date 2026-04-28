/**
 * Creates a handle that aborts the previous in-flight request each time
 * `.next()` is called, and exposes `.isLatest()` so the caller can skip
 * state updates that belong to a superseded request.
 *
 * Used by fetchMembership in pages/admin/users.tsx to prevent a slow
 * response for user A from overwriting the membership panel after the
 * admin has already selected user B.
 */
export function makeAbortController() {
  let current: AbortController | null = null;
  return {
    next() {
      current?.abort();
      const ctrl = new AbortController();
      current = ctrl;
      return {
        signal: ctrl.signal,
        isLatest: () => current === ctrl,
      };
    },
  };
}
