/**
 * Read-only mode (launch Phase 16, increment 4; plan PLAN_PHASE16_ANALYTICS_OPERATIONS.md,
 * Acceptance, Read-only mode): the scripted pass, in a browser, on the dev stack.
 *
 * An admin turns the switch on from the Operations page. Then: a signed-out
 * visitor browses and sees the site-wide notice; a signed-in member browses,
 * saves a name and pronouns (Q11), and a write of theirs is refused with the
 * read-only code and the short message; the admin turns it off from the same
 * page, and the member's next write is no longer refused. The full route
 * table, the webhook and the switch's failure cases are proven against the
 * real app in the API suite (phase16.readOnlyMode.test.ts).
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { FREE_ACCOUNT, TEST_ACCOUNT_PASSWORD, signInThroughForm } from "./helpers/testAccounts";

async function adminPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const login = await context.request.post("/api/auth/dev-admin-login");
  expect(login.ok(), `dev-admin-login answered ${login.status()}`).toBe(true);
  const page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  await page.goto("/admin/operations");
  await expect(page.getByTestId("read-only-panel")).toBeVisible();
  return { context, page };
}

async function setSwitch(page: Page, on: boolean): Promise<void> {
  const state = page.getByTestId("read-only-state");
  const wanted = on ? /^On:/ : /^Off:/;
  if (!wanted.test((await state.textContent()) ?? "")) await page.getByTestId("read-only-toggle").click();
  await expect(state).toHaveText(wanted);
}

/** A write sent the way the app sends one: through the page's own fetch, so the interceptor sees the answer. */
async function appWrite(page: Page, method: string, path: string, body: unknown): Promise<{ status: number; code?: string }> {
  return page.evaluate(async ({ method, path, body }) => {
    const res = await fetch(path, { method, credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let code: string | undefined;
    try { code = ((await res.json()) as { code?: string }).code; } catch { /* no body */ }
    return { status: res.status, code };
  }, { method, path, body });
}

test("read-only mode: on from Operations, browsing and a name save carry on, a write is refused with the notice, off again", async ({ browser }) => {
  test.setTimeout(120_000);
  const admin = await adminPage(browser);
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  try {
    await signInThroughForm(member, FREE_ACCOUNT.email, TEST_ACCOUNT_PASSWORD);

    await setSwitch(admin.page, true);
    await expect(admin.page.getByTestId("read-only-panel")).toContainText("picks up a change within about");

    // A signed-out visitor: browsing works and the notice is shown.
    const visitorContext = await browser.newContext();
    const visitor = await visitorContext.newPage();
    await visitor.goto("/top-facts");
    await expect(visitor.getByTestId("read-only-notice")).toBeVisible();
    await expect(visitor.getByRole("heading").first()).toBeVisible();
    await visitorContext.close();

    // A signed-in member: browsing works, the notice is shown, a name and pronouns save (Q11).
    await member.goto("/top-facts");
    await expect(member.getByTestId("read-only-notice")).toBeVisible();
    const nameSave = await appWrite(member, "PATCH", "/api/users/me", { displayName: "Readonly Tester", pronouns: "they/them" });
    expect(nameSave.status, "a name and pronouns save while read-only").toBe(200);
    const otherField = await appWrite(member, "PATCH", "/api/users/me", { firstName: "Readonly" });
    expect(otherField.code, "any other profile field is refused").toBe("READ_ONLY_MODE");

    // A write the member makes on purpose is refused, and the app says why.
    const refused = await appWrite(member, "POST", "/api/memes", {});
    expect(refused).toEqual({ status: 503, code: "READ_ONLY_MODE" });
    // The toast's visible text, not the copy its screen-reader announcer holds for a moment
    // (two matches would fail strict mode depending on timing; PR #1071's CI).
    await expect(member.getByLabel("Notifications (F8)").getByText("Changes are paused for a little while. Nothing you typed is lost")).toBeVisible();

    // An admin action still works while it is on: the test alert.
    const adminAction = await admin.page.evaluate(async () => (await fetch("/api/admin/operations/test-alert", { method: "POST", credentials: "include" })).status);
    expect(adminAction).toBe(200);

    // Off again: the member's write reaches its handler, and the notice goes on the next read.
    await setSwitch(admin.page, false);
    const after = await appWrite(member, "POST", "/api/memes", {});
    expect(after.code).not.toBe("READ_ONLY_MODE");
    await member.reload();
    await expect(member.getByTestId("read-only-notice")).toHaveCount(0);
  } finally {
    // Never leave the shared dev stack paused, whatever failed.
    await admin.page.request.put("/api/admin/operations/read-only", {
      data: { on: false },
      headers: { "X-CSRF-Token": (await admin.context.cookies()).find((c) => c.name === "csrf_token")?.value ?? "" },
    }).catch(() => undefined);
    await memberContext.close();
    await admin.context.close();
  }
});
