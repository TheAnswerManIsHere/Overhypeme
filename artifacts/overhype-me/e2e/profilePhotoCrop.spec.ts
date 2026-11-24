/**
 * @purpose Real-browser checks of profile-photo zoom and crop (#1215, PLAN_PHOTO_CROP.md) on onboarding's photo step and Profile's "Change photo": what the round frame shows after dragging, slider and pinch zoom is exactly what is uploaded (read off the screen and off the outgoing JPEG, independently of the crop code), for a plain photo, an EXIF-rotated phone JPEG, a transparent PNG and an animated GIF; confirming untouched saves today's centre crop; cancel and a replaced selection upload nothing; a GIF on Profile skips the editor and uploads its original bytes; a pause during framing refuses the upload; a failed upload or profile-image save leaves the editor open with its error.
 * @subsystem studio
 */
import { expect, test, type BrowserContext, type Page, type Request } from "@playwright/test";
import { FREE_ACCOUNT, TEST_ACCOUNT_PASSWORD, signInThroughForm } from "./helpers/testAccounts";

type RGB = [number, number, number];

const FIXTURE_W = 800;
const FIXTURE_H = 600;
/** Points inside the round frame (normalised to the square), clear of its border. */
const PROBES: Array<[number, number]> = [
  [0.5, 0.5],
  [0.3, 0.5],
  [0.7, 0.5],
  [0.5, 0.3],
  [0.5, 0.7],
  [0.35, 0.35],
  [0.65, 0.65],
];
/** JPEG compression and screen resampling move a smooth gradient by a few levels. */
const TOLERANCE = 12;

// ---------------------------------------------------------------- fixtures

/**
 * An 800×600 image whose every pixel names where it came from: red is x, green
 * is y, blue is 128 — so a sample anywhere says which source pixel is there.
 * With `transparentLeft`, the left half is fully transparent.
 */
async function gradientFixture(page: Page, type: "image/jpeg" | "image/png", transparentLeft = false): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ w, h, type, transparentLeft }) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d")!;
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          img.data[i] = Math.round((x / (w - 1)) * 255);
          img.data[i + 1] = Math.round((y / (h - 1)) * 255);
          img.data[i + 2] = 128;
          img.data[i + 3] = transparentLeft && x < w / 2 ? 0 : 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), type, 0.97));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (const byte of bytes) s += String.fromCharCode(byte);
      return btoa(s);
    },
    { w: FIXTURE_W, h: FIXTURE_H, type, transparentLeft },
  );
  return Buffer.from(b64, "base64");
}

/** The same JPEG carrying an EXIF Orientation of 6 — a phone photo taken upright, stored sideways. */
function withExifOrientation6(jpeg: Buffer): Buffer {
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF header, IFD at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, // Orientation = 6
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, payload, jpeg.subarray(2)]);
}

/** A 64×64 animated GIF: a red frame then a blue frame, looping every 0.2 s. */
function animatedGif(): Buffer {
  const W = 64;
  const H = 64;
  const bytes: number[] = [];
  const u16 = (n: number) => bytes.push(n & 0xff, (n >> 8) & 0xff);
  bytes.push(...Buffer.from("GIF89a", "binary"));
  u16(W);
  u16(H);
  bytes.push(0x91, 0, 0); // global table of 4 colours
  bytes.push(255, 0, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255);
  bytes.push(0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0", "binary"), 0x03, 0x01, 0x00, 0x00, 0x00);
  for (const index of [0, 1]) {
    bytes.push(0x21, 0xf9, 0x04, 0x00);
    u16(20);
    bytes.push(0x00, 0x00);
    bytes.push(0x2c);
    u16(0);
    u16(0);
    u16(W);
    u16(H);
    bytes.push(0x00, 0x02); // no local table; LZW minimum code size 2
    // Every pixel as CLEAR then its index, so the code width stays at 3 bits.
    const codes: number[] = [];
    for (let i = 0; i < W * H; i++) codes.push(4, index);
    codes.push(5);
    const data: number[] = [];
    let acc = 0;
    let nbits = 0;
    for (const code of codes) {
      acc |= code << nbits;
      nbits += 3;
      while (nbits >= 8) {
        data.push(acc & 0xff);
        acc >>= 8;
        nbits -= 8;
      }
    }
    if (nbits > 0) data.push(acc & 0xff);
    for (let i = 0; i < data.length; i += 255) {
      const block = data.slice(i, i + 255);
      bytes.push(block.length, ...block);
    }
    bytes.push(0x00);
  }
  bytes.push(0x3b);
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------- reading pixels

/** Decode an image in the page and read the pixel at each normalised point. */
async function samplesOf(page: Page, image: Buffer, mime: string): Promise<{ width: number; height: number; px: RGB[] }> {
  return page.evaluate(
    async ({ b64, mime, probes }) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([arr], { type: mime }));
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const px = probes.map(([u, v]) => {
        const d = ctx.getImageData(Math.floor(u * (bmp.width - 1)), Math.floor(v * (bmp.height - 1)), 1, 1).data;
        return [d[0], d[1], d[2]] as [number, number, number];
      });
      return { width: bmp.width, height: bmp.height, px };
    },
    { b64: image.toString("base64"), mime, probes: PROBES },
  );
}

