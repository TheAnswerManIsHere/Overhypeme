/**
 * @purpose Test fixture for the dev admin shortcut: seedBootstrapAdmin() makes the bootstrap admin row active and admin (inserting it when absent) and returns the function that puts it back; sessionIdFromResponse() reads the `sid` a response set, or undefined.
 * @subsystem accounts-auth
 */
import { randomUUID } from "node:crypto";
import type { Response } from "supertest";
import { eq } from "drizzle-orm";

import { db } from "@workspace/db";
import { usersTable } from "@workspace/db/schema";

export const BOOTSTRAP_ADMIN_EMAIL = "overhypeme+admin@gmail.com";

export async function seedBootstrapAdmin(): Promise<() => Promise<void>> {
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, BOOTSTRAP_ADMIN_EMAIL)).limit(1);
  if (existing) {
    const { isActive, isAdmin } = existing;
    await db.update(usersTable).set({ isActive: true, isAdmin: true }).where(eq(usersTable.id, existing.id));
    return async () => {
      await db.update(usersTable).set({ isActive, isAdmin }).where(eq(usersTable.id, existing.id));
    };
  }
  await db.insert(usersTable).values({ id: `t_devadmin_${randomUUID()}`, email: BOOTSTRAP_ADMIN_EMAIL, isActive: true, isAdmin: true });
  return async () => {
    await db.delete(usersTable).where(eq(usersTable.email, BOOTSTRAP_ADMIN_EMAIL));
  };
}

export function sessionIdFromResponse(res: Response): string | undefined {
  const cookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith("sid="));
  return cookie?.split(";")[0].slice("sid=".length);
}
