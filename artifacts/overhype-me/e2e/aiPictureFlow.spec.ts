/**
 * Phase 7 amendment (plan docs/plans/PLAN_PHASE7_AI_PICTURE_FLOW.md): making
 * an AI picture is its own flow, reached from the meme builder's button.
 * The journey: builder → picture page → builder. Back leaves the half-made
 * meme exactly as it was; a pet picture made in another shape arrives in the
 * builder in that shape with the pet's name on the caption.
 *
 * What a screen shows for a given API answer is asserted here, against typed
 * stubs of the member-picture routes (the CI dev stack has no facts, gags or
 * AI doubles); whether the API gives that answer is held by the API suite
 * (`phase7.aiPictureFlow.test.ts`, `phase7.memberPictures.test.ts`).
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { factDetail, stubPublicFacts } from "./helpers/apiStubs";
import { PAID_ACCOUNT, TEST_ACCOUNT_PASSWORD, signInThroughForm } from "./helpers/testAccounts";

const FACT_ID = 1331;
const FACT_TEXT = "{NAME} out-lifted the forklift.";
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const upload = (objectPath: string) => ({
  objectPath, width: 800, height: 800, isLowRes: false, fileSizeBytes: 1, createdAt: "2026-01-01T00:00:00Z",
  transform: null, sourceObjectPath: null, factId: null, transformParamsHash: null, isProfile: false,
});

const picture = (status: "queued" | "done") => ({
  attemptId: 5, factId: FACT_ID, status, reason: null, creditReturned: false,
  aiImageId: status === "done" ? 77 : null,
  imageUrl: status === "done" ? "/api/memes/ai-user/image?storagePath=pic.png" : null,
  aspectRatio: "landscape", caption: { name: "Rex", pronouns: "he/him" }, createdAt: "2026-11-27T00:00:00Z",
});

/** Stubs every member-picture route the flow and the builder read; returns the command bodies sent. */
async function stubPictures(page: Page): Promise<Array<Record<string, unknown>>> {
  const commands: Array<Record<string, unknown>> = [];
  let made = false;
  await page.route(/\/api\/users\/me\/uploads/, (r) => json(r, { uploads: [upload("/objects/uploads/rex.jpg")], nextCursor: null }));
  await page.route(/\/api\/storage\/objects\//, (r) => r.fulfill({ status: 200, contentType: "image/png", body: PIXEL }));
  await page.route(/\/api\/memes\/ai-user\/image/, (r) => r.fulfill({ status: 200, contentType: "image/png", body: PIXEL }));
  await page.route(/\/api\/users\/me\/ai-images/, (r) => json(r, { images: [], nextCursor: null }));
  await page.route(/\/api\/look-styles$/, (r) => json(r, []));
  await page.route(new RegExp(`/api/facts/${FACT_ID}/picture-options$`), (r) => json(r, {
    gags: [{ gagId: 9, slot: 1, description: "{NAME} lifts the forklift with one paw.", examples: { male: null, female: null, pet: null } }],
    choice: false, credits: 3, nextIsFree: false,
  }));
  await page.route(/\/api\/member-pictures\/photo-check$/, (r) => json(r, { uploadKey: "/objects/uploads/rex.jpg", subject: "pet" }));
  await page.route(new RegExp(`/api/facts/${FACT_ID}/member-pictures$`), (r) => {
    commands.push(r.request().postDataJSON() as Record<string, unknown>);
    made = true;
    return json(r, { picture: picture("queued"), credits: 2 }, 202);
  });
  await page.route(/\/api\/member-pictures$/, (r) => json(r, { pictures: made ? [picture("done")] : [], credits: 2 }));
  await page.route(/\/api\/member-pictures\/5$/, (r) => json(r, { picture: picture("done"), credits: 2 }));
  return commands;
}

async function wizardDraft(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate((id) => JSON.parse(window.sessionStorage.getItem(`pending_meme_wizard_v2::${id}`) ?? "{}"), String(FACT_ID));
}

test("builder → picture page → builder: Back keeps the meme as it was, a reload on the picture page included, and a pet picture arrives in its shape with the pet's name", async ({ page }) => {
  await signInThroughForm(page, PAID_ACCOUNT.email, TEST_ACCOUNT_PASSWORD);
  await stubPublicFacts(page, { facts: [factDetail({ id: FACT_ID, text: FACT_TEXT })] });
  const commands = await stubPictures(page);

  await page.goto(`/facts/${FACT_ID}/meme`);
  await expect(page.getByRole("button", { name: "Make my meme" })).toBeVisible();
  await page.getByTestId("aspect-square").click();
  await page.getByTestId("meme-visibility-private").click();
  // The draft is saved after each change: read it once both have landed.
  await expect.poll(async () => { const d = await wizardDraft(page); return [d["aspectRatio"], d["isPublic"]]; }).toEqual(["square", false]);
  const before = await wizardDraft(page);

  // The builder's button opens the flow with the builder's shape.
  await page.getByTestId("ai-picture-open").click();
  await expect(page).toHaveURL(new RegExp(`/facts/${FACT_ID}/picture\\?from=builder$`));
  await expect(page.getByTestId("aspect-square")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Your meme uses this shape. You can change it in the builder, but the picture will be cropped to fit.")).toBeVisible();

  // Back: the half-made meme is exactly as it was.
  await page.getByTestId("ai-picture-back").click();
  await expect(page.getByRole("button", { name: "Make my meme" })).toBeVisible();
  await expect(page.getByTestId("aspect-square")).toHaveAttribute("aria-checked", "true");
  const after = await wizardDraft(page);
  expect({ ...after, capturedAt: 0 }).toEqual({ ...before, capturedAt: 0 });

  // A real page load on the picture page (a refresh, a phone restoring the
  // tab) is not a sign-in: Back still finds the half-made meme.
  await page.getByTestId("ai-picture-open").click();
  await expect(page).toHaveURL(new RegExp(`/facts/${FACT_ID}/picture\\?from=builder$`));
  await page.reload();
  await expect(page.getByTestId("ai-picture-flow")).toBeVisible();
  await expect(page.getByTestId("aspect-square")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("ai-picture-back").click();
  await expect(page.getByRole("button", { name: "Make my meme" })).toBeVisible();
  const afterReload = await wizardDraft(page);
  expect({ ...afterReload, capturedAt: 0 }).toEqual({ ...before, capturedAt: 0 });

  // A pet picture, in another shape, again after a reload while on the page.
  await page.getByTestId("ai-picture-open").click();
  await page.reload();
  await expect(page.getByText("A picture of your pet.")).toBeVisible();
  await expect(page.getByText(/who's in the picture/i)).toHaveCount(0);
  await page.getByTestId("ai-picture-pet-name").fill("Rex");
  await page.getByTestId("ai-picture-caption-pronouns").selectOption("he/him");
  await page.getByTestId("aspect-landscape").click();
  await page.getByTestId("ai-picture-confirm").click();
  await page.getByTestId("ai-picture-make-meme").click();

  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ subject: { kind: "pet", name: "Rex" }, aspectRatio: "landscape", caption: { name: "Rex", pronouns: "he/him" } });

  await expect(page.getByRole("button", { name: "Make my meme" })).toBeVisible();
  await expect(page.getByTestId("aspect-landscape")).toHaveAttribute("aria-checked", "true");
  const handedOff = await wizardDraft(page);
  expect(handedOff).toMatchObject({
    source: { kind: "ai-picture", aiImageId: 77 },
    aspectRatio: "landscape",
    name: "Rex",
    pronouns: "he/him",
    isPublic: before["isPublic"],
    splitIndex: before["splitIndex"],
  });
});