/** What the member sees in the frame: a screenshot of the stage, sampled. */
async function previewSamples(page: Page): Promise<RGB[]> {
  const shot = await page.getByTestId("photo-crop-stage").screenshot({ animations: "disabled" });
  return (await samplesOf(page, shot, "image/png")).px;
}

function expectClose(actual: RGB[], expected: RGB[], what: string): void {
  actual.forEach((a, i) => {
    const e = expected[i];
    const worst = Math.max(...a.map((c, k) => Math.abs(c - e[k])));
    expect(worst, `${what}: probe ${PROBES[i]} saw ${a}, expected ${e}`).toBeLessThanOrEqual(TOLERANCE);
  });
}

// ---------------------------------------------------------------- the surfaces

interface Captured {
  uploads: Buffer[];
  uploadTypes: string[];
  profileSets: number;
}

/** Answer the avatar upload and the profile-image set ourselves, and record what was sent. */
async function stubPhotoSave(page: Page, opts: { uploadStatus?: number; setStatus?: number } = {}): Promise<Captured> {
  const captured: Captured = { uploads: [], uploadTypes: [], profileSets: 0 };
  await page.route("**/api/storage/upload-avatar", async (route) => {
    const req: Request = route.request();
    captured.uploads.push(req.postDataBuffer() ?? Buffer.alloc(0));
    captured.uploadTypes.push(req.headers()["content-type"] ?? "");
    if (opts.uploadStatus && opts.uploadStatus !== 200) {
      await route.fulfill({ status: opts.uploadStatus, json: { error: "The upload broke." } });
      return;
    }
    await route.fulfill({ json: { objectPath: "/objects/uploads/e2e-crop-test", width: 1, height: 1 } });
  });
  await page.route("**/api/users/me/profile-image", async (route) => {
    captured.profileSets += 1;
    if (opts.setStatus && opts.setStatus !== 200) {
      await route.fulfill({ status: opts.setStatus, json: { error: "Could not save your photo." } });
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });
  return captured;
}

/** Onboarding's photo step, reached by finishing set-up with the server's answers stubbed. */
async function openOnboardingPhotoStep(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { turnstile: unknown }).turnstile = {
      render: (_el: HTMLElement, opts: { callback: (t: string) => void }) => {
        setTimeout(() => opts.callback("e2e-token"), 0);
        return "e2e-widget";
      },
      reset: () => {},
      remove: () => {},
    };
  });
  await page.route("**/api/auth/onboarding", (route) =>
    route.fulfill({
      json: {
        completed: false,
        emailVerified: true,
        marketingDefault: false,
        marketingWordingVersion: "e2e",
        accountPronouns: "he/him",
        displayName: "Crop Tester",
        providerFirstName: null,
        draft: null,
        dateOfBirth: "1990-06-15",
      },
    }),
  );
  await page.route("**/api/users/me/onboarding/draft", (route) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/users/me/onboarding", (route) =>
    route.request().method() === "POST" ? route.fulfill({ json: { ok: true } }) : route.fallback(),
  );
  await page.goto("/onboard");
  await page.getByTestId("onboard-legal-agree").check();
  const finish = page.getByRole("button", { name: "Finish set-up" });
  await expect(finish).toBeEnabled();
  await finish.click();
  await expect(page.getByRole("heading", { name: /add a real photo of you/i })).toBeVisible();
}

