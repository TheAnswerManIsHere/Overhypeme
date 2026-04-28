import { db } from "@workspace/db";
import { usersTable, membershipHistoryTable } from "@workspace/db/schema";
import { eq, desc, sql, and, gte } from "drizzle-orm";

// Membership history events that indicate the user lost Legendary access
// involuntarily (refund or chargeback). These trigger an in-app notice so
// the user understands why their tier was reduced.
export const REVOCATION_EVENTS = ["refund", "dispute_opened", "dispute_lost"] as const;
export type RevocationEvent = typeof REVOCATION_EVENTS[number];

// How far back to look for a qualifying event. Events older than this are
// considered stale and the notice is no longer shown.
export const REVOCATION_NOTICE_WINDOW_DAYS = 90;

export class StripeStorage {
  async getUserById(id: string) {
    const [user] = await db.select().from(usersTable).where(and(eq(usersTable.id, id), eq(usersTable.isActive, true))).limit(1);
    return user ?? null;
  }

  async updateUserStripeCustomerId(userId: string, stripeCustomerId: string) {
    await db.update(usersTable).set({ stripeCustomerId }).where(eq(usersTable.id, userId));
  }

  async getSubscriptionForUser(userId: string) {
    const user = await this.getUserById(userId);
    if (!user?.stripeCustomerId) return null;

    const result = await db.execute(
      sql`SELECT s.* FROM stripe.subscriptions s
          JOIN stripe.customers c ON c.id = s.customer
          WHERE c.id = ${user.stripeCustomerId}
          AND s.status IN ('active','trialing','past_due')
          ORDER BY s.created DESC
          LIMIT 1`,
    );
    const row = (result.rows[0] as Record<string, unknown>) ?? null;
    if (!row) return null;

    // In newer Stripe API versions (basil+), current_period_end moved from the
    // Subscription object to the SubscriptionItem. The sync library column stays
    // null in that case, so fall back to items.data[0].current_period_end.
    if (!row.current_period_end) {
      const rawData = row._raw_data as Record<string, unknown> | null;
      const items = rawData?.items as { data?: Array<Record<string, unknown>> } | null;
      const firstItem = items?.data?.[0];
      if (firstItem?.current_period_end) {
        row.current_period_end = firstItem.current_period_end;
      }
    }

    return row;
  }

  async getActiveLegendarySubscribers(): Promise<Array<{ id: string; email: string; displayName: string | null; pronouns: string | null }>> {
    const rows = await db
      .select({ id: usersTable.id, email: usersTable.email, displayName: usersTable.displayName, pronouns: usersTable.pronouns })
      .from(usersTable)
      .where(and(
        eq(usersTable.membershipTier, "legendary"),
        eq(usersTable.isActive, true)
      ));
    return rows.filter(r => r.email !== null) as Array<{ id: string; email: string; displayName: string | null; pronouns: string | null }>;
  }


  async getMembershipTierForUser(userId: string): Promise<"unregistered" | "registered" | "legendary"> {
    const user = await this.getUserById(userId);
    return user?.membershipTier ?? "unregistered";
  }

  async getPaymentHistory(userId: string) {
    return db
      .select()
      .from(membershipHistoryTable)
      .where(eq(membershipHistoryTable.userId, userId))
      .orderBy(desc(membershipHistoryTable.createdAt))
      .limit(50);
  }

  /**
   * Returns a notice describing the most recent involuntary access revocation
   * (refund or dispute) for the given user, or null when no such notice should
   * be shown.
   *
   * The notice is only shown when:
   *   1. The user's current tier is 'registered' (i.e. they were downgraded).
   *   2. Their most recent membership_history event is one of REVOCATION_EVENTS
   *      (a later positive event such as `lifetime_purchase` or
   *      `subscription_started` supersedes the notice).
   *   3. That event is within REVOCATION_NOTICE_WINDOW_DAYS.
   *
   * The returned payload is intentionally minimal and contains no Stripe IDs,
   * amounts, or other sensitive billing data — only the event kind and the
   * day it occurred.
   */
  async getAccessRevocationNotice(userId: string): Promise<{ kind: RevocationEvent; occurredAt: string } | null> {
    const user = await this.getUserById(userId);
    if (!user || user.membershipTier !== "registered") return null;

    const cutoff = new Date(Date.now() - REVOCATION_NOTICE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [latest] = await db
      .select({ event: membershipHistoryTable.event, createdAt: membershipHistoryTable.createdAt })
      .from(membershipHistoryTable)
      .where(and(
        eq(membershipHistoryTable.userId, userId),
        gte(membershipHistoryTable.createdAt, cutoff),
      ))
      .orderBy(desc(membershipHistoryTable.createdAt))
      .limit(1);

    if (!latest) return null;
    if (!(REVOCATION_EVENTS as readonly string[]).includes(latest.event)) return null;

    return {
      kind: latest.event as RevocationEvent,
      occurredAt: latest.createdAt.toISOString(),
    };
  }

  async listProductsWithPrices(liveMode: boolean = false) {
    const result = await db.execute(
      sql`SELECT
            p.id as product_id,
            p.name as product_name,
            p.description as product_description,
            p.metadata as product_metadata,
            pr.id as price_id,
            pr.unit_amount,
            pr.currency,
            pr.recurring,
            pr.active as price_active
          FROM stripe.products p
          LEFT JOIN stripe.prices pr ON pr.product = p.id AND pr.active = true AND pr.livemode = ${liveMode}
          WHERE p.active = true AND p.livemode = ${liveMode}
          ORDER BY p.id, pr.unit_amount`,
    );

    const productsMap = new Map<string, {
      id: string; name: string; description: string | null;
      metadata: Record<string, string>; prices: Array<{
        id: string; unit_amount: number; currency: string;
        recurring: Record<string, string> | null;
      }>;
    }>();

    for (const row of result.rows as Array<Record<string, unknown>>) {
      const pid = row.product_id as string;
      if (!productsMap.has(pid)) {
        productsMap.set(pid, {
          id: pid,
          name: row.product_name as string,
          description: row.product_description as string | null,
          metadata: (row.product_metadata as Record<string, string>) ?? {},
          prices: [],
        });
      }
      if (row.price_id) {
        productsMap.get(pid)!.prices.push({
          id: row.price_id as string,
          unit_amount: row.unit_amount as number,
          currency: row.currency as string,
          recurring: row.recurring as Record<string, string> | null,
        });
      }
    }
    return Array.from(productsMap.values());
  }
}

export const stripeStorage = new StripeStorage();
