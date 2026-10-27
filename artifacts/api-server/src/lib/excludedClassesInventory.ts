/**
 * @purpose Read-only inventory of the four row classes that are never product data (sessions, non-terminal jobs, child-safety records, payment obligations), run before any destructive database replacement; reports counts and a verdict, writes nothing.
 * @subsystem data-lifecycle
 *
 * The four classes are the 2026-08-28 decision's (`docs/ai-context/decisions.md`,
 * "Pre-launch, the dev database is the source of truth"). Launch Phase 3's plan
 * (`docs/plans/PLAN_PHASE3_DATA_ENVIRONMENTS.md` §5) runs this before every
 * replacement — the dev rebuild, the production reset, any rehearsal copy — and
 * records the result on #770 before anything is destroyed.
 *
 * The verdict encodes two rules from that plan:
 *   - child-safety rows are carried forward, never discarded, so any present
 *     means a carry-forward artifact is required (it does not block by itself);
 *   - a live-mode payment inventory that is positive OR could not be completed
 *     blocks the replacement, because an empty local table proves nothing about
 *     what Stripe holds.
 */

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

/** Subscription statuses that still carry an obligation to the customer. */
export const OBLIGATING_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
] as const;

export interface LiveStripeSnapshot {
  /** The account the key resolved to, verified against the expected id. */
  accountId: string;
  /** Live-mode subscriptions in an obligating status, by status. */
  obligatingSubscriptions: Record<string, number>;
  /**
   * Succeeded live-mode payments whose charge is not fully refunded. A lifetime
   * purchase is one of these (its PaymentIntent id is the entitlement's
   * providerRef). Subscription renewals are counted too: the pinned API
   * version exposes no invoice on a PaymentIntent to tell them apart, and
   * over-counting only blocks, which the §5 reconciliation resolves.
   */
  unrefundedPayments: number;
  /** Succeeded payments excluded because their charge was fully refunded. */
  fullyRefundedPayments: number;
}

/**
 * Reads live-mode Stripe. Injected so the inventory never constructs a client
 * itself and tests can stand one in; `null` means no live key is configured.
 */
export type LiveStripeReader = () => Promise<LiveStripeSnapshot>;

/** The slice of a Stripe client the reader uses. */
export interface LiveStripeClient {
  accounts: { retrieve(): Promise<{ id: string }> };
  subscriptions: { list(params: { status: "all"; limit: number }): AsyncIterable<{ status: string }> };
  paymentIntents: {
    list(params: { limit: number; expand: string[] }): AsyncIterable<{
      status: string;
      latest_charge?: string | { refunded?: boolean } | null;
    }>;
  };
}

/**
 * The live-mode reader. Before it enumerates anything it reads the account
 * behind the key (`GET /v1/account`, no argument, so it resolves only to the
 * key's own account) and compares it with the expected id, as the account
 * guard does: a missing id or a mismatch throws, and the inventory reports the
 * payment class incomplete, which blocks. A failure on any page of either list
 * throws the same way.
 */
export function createLiveStripeReader(
  client: LiveStripeClient,
  expectedAccountId: string | undefined,
  expectedAccountVar: string,
): LiveStripeReader {
  return async () => {
    if (!expectedAccountId) throw new Error(`${expectedAccountVar} is not set`);
    const account = await client.accounts.retrieve();
    if (account.id !== expectedAccountId) {
      throw new Error(`the live key belongs to ${account.id}, not ${expectedAccountVar} (${expectedAccountId})`);
    }

    const obligating = new Set<string>(OBLIGATING_SUBSCRIPTION_STATUSES);
    const obligatingSubscriptions: Record<string, number> = {};
    for await (const sub of client.subscriptions.list({ status: "all", limit: 100 })) {
      if (obligating.has(sub.status)) obligatingSubscriptions[sub.status] = (obligatingSubscriptions[sub.status] ?? 0) + 1;
    }

    let unrefundedPayments = 0;
    let fullyRefundedPayments = 0;
    for await (const pi of client.paymentIntents.list({ limit: 100, expand: ["data.latest_charge"] })) {
      if (pi.status !== "succeeded") continue;
      // Only a full refund is evidence that nothing is owed; a partial refund,
      // or a charge that did not expand, still counts.
      const charge = pi.latest_charge;
      if (charge && typeof charge === "object" && charge.refunded === true) fullyRefundedPayments += 1;
      else unrefundedPayments += 1;
    }

    return { accountId: account.id, obligatingSubscriptions, unrefundedPayments, fullyRefundedPayments };
  };
}

