/**
 * @purpose What the web app knows about read-only mode (launch Phase 16, increment 4): whether the site is paused for changes, learned from the public config read and from any request the server refused with READ_ONLY_MODE, so the site-wide notice shows and a refused action says why while the form keeps what the visitor typed.
 * @subsystem operations
 */

/** The code the server's read-only gate answers with (api-server `lib/readOnlyMode.ts`). */
export const READ_ONLY_CODE = "READ_ONLY_MODE";

/**
 * The maintenance sentence (David, Issue #1107): the site-wide banner, and the
 * explanation on every control grayed out while the site is paused (#1109).
 */
export const READ_ONLY_EXPLANATION =
  "Overhype.me is undergoing maintenance. Real men get pedicures. Keep browsing but the site is read-only until we're done waiting for our toes to dry.";

/** The warning admin screens show instead of the banner while paused (David, #1109 Q30/Q31). */
export const READ_ONLY_ADMIN_WARNING =
  "The site is paused for the public. Admin changes still save. If you're about to restore the database or run a repair, stop: changes made now can be lost or collide.";

/** The title of the toast shown when an action is refused (David, #1109 Q32). */
export const READ_ONLY_REFUSED_TITLE = "Overhype.me is undergoing maintenance";

/** The text under that title (David, #1109 Q32). */
export const READ_ONLY_REFUSED_MESSAGE =
  "Real men get pedicures. We can't process any data until we're done waiting for our toes to dry. Try again in a few minutes.";

/** Title and text as one message, for a form that shows an error without a title. */
export const READ_ONLY_REFUSED_FULL = `${READ_ONLY_REFUSED_TITLE}. ${READ_ONLY_REFUSED_MESSAGE}`;

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

/**
 * Whether a failed request was refused because the site is read-only: its own
 * response is a 503 carrying READ_ONLY_CODE. Accepts the API client's error
 * (status + parsed data) or a response's status and parsed body. A caller uses
 * it to skip its own generic failure toast, since the refusal already raised
 * one that says why and only one toast shows at a time (Issue #1107). Decided
 * from this request alone, never from whether the site is known to be paused:
 * a request can fail for another reason while it is.
 */
export function isReadOnlyRefusal(failure: unknown, body?: unknown): boolean {
  if (!failure || typeof failure !== "object") return false;
  const f = failure as { status?: unknown; data?: unknown };
  if (f.status !== 503) return false;
  const payload = body !== undefined ? body : f.data;
  return !!payload && typeof payload === "object" && (payload as { code?: unknown }).code === READ_ONLY_CODE;
}

/**
 * Before a full-page navigation that the server would refuse while paused
 * (linking a sign-in provider), asks the public config whether the site is
 * paused now. A navigation is not a fetch, so a refusal would land on the
 * server's raw error page instead of reaching the app (#1109 D8). When paused,
 * it raises the refusal (banner and popup) and answers false; when it cannot
 * tell, it answers true and the server stays the guarantee.
 */
export async function confirmNotReadOnly(): Promise<boolean> {
  if (on) {
    noteReadOnlyRefusal();
    return false;
  }
  try {
    const res = await fetch("/api/config", { credentials: "include" });
    const body = res.ok ? ((await res.json()) as { readOnlyMode?: unknown }) : null;
    if (body?.readOnlyMode === true) {
      noteReadOnlyRefusal();
      return false;
    }
  } catch {
    /* cannot tell: let the navigation go */
  }
  return true;
}

/** Test seam. */
export function __resetReadOnlyNoticeForTests(): void {
  on = false;
  listeners.clear();
  refusalListeners.clear();
}
