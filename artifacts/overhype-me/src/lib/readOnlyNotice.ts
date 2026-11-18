/**
 * @purpose What the web app knows about read-only mode (launch Phase 16, increment 4): whether the site is paused for changes, learned from the public config read and from any request the server refused with READ_ONLY_MODE, so the site-wide notice shows and a refused action says why while the form keeps what the visitor typed.
 * @subsystem operations
 */

/** The code the server's read-only gate answers with (api-server `lib/readOnlyMode.ts`). */
export const READ_ONLY_CODE = "READ_ONLY_MODE";

/** The short message shown when an action is refused. */
export const READ_ONLY_REFUSED_MESSAGE = "Changes are paused for a little while. Nothing you typed is lost; please try again shortly.";

type Listener = (on: boolean) => void;

let on = false;
const listeners = new Set<Listener>();
const refusalListeners = new Set<() => void>();

export function isReadOnlyNow(): boolean {
  return on;
}

export function setReadOnlyNow(next: boolean): void {
  if (next === on) return;
  on = next;
  for (const l of listeners) l(on);
}

export function onReadOnlyChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function onReadOnlyRefusal(l: () => void): () => void {
  refusalListeners.add(l);
  return () => refusalListeners.delete(l);
}

/** A request was refused because the site is paused. */
export function noteReadOnlyRefusal(): void {
  setReadOnlyNow(true);
  for (const l of refusalListeners) l();
}

/**
 * Reads an API response for the read-only refusal without consuming it: the
 * caller's own handling (an error message, a form that keeps its input) still
 * reads the original.
 */
export async function inspectForReadOnly(response: Response): Promise<void> {
  if (response.status !== 503) return;
  try {
    const body = (await response.clone().json()) as { code?: unknown };
    if (body?.code === READ_ONLY_CODE) noteReadOnlyRefusal();
  } catch {
    /* not JSON: not ours */
  }
}

/** Test seam. */
export function __resetReadOnlyNoticeForTests(): void {
  on = false;
  listeners.clear();
  refusalListeners.clear();
}
