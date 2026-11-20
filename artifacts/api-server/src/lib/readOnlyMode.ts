/**
 * @purpose Read-only mode's switch (launch Phase 16, increment 4, plan design D): one `admin_config` value, read through its own small cache rather than the general config getters, so that a confirmed pause stays in force when a refresh fails, no trustworthy value at all refuses the affected writes, and an older read never overwrites a newer saved value.
 * @subsystem operations
 */
import { eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { adminConfigTable } from "@workspace/db/schema";
import { logger } from "./logger";
import { WORKER_INSTANCE_ID } from "./workerHeartbeats";

export const READ_ONLY_CONFIG_KEY = "read_only_mode";

/** How long a confirmed value is trusted before this server reads it again (the page's "about a minute"). */
export const READ_ONLY_REFRESH_MS = 30_000;

/** The code every refusal carries; the web app recognises it. */
export const READ_ONLY_CODE = "READ_ONLY_MODE";
/** David's wording (#1109 Q32): the title and text the web app's refusal popup shows, as one message for forms that show the server's error. */
export const READ_ONLY_MESSAGE =
  "Overhype.me is undergoing maintenance. Real men get pedicures. We can't process any data until we're done waiting for our toes to dry. Try again in a few minutes.";

/** A value this server has confirmed by reading or writing it. */
type Confirmed = { on: boolean; updatedAt: number; confirmedAt: number };

let confirmed: Confirmed | null = null;
let lastFailureAt: number | null = null;
let inFlight: Promise<void> | null = null;

/** Keeps `next` only when it is at least as new as what is held: an older read never undoes a newer save. */
function accept(next: Confirmed): void {
  if (confirmed && next.updatedAt < confirmed.updatedAt) {
    // Still confirmed now: the held value is newer, and this read proves the store answers.
    confirmed = { ...confirmed, confirmedAt: Math.max(confirmed.confirmedAt, next.confirmedAt) };
    return;
  }
  confirmed = next;
}

/** Reads the switch from the store; a missing row is a confirmed "off". */
async function readFromStore(): Promise<Confirmed> {
  const startedAt = Date.now();
  const rows = await db
    .select({ value: adminConfigTable.value, updatedAt: adminConfigTable.updatedAt })
    .from(adminConfigTable)
    .where(eq(adminConfigTable.key, READ_ONLY_CONFIG_KEY))
    .limit(1);
  const row = rows[0];
  return {
    on: row?.value === "on",
    updatedAt: row ? row.updatedAt.getTime() : 0,
    confirmedAt: startedAt,
  };
}

let reader: () => Promise<Confirmed> = readFromStore;

/** One refresh at a time; a failure keeps whatever was confirmed. */
export function refreshReadOnly(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = reader()
    .then((next) => {
      accept(next);
      lastFailureAt = null;
    })
    .catch((err: unknown) => {
      lastFailureAt = Date.now();
      logger.warn({ err }, "[readOnlyMode] the switch could not be read; keeping the last confirmed value");
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Whether the affected writes are refused right now. Refreshes when the
 * confirmed value is older than the interval. A confirmed value is kept when
 * the refresh fails; with nothing confirmed at all, the answer is "refuse".
 */
export async function isReadOnly(): Promise<boolean> {
  if (!confirmed || Date.now() - confirmed.confirmedAt >= READ_ONLY_REFRESH_MS) await refreshReadOnly();
  return confirmed ? confirmed.on : true;
}

/** Saves the switch, and this server enforces the saved value at once. */
export async function setReadOnly(on: boolean, adminId: string | null): Promise<void> {
  const value = on ? "on" : "off";
  const [row] = await db
    .insert(adminConfigTable)
    .values({
      key: READ_ONLY_CONFIG_KEY,
      value,
      dataType: "boolean",
      label: "Read-only mode",
      description: "While on, visitors and members cannot change anything; browsing, personalising, admins, background jobs and payment webhooks continue. An incident lever, set on the Operations page.",
      isPublic: false,
      updatedById: adminId,
    })
    .onConflictDoUpdate({
      target: adminConfigTable.key,
      // The store's clock, never this server's: saves from different servers order correctly.
      set: { value, updatedAt: sql`now()`, updatedById: adminId },
    })
    .returning({ updatedAt: adminConfigTable.updatedAt });
  const now = Date.now();
  accept({ on, updatedAt: row!.updatedAt.getTime(), confirmedAt: now });
  lastFailureAt = null;
}

export type ReadOnlyEnforcement = {
  /** The server that answered: each server holds its own copy of the switch. */
  instanceId: string;
  /** What this server refuses right now. */
  enforcing: "on" | "off";
  /** ok: confirmed within the interval; stale: the last refresh failed, the last confirmed value holds; unavailable: never confirmed, so writes are refused. */
  status: "ok" | "stale" | "unavailable";
  confirmedAt: string | null;
  savedAt: string | null;
  refreshSeconds: number;
};

/** This server's view, for the Operations page. Refreshes first when due. */
export async function readOnlyEnforcement(): Promise<ReadOnlyEnforcement> {
  const on = await isReadOnly();
  const stale = confirmed !== null && (lastFailureAt !== null || Date.now() - confirmed.confirmedAt >= READ_ONLY_REFRESH_MS);
  return {
    instanceId: WORKER_INSTANCE_ID,
    enforcing: on ? "on" : "off",
    status: confirmed === null ? "unavailable" : stale ? "stale" : "ok",
    confirmedAt: confirmed ? new Date(confirmed.confirmedAt).toISOString() : null,
    savedAt: confirmed && confirmed.updatedAt > 0 ? new Date(confirmed.updatedAt).toISOString() : null,
    refreshSeconds: READ_ONLY_REFRESH_MS / 1000,
  };
}

/** Test seam: forget what this process has confirmed. */
export function __resetReadOnlyForTests(state?: Confirmed | null): void {
  confirmed = state ?? null;
  lastFailureAt = null;
  inFlight = null;
}

/** Test seam: replace the store read (null restores it). */
export function __setReadOnlyReaderForTests(fn: (() => Promise<Confirmed>) | null): void {
  reader = fn ?? readFromStore;
}

/** Test seam: apply a read result as if it arrived from the store. */
export function __acceptForTests(next: Confirmed): void {
  accept(next);
}
