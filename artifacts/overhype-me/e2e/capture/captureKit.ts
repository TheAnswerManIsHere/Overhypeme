/**
 * The UAT capture kit (Launch Phase 2, increment 8, #631;
 * `docs/plans/PLAN_PHASE2_INC8_CAPTURE.md` D2, D5, D6).
 *
 * A capture spec drives the app to a named state and writes the image a UAT
 * `capture` step is read from. Producing the image proves only that it
 * exists: the step's result is Claude's reading of it at run time (the `uat`
 * skill, section 3), never this spec's exit status. CI runs the capture set so
 * a shot that can no longer be produced fails the PR that broke it.
 *
 * Every shot lands in UAT_CAPTURE_DIR with a manifest line naming the UAT doc
 * and step it answers, the commit it was taken at and its sha256, so a run
 * record can link the exact bytes it read.
 *
 * The stack is the acceptance launcher's serve mode (`acceptance-run.ts
 * --mode serve --variant fixture --origin <this Vite>`), never the plain dev
 * entrypoint: the launcher refuses an unmarked database and starts the server
 * with no vendor key, so a capture can reach neither a paid vendor nor a
 * deployed environment.
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { FREE_ACCOUNT, TEST_ACCOUNT_PASSWORD } from "../helpers/testAccounts";

export const CAPTURE_DIR = path.resolve(process.env["UAT_CAPTURE_DIR"] ?? "test-results/uat-captures");
/**
 * The commit the shots were taken at, read from the checkout that ran them
 * and never taken as input: a caller-supplied value could name a tree that is
 * not what was captured (#706 round 1, 4290933096; agents-core.md, derive
 * what is derivable).
 */
export const CAPTURE_COMMIT = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export interface ShotMeta {
  /** The UAT doc's filename stem, e.g. PR398_MEME_SPLIT_CAPTION_PERSONALIZATION_UAT. */
  doc: string;
  /** The step id within the doc, e.g. "3" or "R1". */
  step: string;
  /** What the image shows, in the words a reader checks it against. */
  shows: string;
}

