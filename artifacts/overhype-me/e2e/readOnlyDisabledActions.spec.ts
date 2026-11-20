/**
 * Read-only mode grays out what would save (#1109; plan PLAN_READ_ONLY_DISABLED_ACTIONS.md,
 * Testing Plan): with the switch on, in a real browser on the dev stack —
 *
 * - a fact page's write controls (rating, Make a meme, posting a comment) are
 *   grayed out and explain themselves on hover, while reading comments,
 *   sharing and copying stay usable;
 * - on a touch screen a tap shows the explanation and does nothing else;
 * - the meme builder opened by its own URL grays out its save;
 * - the Library's Submit a fact, sign-up's Create account, and Profile's
 *   fields other than name and pronouns are grayed out; signing in is not;
 * - a page that has not yet learned of the pause posts a real comment, is
 *   refused, says so in David's words (Q32), keeps the text, and grays out;
 * - Profile with an edit made before the pause saves the name and keeps the
 *   other edit unsaved; once the pause ends, it saves;
 * - admin screens show the admin warning (Q31);
 * - turning the switch off gives the controls back without a reload.
 *
 * Facts and memes are answered by the typed stubs (the dev stack has none);
 * every write goes to the real server, whose read-only gate refuses it.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { factDetail, stubPublicFacts } from "./helpers/apiStubs";
import { seedIdentity } from "./helpers/identity";
import { FREE_ACCOUNT, TEST_ACCOUNT_PASSWORD, signInThroughForm } from "./helpers/testAccounts";

const EXPLANATION =
  "Overhype.me is undergoing maintenance. Real men get pedicures. Keep browsing but the site is read-only until we're done waiting for our toes to dry.";
const ADMIN_WARNING =
  "The site is paused for the public. Admin changes still save. If you're about to restore the database or run a repair, stop: changes made now can be lost or collide.";
const REFUSED_TITLE = "Overhype.me is undergoing maintenance";

const FACT = factDetail({ id: 731, text: "{NAME} gets pedicures from a tidal wave." });

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

/** Never leave the shared dev stack paused, whatever failed; uses the admin's request context, not a page. */
async function switchOff(admin: { context: BrowserContext }): Promise<void> {
  const csrf = (await admin.context.cookies().catch(() => [])).find((c) => c.name === "csrf_token")?.value ?? "";
  await admin.context.request.put("/api/admin/operations/read-only", { data: { on: false }, headers: { "X-CSRF-Token": csrf } }).catch(() => undefined);
}

/** The grayed-out wrapper around a control, found by the control's text. */
const paused = (page: Page, text: string | RegExp) => page.getByTestId("read-only-paused").filter({ hasText: text });

/** Answer the fact endpoints from stubs, but let a comment POST reach the real server. */
async function stubFactPage(page: Page): Promise<void> {
  await stubPublicFacts(page, { facts: [FACT] });
  await page.route(/\/api\/facts\/\d+\/comments/, (route) =>
    route.request().method() === "POST" ? route.continue() : route.fallback(),
  );
}