export interface ExcludedClassesInventory {
  takenAt: string;
  database: string;
  sessions: { total: number; unexpired: number; unexpiredWithUser: number; unexpiredAdmin: number };
  /**
   * The rest of class 1's "environment-bound auth state": tokens and pending
   * OAuth handshakes that are still usable, which a copied database would
   * honour exactly as it honours a copied session.
   */
  authState: { unusedPasswordResetTokens: number; unusedEmailVerificationTokens: number; pendingOauthStates: number };
  nonTerminalJobs: { total: number; byQueueAndStatus: Record<string, number> };
  childSafety: {
    ncmecReports: number;
    ncmecReportsByStatus: Record<string, number>;
    quarantinedMemes: number;
    auditLogRows: number;
  };
  payments: {
    localEntitlementsWithProviderRef: number;
    localByTypeAndStatus: Record<string, number>;
    liveStripe:
      | ({ checked: true } & LiveStripeSnapshot)
      | { checked: false; reason: string };
  };
  verdict: {
    /** Sessions must be purged and jobs disposed of before the replacement serves. */
    cleanupRequired: boolean;
    /** Child-safety rows exist and must go into a verified carry-forward artifact. */
    carryForwardRequired: boolean;
    /** True when the payment inventory is positive or incomplete. */
    blocksReplacement: boolean;
    reasons: string[];
  };
}

type Row = Record<string, unknown>;
type Executor = Pick<typeof db, "execute">;

function queries(exec: Executor) {
  async function rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    const result = await exec.execute(query);
    return result.rows as Row[];
  }
  return {
    rows,
    async tableExists(name: string): Promise<boolean> {
      const [row] = await rows(sql`SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS present`);
      return row?.present === true;
    },
    async countOf(query: ReturnType<typeof sql>): Promise<number> {
      const [row] = await rows(query);
      return Number(row?.n ?? 0);
    },
  };
}

function tally(list: Row[], keyOf: (r: Row) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of list) out[keyOf(r)] = Number(r.n);
  return out;
}

export async function inventoryExcludedClasses(
  readLiveStripe: LiveStripeReader | null,
  now: Date = new Date(),
): Promise<ExcludedClassesInventory> {
  // One READ ONLY transaction: the database itself refuses any write from
  // here, and every count reads the same snapshot.
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    return inventoryWithin(queries(tx), readLiveStripe, now);
  });
}

