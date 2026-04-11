import { db } from "@workspace/db";
import { usersTable, membershipHistoryTable } from "@workspace/db/schema";
import { eq, desc, sql, and } from "drizzle-orm";

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
    return (result.rows[0] as Record<string, unknown>) ?? null;
  }

  async getActivePremiumUsers(): Promise<Array<{ id: string; email: string; displayName: string | null; pronouns: string | null }>> {
    const rows = await db
      .select({ id: usersTable.id, email: usersTable.email, displayName: usersTable.displayName, pronouns: usersTable.pronouns })
      .from(usersTable)
      .where(and(
        eq(usersTable.membershipTier, "legendary"),
        eq(usersTable.isActive, true)
      ));
    return rows.filter(r => r.email !== null) as Array<{ id: string; email: string; displayName: string | null; pronouns: string | null }>;
  }

  async getActiveLegendaryUsers(): Promise<Array<{ id: string; email: string; displayName: string | null }>> {
    const rows = await db
      .select({ id: usersTable.id, email: usersTable.email, displayName: usersTable.displayName })
      .from(usersTable)
      .where(and(eq(usersTable.membershipTier, "legendary"), eq(usersTable.isActive, true)));
    return rows.filter(r => r.email !== null) as Array<{ id: string; email: string; displayName: string | null }>;
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

  async listProductsWithPrices() {
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
          LEFT JOIN stripe.prices pr ON pr.product = p.id AND pr.active = true
          WHERE p.active = true
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