test("read-only mode grays out every action that saves, explains why, and gives them back", async ({ browser }) => {
  test.setTimeout(180_000);
  const admin = await adminPage(browser);
  await setSwitch(admin.page, false);
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  try {
    await signInThroughForm(member, FREE_ACCOUNT.email, TEST_ACCOUNT_PASSWORD);
    await stubFactPage(member);

    // A page loaded before the pause: everything is live.
    await member.goto(`/facts/${FACT.id}`);
    await expect(member.getByText("POST COMMENT")).toBeVisible();
    await expect(member.getByTestId("read-only-paused")).toHaveCount(0);

    // Profile: an edit to a non-name field made before the pause (D5).
    const profile = await memberContext.newPage();
    await profile.goto("/profile");
    await profile.getByRole("button", { name: /edit profile/i }).first().click();
    const firstName = profile.getByPlaceholder("Legal first name");
    await firstName.fill("Pedicured");

    await setSwitch(admin.page, true);

    // Admin screens carry the admin warning (Q31).
    await admin.page.reload();
    await expect(admin.page.getByTestId("read-only-notice")).toHaveText(ADMIN_WARNING);

    // The stale fact page: a real comment is refused, says why in David's words, keeps the text, then grays out.
    const box = member.getByPlaceholder("Smack some knowledge on us...");
    await box.fill("Toes of steel.");
    await member.getByText("POST COMMENT").click();
    await expect(member.getByLabel("Notifications (F8)").getByText(REFUSED_TITLE)).toBeVisible();
    await expect(box).toHaveValue("Toes of steel.");
    await expect(member.getByTestId("read-only-notice")).toHaveText(EXPLANATION);
    await expect(paused(member, "POST COMMENT")).toBeVisible();

    // Fresh load while paused: write controls grayed, with the explanation on hover; nothing navigates.
    await member.goto(`/facts/${FACT.id}`);
    for (const control of ["MAKE A MEME OF THIS", "POST COMMENT"]) await expect(paused(member, control).first()).toBeVisible();
    await expect(paused(member, String(FACT.upvotes ?? 0)).first()).toBeVisible(); // the vote pill
    await paused(member, "MAKE A MEME OF THIS").first().hover();
    await expect(member.getByTestId("read-only-explanation")).toHaveText(EXPLANATION);
    // A person can still tap it; the test forces the click Playwright would refuse on a disabled control.
    await paused(member, "MAKE A MEME OF THIS").first().click({ force: true });
    await expect(member).toHaveURL(new RegExp(`/facts/${FACT.id}$`));
    // What stays usable: the share sheet opens.
    await member.getByTitle("Share").first().click();
    await expect(member.getByRole("dialog")).toBeVisible();
    await member.keyboard.press("Escape");

    // The meme builder opened by its own URL: its save is grayed out (D4).
    await member.goto(`/facts/${FACT.id}/meme`);
    await expect(paused(member, "Make my meme")).toBeVisible();

    // The Library's Submit a fact.
    await member.goto("/library");
    await expect(paused(member, "SUBMIT A FACT")).toBeVisible();

    // Profile (the page opened before the pause): only name and pronouns can change.
    await profile.reload(); // learns of the pause from config
    await profile.getByRole("button", { name: /edit profile/i }).first().click();
    await expect(paused(profile, "").filter({ has: profile.getByPlaceholder("Legal first name") })).toBeVisible();
    await expect(profile.getByPlaceholder("How you want to appear on the site")).toBeEditable();
  } finally {
    await switchOff(admin);
    await memberContext.close();
    await admin.context.close();
  }
});

test("read-only mode: a held-back profile edit saves once the pause ends (D5)", async ({ browser }) => {
  test.setTimeout(120_000);
  const admin = await adminPage(browser);
  await setSwitch(admin.page, false);
  const memberContext = await browser.newContext();
  const page = await memberContext.newPage();
  try {
    await signInThroughForm(page, FREE_ACCOUNT.email, TEST_ACCOUNT_PASSWORD);
    await page.goto("/profile");
    await page.getByRole("button", { name: /edit profile/i }).first().click();
    const firstName = page.getByPlaceholder("Legal first name");
    const displayName = page.getByPlaceholder("How you want to appear on the site");
    const originalFirst = await firstName.inputValue();
    const newFirst = originalFirst === "Pedicured" ? "Unpainted" : "Pedicured";
    const newDisplay = `Toes ${Date.now() % 100000}`;
    await firstName.fill(newFirst);
    await displayName.fill(newDisplay);

    await setSwitch(admin.page, true);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); // the page re-reads the switch
    await expect(page.getByTestId("read-only-notice")).toBeVisible();

    await page.getByText("Save Changes").click();
    await expect(page.getByTestId("profile-partial-save")).toContainText("Your name and pronouns are saved.");
    await expect(firstName).toHaveValue(newFirst); // kept, not saved
    const during = await (await page.request.get("/api/users/me")).json();
    expect(during.displayName).toBe(newDisplay);
    expect(during.firstName).not.toBe(newFirst);

    await setSwitch(admin.page, false);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByTestId("read-only-notice")).toHaveCount(0); // controls come back without a reload
    await page.getByText("Save Changes").click();
    await expect.poll(async () => (await (await page.request.get("/api/users/me")).json()).firstName).toBe(newFirst);
  } finally {
    await switchOff(admin);
    await memberContext.close();
    await admin.context.close();
  }
});

test("read-only mode on a touch screen: a tap explains and does nothing else; sign-up is grayed, sign-in is not", async ({ browser }) => {
  test.setTimeout(120_000);
  const admin = await adminPage(browser);
  await setSwitch(admin.page, false);
  const phone = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });
  const page = await phone.newPage();
  try {
    await setSwitch(admin.page, true);
    await seedIdentity(page, "Nick Baron");
    await stubFactPage(page);
    await page.goto(`/facts/${FACT.id}`);
    const make = paused(page, "MAKE A MEME OF THIS").first();
    await make.tap({ force: true });
    await expect(page.getByTestId("read-only-explanation")).toHaveText(EXPLANATION);
    await expect(page).toHaveURL(new RegExp(`/facts/${FACT.id}$`));

    await page.goto("/login");
    await expect(page.getByRole("button", { name: /sign in/i }).and(page.locator('[type="submit"]'))).toBeEnabled();
    await page.getByRole("button", { name: /^sign up$/i }).tap();
    await expect(paused(page, /create account/i)).toBeVisible();
  } finally {
    await switchOff(admin);
    await phone.close();
    await admin.context.close();
  }
});
