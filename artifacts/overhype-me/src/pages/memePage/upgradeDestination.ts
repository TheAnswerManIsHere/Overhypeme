import type { Tier } from "@/components/meme-builder/types";

/**
 * Where a locked builder's upgrade button goes. A registration lock (a
 * signed-out visitor on the photo step, since the stock source went with
 * Pexels) is a sign-up, so it goes to the login page and back, as the wizard's
 * sign-up panel does; only a Legendary lock goes to the plans.
 */
export function upgradeDestination(targetTier: Tier, here: string): { href: string; fullPage: boolean } {
  if (targetTier === "registered") {
    return { href: `/login?from=${encodeURIComponent(here)}`, fullPage: true };
  }
  return { href: "/pricing", fullPage: false };
}