/** Write one shot and its manifest line. Refuses an empty image. */
export function saveShot(name: string, bytes: Buffer, meta: ShotMeta, ext = "png"): string {
  expect(bytes.length, `shot ${name} is empty`).toBeGreaterThan(1000);
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  const file = `${name}.${ext}`;
  fs.writeFileSync(path.join(CAPTURE_DIR, file), bytes);
  const line = {
    shot: name,
    file,
    ...meta,
    commit: CAPTURE_COMMIT,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
  // One record per file, always true to the bytes on disk: a rerun into the
  // same directory replaces the shot AND its record (#706 round 1,
  // 4290933106). Read-modify-write, not a run-start reset, so it stays right
  // when Playwright restarts a worker mid-run.
  const manifest = path.join(CAPTURE_DIR, "manifest.jsonl");
  const kept = fs.existsSync(manifest)
    ? fs.readFileSync(manifest, "utf8").split("\n").filter((l) => l.trim() && (JSON.parse(l) as { file?: string }).file !== file)
    : [];
  fs.writeFileSync(manifest, [...kept, JSON.stringify(line)].join("\n") + "\n");
  return file;
}

/**
 * Where the free test account's signed-in session is kept for the run:
 * outside the evidence directory, so a session cookie never reaches the
 * evidence store.
 */
export const FREE_SESSION = path.resolve("test-results/.uat-capture-free-session.json");
let freeSessionMade = false;

/**
 * Sign in once per run and keep the session: the server rate-limits
 * sign-ins, and a capture set signs in for every test otherwise.
 */
export async function ensureFreeSession(browser: Browser, baseURL: string): Promise<void> {
  if (freeSessionMade) return; // a file left by an earlier run may name a server that is gone
  fs.mkdirSync(path.dirname(FREE_SESSION), { recursive: true });
  // The spec's storageState option applies to this context too, so start it
  // from an empty session rather than whatever an earlier run left.
  fs.writeFileSync(FREE_SESSION, JSON.stringify({ cookies: [], origins: [] }));
  const context = await browser.newContext({ baseURL });
  await signInFree(context);
  await context.storageState({ path: FREE_SESSION });
  await context.close();
  freeSessionMade = true;
}

/** Sign the context in as the seeded free (plain registered) test account. */
export async function signInFree(context: BrowserContext): Promise<void> {
  await context.request.get("/api/config");
  const csrf = (await context.cookies()).find((c) => c.name === "csrf_token")?.value ?? "";
  const res = await context.request.post("/api/auth/local-login", {
    data: { email: FREE_ACCOUNT.email, password: TEST_ACCOUNT_PASSWORD },
    headers: { "X-CSRF-Token": csrf },
  });
  expect(res.ok(), `local-login as the free test account: ${res.status()}`).toBe(true);
}

/** The id of the active fact whose template text is exactly `text`. */
export async function factIdByText(request: APIRequestContext, text: string): Promise<number> {
  const res = await request.get(`/api/facts?limit=100&search=${encodeURIComponent(text.replace(/\{[^}]*\}/g, " ").trim().split(/\s+/)[0] ?? "")}`);
  expect(res.ok()).toBe(true);
  const { facts } = (await res.json()) as { facts: Array<{ id: number; text: string }> };
  const hit = facts.find((f) => f.text === text);
  if (!hit) throw new Error(`no active fact with text ${JSON.stringify(text)}; the capture set needs the legacy fixture (--variant fixture)`);
  return hit.id;
}

/**
 * Set a builder slider by clicking its track at the value's fraction. The
 * split slider moves in 0.001 steps and commits the rounded word index on
 * release, so a click lands on the intended index where a key press would not.
 */
export async function setSlider(slider: Locator, value: number, min: number, max: number): Promise<void> {
  const track = slider.locator("xpath=ancestor::span[contains(@class,'touch-none')][1]");
  const box = await track.boundingBox();
  if (!box) throw new Error("slider track has no box");
  const frac = (value - min) / (max - min);
  await slider.page().mouse.click(box.x + box.width * frac, box.y + box.height / 2);
}

/** Open the image-meme builder on a fact and load a fixture photo into it. */
export async function openBuilderWithPhoto(page: Page, factId: number, photo = "framing-chart.jpg"): Promise<void> {
  await page.goto(`/facts/${factId}/meme`, { waitUntil: "networkidle" });
  await page.getByText("UPLOAD NEW").click();
  await page.locator('input[type="file"]').first().setInputFiles(path.join(FIXTURES, photo));
  await expect(page.getByText(/\d+ × \d+/)).toBeVisible({ timeout: 30_000 });
  await page.getByText("ADJUST THE TEXT").click();
}

/** The live preview canvas as drawn now. */
export async function previewShot(page: Page): Promise<Buffer> {
  const canvas = page.getByLabel("Meme preview");
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(500); // the canvas redraws on the next frame after a control change
  return canvas.screenshot();
}

/** Save the meme and return its slug and the served picture's bytes. */
export async function saveMeme(page: Page): Promise<{ slug: string; picture: Buffer; contentType: string }> {
  await page.getByRole("button", { name: "Make my meme" }).click();
  await page.waitForURL(/\/m\/[A-Za-z0-9_-]+$/, { timeout: 60_000 });
  const slug = new URL(page.url()).pathname.split("/").pop()!;
  const res = await page.request.get(`/api/memes/${slug}/image`);
  expect(res.ok(), `the saved meme's image: ${res.status()}`).toBe(true);
  return { slug, picture: await res.body(), contentType: res.headers()["content-type"] ?? "" };
}

export function extOf(contentType: string): string {
  return contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
}

/** Width and height read from a JPEG or PNG header; no image library needed. */
export function imageSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.subarray(1, 4).toString("ascii") === "PNG") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length) {
      if (bytes[i] !== 0xff) throw new Error(`malformed JPEG at byte ${i}`);
      const marker = bytes[i + 1]!;
      const len = bytes.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  throw new Error("not a JPEG or PNG");
}