async function inventoryWithin(
  { rows, tableExists, countOf }: ReturnType<typeof queries>,
  readLiveStripe: LiveStripeReader | null,
  now: Date,
): Promise<ExcludedClassesInventory> {
  const [dbRow] = await rows(sql`SELECT current_database() AS name`);
  const nowIso = now.toISOString();

  const sessions = {
    total: await countOf(sql`SELECT count(*) AS n FROM sessions`),
    unexpired: await countOf(sql`SELECT count(*) AS n FROM sessions WHERE expire > ${nowIso}::timestamp`),
    unexpiredWithUser: await countOf(
      sql`SELECT count(*) AS n FROM sessions WHERE expire > ${nowIso}::timestamp AND user_id IS NOT NULL`,
    ),
    unexpiredAdmin: await countOf(sql`
      SELECT count(*) AS n FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.expire > ${nowIso}::timestamp AND u.is_admin = true`),
  };

  const authState = {
    unusedPasswordResetTokens: await countOf(sql`
      SELECT count(*) AS n FROM password_reset_tokens WHERE used_at IS NULL AND expires_at > ${nowIso}::timestamptz`),
    unusedEmailVerificationTokens: await countOf(sql`
      SELECT count(*) AS n FROM email_verification_tokens WHERE used_at IS NULL AND expires_at > ${nowIso}::timestamptz`),
    pendingOauthStates: await countOf(
      sql`SELECT count(*) AS n FROM oauth_pending_states WHERE expires_at > ${nowIso}::timestamptz`,
    ),
  };
  const liveAuthState =
    authState.unusedPasswordResetTokens + authState.unusedEmailVerificationTokens + authState.pendingOauthStates;

  const jobRows = await rows(sql`
    SELECT queue, status, count(*) AS n FROM async_jobs
    WHERE status IN ('pending', 'processing') GROUP BY queue, status ORDER BY queue, status`);
  const nonTerminalJobs = {
    total: jobRows.reduce((s, r) => s + Number(r.n), 0),
    byQueueAndStatus: tally(jobRows, (r) => `${r.queue}/${r.status}`),
  };

  const reportStatusRows = await rows(sql`
    SELECT coalesce(submission_status, '(null)') AS status, count(*) AS n
    FROM ncmec_reports GROUP BY 1 ORDER BY 1`);
  const childSafety = {
    ncmecReports: reportStatusRows.reduce((s, r) => s + Number(r.n), 0),
    ncmecReportsByStatus: tally(reportStatusRows, (r) => String(r.status)),
    quarantinedMemes: await countOf(sql`SELECT count(*) AS n FROM quarantined_memes`),
    // The audit ledger only exists from migration 0097 on; an older database
    // simply has none to carry.
    auditLogRows: (await tableExists("ncmec_safety_audit_log"))
      ? await countOf(sql`SELECT count(*) AS n FROM ncmec_safety_audit_log`)
      : 0,
  };

  const entitlementRows = await rows(sql`
    SELECT source_type, lifecycle_status, count(*) AS n FROM membership_entitlements
    GROUP BY 1, 2 ORDER BY 1, 2`);
  const localEntitlementsWithProviderRef = await countOf(
    sql`SELECT count(*) AS n FROM membership_entitlements WHERE provider_ref IS NOT NULL`,
  );

  let liveStripe: ExcludedClassesInventory["payments"]["liveStripe"];
  if (!readLiveStripe) {
    liveStripe = { checked: false, reason: "no live-mode Stripe key in this environment" };
  } else {
    try {
      const snap = await readLiveStripe();
      liveStripe = { checked: true, ...snap };
    } catch (err) {
      liveStripe = { checked: false, reason: `live-mode read failed: ${(err as Error).message}` };
    }
  }

  const reasons: string[] = [];
  const cleanupRequired = sessions.unexpired > 0 || liveAuthState > 0 || nonTerminalJobs.total > 0;
  if (sessions.unexpired > 0) reasons.push(`${sessions.unexpired} unexpired session(s) to purge before serving`);
  if (liveAuthState > 0) reasons.push(`${liveAuthState} usable auth token(s) or OAuth state(s) to purge before serving`);
  if (nonTerminalJobs.total > 0) reasons.push(`${nonTerminalJobs.total} non-terminal job(s) to dispose of before workers start`);

  const carryForwardRequired =
    childSafety.ncmecReports + childSafety.quarantinedMemes + childSafety.auditLogRows > 0;
  if (carryForwardRequired) reasons.push("child-safety records present: a verified carry-forward artifact is required");

  const liveSubscriptions = liveStripe.checked
    ? Object.values(liveStripe.obligatingSubscriptions).reduce((s, n) => s + n, 0)
    : 0;
  const livePayments = liveStripe.checked ? liveStripe.unrefundedPayments : 0;
  const blocksReplacement = !liveStripe.checked || liveSubscriptions > 0 || livePayments > 0;
  if (!liveStripe.checked) reasons.push(`BLOCKS: live-mode Stripe inventory incomplete (${liveStripe.reason})`);
  if (liveSubscriptions > 0) reasons.push(`BLOCKS: ${liveSubscriptions} live-mode subscription(s) still obligating`);
  if (livePayments > 0) {
    reasons.push(
      `BLOCKS: ${livePayments} succeeded live-mode payment(s) not fully refunded ` +
        "(a lifetime purchase is one of these; each needs a preservation or reconciliation path)",
    );
  }

  return {
    takenAt: nowIso,
    database: String(dbRow?.name ?? ""),
    sessions,
    authState,
    nonTerminalJobs,
    childSafety,
    payments: {
      localEntitlementsWithProviderRef,
      localByTypeAndStatus: tally(entitlementRows, (r) => `${r.source_type}/${r.lifecycle_status}`),
      liveStripe,
    },
    verdict: { cleanupRequired, carryForwardRequired, blocksReplacement, reasons },
  };
}
