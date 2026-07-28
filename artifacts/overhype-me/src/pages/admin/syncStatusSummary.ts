/**
 * Pure derivation of the Stripe sync panel's aggregate summary line.
 *
 * Kept beside the page so the state table lives next to the UI without
 * cluttering the component, and so it can be unit tested without jsdom.
 *
 * Why this exists: the admin Billing page used to render its sync panel only
 * while a run was in flight (`syncing || syncFinalMessage || inProgress`).
 * After a page reload all three are false, so a *failed* sync's persisted
 * error was fetched from the API and then discarded unrendered — what stayed
 * on screen ("1 product found · Last synced: 10m ago") read exactly like
 * success. That is how a broken Stripe sync hid through four rounds of
 * investigation. The panel now renders whenever status has loaded, and this
 * module decides what the one-line summary above it says.
 *
 * Per docs/ai-context/async-ui-status.md, failed / partial / never-ran are
 * distinct states and must never collapse into one quiet line.
 */

export type SyncSummaryTone = "ok" | "error" | "running" | "never";

export interface SyncSummary {
  tone: SyncSummaryTone;
  /** Headline sentence. Never empty. */
  message: string;
  /**
   * Most recent per-resource `lastSyncedAt`, as an ISO string, or null when
   * nothing has ever synced. Callers render it with their own relative
   * formatter.
   *
   * Deliberately derived from per-resource stamps rather than the response's
   * `finishedAt`: that field comes from the server's in-process lock, so it is
   * null after a restart even when the catalog synced fine.
   */
  latestSyncedAt: string | null;
  /** Resources currently reporting `error`, in the order given. */
  erroredResources: string[];
}

interface ResourceLike {
  resource: string;
  status: "idle" | "running" | "complete" | "error";
  lastSyncedAt: string | null;
  errorMessage: string | null;
}

function latestStamp(resources: readonly ResourceLike[]): string | null {
  let best: number | null = null;
  for (const r of resources) {
    if (!r.lastSyncedAt) continue;
    const t = new Date(r.lastSyncedAt).getTime();
    if (Number.isNaN(t)) continue;
    if (best === null || t > best) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Derive the summary line from a loaded sync-status response.
 *
 * Precedence is deliberate: a run in flight outranks everything (the user is
 * watching it), then failures, then never-ran, then success. A failure is
 * reported even when other resources succeeded — that is the partial state,
 * and rounding it up to "synced" is the bug this whole module exists to stop.
 */
export function deriveSyncSummary(
  resources: readonly ResourceLike[],
  inProgress: boolean,
): SyncSummary {
  const errored = resources.filter(r => r.status === "error");
  const erroredResources = errored.map(r => r.resource);
  const latestSyncedAt = latestStamp(resources);

  if (inProgress || resources.some(r => r.status === "running")) {
    return { tone: "running", message: "Sync in progress…", latestSyncedAt, erroredResources };
  }

  if (errored.length > 0) {
    const first = errored[0];
    const detail = first.errorMessage ? `: ${first.errorMessage}` : "";
    const rest = errored.length - 1;
    const others = rest > 0 ? ` (and ${rest} other ${plural(rest, "resource", "resources")})` : "";
    return {
      tone: "error",
      message:
        `Last sync failed — ${first.resource}${others} did not complete${detail}. ` +
        `Catalog data may be stale.`,
      latestSyncedAt,
      erroredResources,
    };
  }

  // No errors and nothing running. If nothing has ever synced, say so
  // plainly — this is an actionable state, not a quiet one, and it is what a
  // fresh install reports (readSyncStatus defaults every absent row to
  // `idle`, so all-idle is exactly the never-ran case).
  if (latestSyncedAt === null) {
    return {
      tone: "never",
      message: "Never synced — run a full sync to populate the catalog.",
      latestSyncedAt: null,
      erroredResources,
    };
  }

  const completed = resources.filter(r => r.status === "complete").length;
  return {
    tone: "ok",
    message:
      completed === resources.length
        ? "Last sync completed successfully."
        : `Last sync completed — ${completed} of ${resources.length} ${plural(resources.length, "resource", "resources")} reported.`,
    latestSyncedAt,
    erroredResources,
  };
}