async function pickOnboarding(page: Page, name: string, mimeType: string, buffer: Buffer): Promise<void> {
  await page.locator('input[type="file"]:not([capture])').setInputFiles({ name, mimeType, buffer });
  await expect(page.getByTestId("photo-crop-confirm")).toBeEnabled();
}

async function openProfile(page: Page): Promise<void> {
  await page.goto("/profile");
  await expect(page.locator('input[type="file"][accept="image/jpeg,image/png,image/webp,image/gif"]')).toBeAttached();
}

async function pickProfile(page: Page, name: string, mimeType: string, buffer: Buffer): Promise<void> {
  await page
    .locator('input[type="file"][accept="image/jpeg,image/png,image/webp,image/gif"]')
    .setInputFiles({ name, mimeType, buffer });
}

/** Zoom fully in with the slider, then drag the photo as far right and down as it goes. */
async function zoomInAndDragToTopLeft(page: Page): Promise<void> {
  const thumb = page.getByTestId("photo-crop-zoom").getByRole("slider");
  await thumb.focus();
  await page.keyboard.press("End");
  await expect(thumb).toHaveAttribute("aria-valuenow", "4");
  const box = (await page.getByTestId("photo-crop-stage").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 600, cy + 600, { steps: 12 });
  await page.mouse.up();
}

async function confirmAndCapture(page: Page, captured: Captured): Promise<Buffer> {
  await page.getByTestId("photo-crop-confirm").click();
  await expect.poll(() => captured.uploads.length).toBe(1);
  return captured.uploads[0];
}

// ---------------------------------------------------------------- the tests

/**
 * One real sign-in for the whole file, its session cookies reused by every test: the
 * per-account sign-in throttle (30 in 15 minutes) is shared with every other spec that
 * signs in as the free account in the same run.
 */
let session: Awaited<ReturnType<BrowserContext["cookies"]>> = [];

async function useSession(context: BrowserContext): Promise<void> {
  await context.addCookies(session);
}

