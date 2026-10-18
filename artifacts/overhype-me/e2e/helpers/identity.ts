/**
 * @purpose E2E helper that stores a complete visitor identity (name and pronouns) in the browser before the page loads, for tests about something other than the identity sheet (#719), which otherwise opens on every ordinary page for a cold visitor.
 * @subsystem public-site
 */
import type { Page } from "@playwright/test";

export async function seedIdentity(page: Page, name = "Nick Baron", pronouns = "he/him"): Promise<void> {
  await page.addInitScript(([n, p]) => {
    localStorage.setItem("fact_db_name", n);
    localStorage.setItem("fact_db_pronouns", p);
    localStorage.setItem("fact_db_name_explicit", "1");
  }, [name, pronouns] as const);
}