test.describe("Profile photo zoom and crop (#1215)", () => {
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signInThroughForm(page, FREE_ACCOUNT.email, TEST_ACCOUNT_PASSWORD);
    session = await context.cookies();
    await context.close();
  });

  test.beforeEach(async ({ page }) => {
    await useSession(page.context());
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test("onboarding: what the frame shows after zoom and drag is exactly what is uploaded", async ({ page }) => {
    await openOnboardingPhotoStep(page);
    const captured = await stubPhotoSave(page);
    await pickOnboarding(page, "photo.jpg", "image/jpeg", await gradientFixture(page, "image/jpeg"));

    await zoomInAndDragToTopLeft(page);
    const preview = await previewSamples(page);
    const jpeg = await confirmAndCapture(page, captured);
    const out = await samplesOf(page, jpeg, "image/jpeg");

    expect(captured.uploadTypes[0]).toBe("image/jpeg");
    // At 4× the frame is a quarter of the 600-px short side: the 150-px square in the top-left
    // corner, kept at its own size (never enlarged).
    expect([out.width, out.height]).toEqual([150, 150]);
    expectClose(out.px, preview, "the saved photo against the frame on screen");
    // From first principles: the frame's centre is source pixel (75, 75).
    expectClose([out.px[0]], [[Math.round((75 / 799) * 255), Math.round((75 / 599) * 255), 128]], "the frame's centre");
    await expect(page).toHaveURL((u) => u.pathname !== "/onboard");
  });

  test("onboarding: confirming untouched saves today's centre square", async ({ page }) => {
    await openOnboardingPhotoStep(page);
    const captured = await stubPhotoSave(page);
    await pickOnboarding(page, "photo.jpg", "image/jpeg", await gradientFixture(page, "image/jpeg"));
    const preview = await previewSamples(page);
    const out = await samplesOf(page, await confirmAndCapture(page, captured), "image/jpeg");
    expect([out.width, out.height]).toEqual([600, 600]);
    expectClose(out.px, preview, "untouched");
    // The centre square of 800×600 is x 100..700: its centre is source pixel (400, 300).
    expectClose([out.px[0]], [[Math.round((400 / 799) * 255), Math.round((300 / 599) * 255), 128]], "centre");
  });

  test("onboarding: an EXIF-rotated phone photo is framed upright, and saved as framed", async ({ page }) => {
    await openOnboardingPhotoStep(page);
    const captured = await stubPhotoSave(page);
    const rotated = withExifOrientation6(await gradientFixture(page, "image/jpeg"));
    await pickOnboarding(page, "phone.jpg", "image/jpeg", rotated);
    const preview = await previewSamples(page);
    const out = await samplesOf(page, await confirmAndCapture(page, captured), "image/jpeg");
    expectClose(out.px, preview, "rotated");
    // Upright, the photo is 600×800 and the centre square is its rows 100..700. The upper probe
    // (0.5, 0.3) is upright pixel (299, 279), stored pixel (279, 300): red ≈ 89, green ≈ 128.
    // Ignoring the rotation would read stored (399, 179): red ≈ 127, green ≈ 76.
    expect([out.width, out.height]).toEqual([600, 600]);
    expectClose([out.px[3]], [[89, 128, 128]], "the rotation was applied");
  });

  test("onboarding: a transparent PNG previews on the same black backing it is saved with", async ({ page }) => {
    await openOnboardingPhotoStep(page);
    const captured = await stubPhotoSave(page);
    await pickOnboarding(page, "clear.png", "image/png", await gradientFixture(page, "image/png", true));
    const preview = await previewSamples(page);
    const out = await samplesOf(page, await confirmAndCapture(page, captured), "image/jpeg");
    expectClose(out.px, preview, "transparent PNG");
    // The left probe sits in the transparent half: black in both.
    expectClose([out.px[1]], [[0, 0, 0]], "transparent area");
  });

  test("onboarding: an animated GIF previews one still frame, and that frame is what is saved", async ({ page }) => {
    await openOnboardingPhotoStep(page);
    const captured = await stubPhotoSave(page);
    await pickOnboarding(page, "moving.gif", "image/gif", animatedGif());
    const first = await previewSamples(page);
    await page.waitForTimeout(700); // past three frame changes
    const later = await previewSamples(page);
    expectClose(later, first, "the preview holds still");
    const out = await samplesOf(page, await confirmAndCapture(page, captured), "image/jpeg");
    expect(captured.uploadTypes[0]).toBe("image/jpeg");
    expectClose(out.px, first, "animated GIF");
  });

  test("onboarding: picking a different one, even mid-encode, uploads nothing", async ({ page }) => {
    await openOnboardingPhotoStep(page);
    const captured = await stubPhotoSave(page);
    await pickOnboarding(page, "photo.jpg", "image/jpeg", await gradientFixture(page, "image/jpeg"));
    // Confirm and cancel in the same task: the encode started by the click must not publish.
    await page.evaluate(() => {
      (document.querySelector('[data-testid="photo-crop-confirm"]') as HTMLButtonElement).click();
      const cancel = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Pick a different one"));
      cancel!.click();
    });
    await expect(page.getByTestId("photo-crop-editor")).toHaveCount(0);
    await page.waitForTimeout(1000);
    expect(captured.uploads).toHaveLength(0);
    await expect(page.getByRole("button", { name: /upload/i }).first()).toBeVisible();
  });

  test("Profile: pick, pinch to zoom, drag — the saved photo is the framed square", async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true, viewport: { width: 1280, height: 900 } });
    await useSession(context);
    const page = await context.newPage();
    await openProfile(page);
    const captured = await stubPhotoSave(page);
    await pickProfile(page, "photo.jpg", "image/jpeg", await gradientFixture(page, "image/jpeg"));
    await expect(page.getByTestId("profile-photo-crop-dialog")).toBeVisible();
    await expect(page.getByTestId("photo-crop-confirm")).toBeEnabled();

    // Two fingers spreading apart on the stage.
    const box = (await page.getByTestId("photo-crop-stage").boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const cdp = await context.newCDPSession(page);
    const touch = (type: string, d: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }],
      });
    await touch("touchStart", 20);
    for (let d = 25; d <= 100; d += 5) await touch("touchMove", d);
    await touch("touchEnd", 0);
    const zoom = Number(await page.getByTestId("photo-crop-zoom").getByRole("slider").getAttribute("aria-valuenow"));
    expect(zoom, "the pinch zoomed in").toBeGreaterThan(2);

    // Then a one-finger drag via the mouse.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 40, cy + 30, { steps: 6 });
    await page.mouse.up();

    const preview = await previewSamples(page);
    const out = await samplesOf(page, await confirmAndCapture(page, captured), "image/jpeg");
    expectClose(out.px, preview, "Profile after pinch and drag");
    expect(out.width).toBe(out.height);
    expect(out.width).toBeLessThan(600 / 2);
    await expect.poll(() => captured.profileSets).toBe(1);
    await expect(page.getByTestId("profile-photo-crop-dialog")).toHaveCount(0);
    await context.close();
  });

  test("Profile: cancelling the crop uploads nothing", async ({ page }) => {
    await openProfile(page);
    const captured = await stubPhotoSave(page);
    await pickProfile(page, "photo.jpg", "image/jpeg", await gradientFixture(page, "image/jpeg"));
    await expect(page.getByTestId("photo-crop-confirm")).toBeEnabled();
    await page.getByTestId("profile-photo-crop-dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("profile-photo-crop-dialog")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(captured.uploads).toHaveLength(0);
  });

  test("Profile: a GIF skips the editor and uploads its original bytes", async ({ page }) => {
    await openProfile(page);
    const captured = await stubPhotoSave(page);
    const gif = animatedGif();
    await pickProfile(page, "moving.gif", "image/gif", gif);
    await expect.poll(() => captured.uploads.length).toBe(1);
    await expect(page.getByTestId("profile-photo-crop-dialog")).toHaveCount(0);
    expect(captured.uploadTypes[0]).toBe("image/gif");
    expect(captured.uploads[0].equals(gif), "the GIF's bytes are sent unchanged").toBe(true);
  });

  test("Profile: a pause that begins while framing refuses the upload", async ({ page }) => {
    await openProfile(page);
    const captured = await stubPhotoSave(page);
    await pickProfile(page, "photo.jpg", "image/jpeg", await gradientFixture(page, "image/jpeg"));
    await expect(page.getByTestId("photo-crop-confirm")).toBeEnabled();
    // The pause lands after the click, while the JPEG is being encoded.
    await page.evaluate(async () => {
      const mod = (await import(/* @vite-ignore */ "/src/lib/readOnlyNotice.ts")) as { setReadOnlyNow: (on: boolean) => void };
      (document.querySelector('[data-testid="photo-crop-confirm"]') as HTMLButtonElement).click();
      mod.setReadOnlyNow(true);
    });
    await expect(page.getByTestId("profile-photo-crop-dialog")).toHaveCount(0);
    await page.waitForTimeout(1000);
    expect(captured.uploads).toHaveLength(0);
  });

  test("Profile: a failed upload keeps the editor open with its error, and sets nothing", async ({ page }) => {
    await openProfile(page);
    const captured = await stubPhotoSave(page, { uploadStatus: 500 });
    await pickProfile(page, "photo.jpg", "image/jpeg", await gradientFixture(page, "image/jpeg"));
    await page.getByTestId("photo-crop-confirm").click();
    const dialog = page.getByTestId("profile-photo-crop-dialog");
    await expect(dialog.getByText("The upload broke.")).toBeVisible();
    expect(captured.profileSets).toBe(0);
  });

  test("Profile: a failed profile-image save keeps the editor open with its error", async ({ page }) => {
    await openProfile(page);
    const captured = await stubPhotoSave(page, { setStatus: 500 });
    await pickProfile(page, "photo.jpg", "image/jpeg", await gradientFixture(page, "image/jpeg"));
    await page.getByTestId("photo-crop-confirm").click();
    const dialog = page.getByTestId("profile-photo-crop-dialog");
    await expect(dialog.getByText("Could not save your photo.")).toBeVisible();
    expect(captured.uploads).toHaveLength(1);
    await expect(page.locator('img[src*="e2e-crop-test"]')).toHaveCount(0);
  });
});
