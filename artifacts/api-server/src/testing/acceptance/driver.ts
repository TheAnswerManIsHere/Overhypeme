/**
 * The baseline driver (Launch Phase 2, increments 4 and 6, #631; plans
 * `PLAN_PHASE2_INC4_AI_DOUBLES.md` D6/D7 and `PLAN_PHASE2_INC6_ACCEPTANCE.md`
 * D2).
 *
 * Walks baseline journeys 2, 3, 4 and 7 over HTTP, making the calls the frontend makes,
 * as the seeded ordinary accounts and the bootstrap admin:
 *
 * - journey 2 — the free user completes onboarding and submits a fact
 *   (tokenise, duplicate check, hashtags, submit), and the submission is in
 *   the admin queue at triage before any moderation call;
 * - journey 3 — the admin takes it through triage, preparation, the saved
 *   gag, its male render and then its female and pet renders, each asked
 *   for (nothing draws by itself, Issue #1282), and the
 *   three approved as the gag's examples, to an active fact; each render's
 *   image decodes (plan PLAN_GAG_EXAMPLES.md);
 * - journey 7 — the free user uploads a photo; the owner reads back the same
 *   bytes, another user is refused;
 * - journey 4 — the free user saves a public meme composed from that photo;
 *   anyone reads its permalink and image.
 *
 * Each journey reports `passed`, `failed` or `not-run`; one whose
 * prerequisite did not pass is `not-run`, never omitted, so an aborted chain
 * stays visibly incomplete. Every image a journey reads back must decode
 * (`src/testing/acceptance/imageCheck.ts`). The two meme journeys save
 * recipes with no preview image, so the image served is composed from the
 * selected source at read time and a fixed preview cannot stand in for it.
 *
 * The same driver runs under every mode of `scripts/acceptance-run.ts`, so a
 * live or recording run's requests are the acceptance run's. It lives in
 * `src/testing/` (never imported by the deployment entrypoint) and is called
 * by the runner's inner program (`./inner.ts`). Every input is
 * fixed — the fact text, the account data, the committed fixture images.
 *
 * Journeys 5 and 6 (the paid-generation refusal and the paid AI image) ran
 * the user AI generate route, which only the legacy meme studio calls; they
 * are removed with it (David, 2026-10-17, `docs/ai-context/decisions.md`,
 * *Verification work tied to the legacy meme studio is killed*).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { checkImage } from "./imageCheck";
import { renderCoverageProblems, settledBaselineRenders } from "../aiBaselineCoverage";

import { requiredLegalVersions } from "../../lib/legalAcceptance";
/**
 * Two decoded pictures (raw pixels, same size) are the same drawing when no colour value differs by more than
 * SAME_DRAWING_TOLERANCE: each saved meme carries its own invisible watermark (image tracing, #912), which moves
 * values by at most 18 of 255 (measured), while any change of a single glyph moves thousands by far more.
 */
const SAME_DRAWING_TOLERANCE = 48;
function sameDrawing(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > SAME_DRAWING_TOLERANCE) return false;
  return true;
}

/**
 * The same lettering, whatever colour the name is drawn in. Since PR #872 a
 * saved meme draws a `{NAME}` piece in the brand colour (MEME_NAME_COLOR,
 * #FF6600) and hand-typed words in the caption's white, so a tokenised caption
 * and its hand-typed twin can never be the same drawing. Both colours have a
 * red channel of 255, and every blend of a fill with the black outline or the
 * photo blends its red channel identically, so comparing the red channel alone
 * (raw RGB, three bytes a pixel) removes that one difference and keeps every
 * other: a surviving token, a brace, a shortened name or a wrong conjugation
 * still moves thousands of red values.
 *
 * Its own tolerance: the saved meme is a JPEG, whose colour subsampling bleeds
 * the orange-against-white difference into the red channel at the letters'
 * edges. Measured on the baseline journey (2026-11-14): at most 85 of 255, on
 * 631 pixels, with identical lettering. A changed glyph swaps black outline,
 * white fill or photo, which moves red by well over 120.
 *
 * And a small count of pixels allowed past it: the name and the punctuation
 * after it are separate pieces, each outlined on its own, so where the name's
 * last letter meets a comma the outlines overlap differently. Measured: 22
 * pixels in a strip 2 px wide, invisible; any changed glyph moves thousands.
 */
const SAME_LETTERING_TOLERANCE = 120;
const SAME_LETTERING_MAX_PIXELS = 64;
function sameLettering(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let over = 0;
  for (let i = 0; i < a.length; i += 3) if (Math.abs(a[i]! - b[i]!) > SAME_LETTERING_TOLERANCE && ++over > SAME_LETTERING_MAX_PIXELS) return false;
  return true;
}

/**
 * Whether the tokenised caption drew its name in the brand colour where the
 * hand-typed twin drew white: the green channel falls from 255 to 102 on the
 * name's fill. A floor of pixels, so the watermark's noise cannot pass for it.
 */
const NAME_COLOURED_MIN_PIXELS = 200;
function nameDrawnInBrandColour(tokenised: Buffer, typed: Buffer): boolean {
  let n = 0;
  for (let i = 1; i < tokenised.length; i += 3) if (typed[i]! - tokenised[i]! > 100 && ++n >= NAME_COLOURED_MIN_PIXELS) return true;
  return false;
}

/** The committed account definitions and fixture images live beside the scripts that seed and record them. */
const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts");

/**
 * The baseline fact, as a user types it (plain text; the tokeniser turns the
 * name and pronouns into tokens). Fixed: every recorded request downstream
 * derives from it.
 */
export const BASELINE_FACT =
  "David once counted to infinity. Twice. The second time he did it backwards to check his work.";

const accounts = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "e2e-test-accounts.json"), "utf8")) as {
  password: string;
  free: { email: string };
  paid: { email: string };
};
const fixture = (name: string) => fs.readFileSync(path.join(SCRIPTS, "fixtures/ai-baseline", name));

export class JourneyError extends Error {
  constructor(journey: string, step: string, detail: string) {
    super(`[journey ${journey}] ${step}: ${detail}`);
    this.name = "JourneyError";
  }
}

/** A cookie jar per identity: Set-Cookie parsed by hand, so Secure cookies work over local http. */
export class Session {
  private cookies = new Map<string, string>();
  constructor(
    private readonly base: string,
    readonly label: string,
  ) {}

  private absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async request(method: string, url: string, body?: unknown, contentType = "application/json"): Promise<Response> {
    if (!this.cookies.has("csrf_token")) {
      this.absorb(await fetch(`${this.base}/api/config`));
    }
    const headers: Record<string, string> = {
      Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    };
    if (method !== "GET") headers["X-CSRF-Token"] = this.cookies.get("csrf_token") ?? "";
    let payload: Uint8Array | string | undefined;
    if (body instanceof Buffer) {
      headers["Content-Type"] = contentType;
      payload = new Uint8Array(body);
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${this.base}${url}`, { method, headers, body: payload });
    this.absorb(res);
    return res;
  }

  /** A JSON call that must return `expect`; returns the parsed body. */
  async json<T = any>(journey: string, method: string, url: string, body?: unknown, expect = [200]): Promise<T> {
    const res = await this.request(method, url, body);
    const text = await res.text();
    if (!expect.includes(res.status)) throw new JourneyError(journey, `${method} ${url}`, `${res.status} ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : null) as T;
  }
}

export async function poll<T>(journey: string, what: string, read: () => Promise<T>, done: (v: T) => boolean, failed: (v: T) => string | null, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    const failure = failed(value);
    if (failure) throw new JourneyError(journey, what, failure);
    if (done(value)) return value;
    if (Date.now() > deadline) throw new JourneyError(journey, what, `not done after ${timeoutMs / 1000}s: ${JSON.stringify(value).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export type JourneyKey = "2" | "3" | "4" | "7";
export const JOURNEYS: readonly JourneyKey[] = ["2", "3", "4", "7"];

export interface JourneyOutcome {
  journey: JourneyKey;
  status: "passed" | "failed" | "not-run";
  evidence: Record<string, unknown>;
  error?: string;
  /** Clauses of the journey that are deferred to a named owner: reported, never passed. */
  deferred?: string[];
}

export interface DriveResult {
  outcomes: JourneyOutcome[];
  /** Set only under `expectRenderFailure`: whether the recorded vendor error reached the render job's failed state. */
  control?: { ok: boolean; renders: Array<{ key: string; status: string; message?: string }>; detail: string };
  /** A failure before any journey could start (sign-in). */
  setupError?: string;
}

export interface DriveOptions {
  /**
   * Run with `AI_DOUBLE_FAIL=fal.subscribe:openai/gpt-image-2.6/sunburst/edit`: journey 3's
   * male render, which it asks for, must end failed — the recorded vendor error carried
   * through the real render job and the queue's give-up path, with the run
   * pinned to one picture attempt (`pinOneRenderAttempt` in inner.ts) — and
   * the run stops there. A control, never an acceptance pass.
   */
  expectRenderFailure?: boolean;
  /** Called with journey 7's object path before journey 4 composes from it (the corrupt-source control). */
  beforeJourney4?: (objectPath: string) => void;
}

export async function readImage(session: Session, journey: string, what: string, url: string, aspect?: "landscape"): Promise<{ bytes: Buffer; width: number; height: number; format: string }> {
  const res = await session.request("GET", url);
  if (res.status !== 200) throw new JourneyError(journey, what, `${res.status} from ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const check = await checkImage(bytes, res.headers.get("content-type"), aspect);
  if (!check.ok) throw new JourneyError(journey, what, check.problem);
  return { bytes, ...check.image };
}

export async function driveBaseline(base: string, log: (line: string) => void = () => {}, options: DriveOptions = {}): Promise<DriveResult> {
  const free = new Session(base, "free");
  const paid = new Session(base, "paid");
  const admin = new Session(base, "admin");
  const anonymous = new Session(base, "anonymous");

  const outcomes = new Map<JourneyKey, JourneyOutcome>();
  const result = (): DriveResult => ({
    outcomes: JOURNEYS.map((j) => outcomes.get(j) ?? { journey: j, status: "not-run", evidence: {}, error: "not reached" }),
  });
  async function run(journey: JourneyKey, needs: JourneyKey[], body: (evidence: Record<string, unknown>) => Promise<void>, deferred?: string[]) {
    const blocked = needs.filter((n) => outcomes.get(n)?.status !== "passed");
    if (blocked.length > 0) {
      outcomes.set(journey, { journey, status: "not-run", evidence: {}, error: `journey ${blocked.join(", ")} did not pass`, ...(deferred ? { deferred } : {}) });
      return;
    }
    const evidence: Record<string, unknown> = {};
    try {
      await body(evidence);
      outcomes.set(journey, { journey, status: "passed", evidence, ...(deferred ? { deferred } : {}) });
      log(`journey ${journey}: passed`);
    } catch (err) {
      outcomes.set(journey, { journey, status: "failed", evidence, error: (err as Error).message, ...(deferred ? { deferred } : {}) });
      log(`journey ${journey}: FAILED — ${(err as Error).message}`);
    }
  }

  // --- sign in -------------------------------------------------------------
  try {
    await free.json("2", "POST", "/api/auth/local-login", { email: accounts.free.email, password: accounts.password });
    await paid.json("7", "POST", "/api/auth/local-login", { email: accounts.paid.email, password: accounts.password });
    await admin.json("3", "POST", "/api/auth/dev-admin-login");
    log("signed in: free, paid, admin");
    // Existing accounts are asked once at their next sign-in (launch Phase 5):
    // each completes the one onboarding screen before it acts. A second
    // completion is a no-op, so an already-onboarded account passes through.
    // Set-up records the account's agreement to the current Terms and Privacy
    // page (launch Phase 14, increment 4).
    const onboarding = {
      pronouns: "they/them", dobYear: "1990", dobMonth: "1", dobDay: "1", marketingOptIn: false, captchaToken: "baseline",
      legalAcceptance: requiredLegalVersions(),
    };
    // Each account takes the step its state asks for: set-up (which records
    // the acceptance) for one not yet onboarded, and the existing-account
    // acceptance for one onboarded before acceptance existed (the fixture's).
    for (const [client, journey] of [[free, "2"], [paid, "7"], [admin, "3"]] as const) {
      const me = await client.json<{ user?: { eligibility?: string } }>(journey, "GET", "/api/auth/user");
      const state = me?.user?.eligibility;
      if (state === "unonboarded") await client.json(journey, "POST", "/api/users/me/onboarding", onboarding);
      else if (state === "terms_unaccepted") await client.json(journey, "POST", "/api/users/me/legal-acceptance", onboarding.legalAcceptance);
    }
    log("onboarded and accepted: free, paid, admin");
  } catch (err) {
    return { ...result(), setupError: (err as Error).message };
  }

  // --- journey 2: the free user submits a fact -----------------------------
  let reviewId = 0;
  let hashtags: string[] = [];
  await run("2", [], async (ev) => {
    const { template } = await free.json<{ template: string }>("2", "POST", "/api/ai/tokenize-fact", { text: BASELINE_FACT });
    const dup = await free.json<{ isDuplicate: boolean; confidence: number; matchingFactId?: number }>("2", "POST", "/api/ai/check-duplicate", { text: template });
    ({ hashtags } = await free.json<{ hashtags: string[] }>("2", "POST", "/api/ai/suggest-hashtags", { text: template }));
    const submitted = await free.json<{ reviewId: number }>(
      "2",
      "POST",
      "/api/facts/submit-review",
      {
        text: template,
        hashtags,
        ...(dup.confidence > 0 ? { matchingFactId: dup.matchingFactId, matchingSimilarity: dup.confidence, isDuplicate: dup.isDuplicate } : {}),
      },
      [201],
    );
    reviewId = submitted.reviewId;
    const queue = await admin.json<{ reviews: Array<{ id: number; workflowStage: string; submittedById: string | null }> }>("2", "GET", "/api/admin/reviews?status=pending&limit=100");
    const listed = queue.reviews.find((r) => r.id === reviewId);
    if (!listed) throw new JourneyError("2", "the moderation queue", `review ${reviewId} is not listed`);
    if (listed.workflowStage !== "triage") throw new JourneyError("2", "the moderation queue", `review ${reviewId} is at ${listed.workflowStage}, expected triage`);
    Object.assign(ev, { reviewId, stage: listed.workflowStage, duplicateConfidence: dup.confidence, suggestedHashtags: hashtags });
  });

  // --- journey 3: moderation to an active fact ------------------------------
  let factId = 0;
  await run("3", ["2"], async (ev) => {
    await admin.json("3", "POST", `/api/admin/reviews/${reviewId}/provisional-approve`, { adminNote: "AI baseline" });
    // The Reading step: the reading's draft humor note, approved as written.
    const read = await poll(
      "3",
      "the reading (research, then a draft humor note)",
      () => admin.json<any>("3", "GET", `/api/admin/reviews/${reviewId}`),
      (r) => r.workflowStage === "reading" && r.reading?.latest?.status === "ok",
      (r) => (r.reading?.latest?.status === "failed" ? `reading failed: ${r.reading.latest.error}` : null),
      15 * 60_000,
    );
    await admin.json("3", "POST", `/api/admin/reviews/${reviewId}/approve-reading`, { text: read.reading.latest.draftNote, readingId: read.reading.latest.id });
    const prepared = await poll(
      "3",
      "Visual Ideas from the approved note",
      () => admin.json<any>("3", "GET", `/api/admin/reviews/${reviewId}`),
      (r) => r.workflowStage === "gags" && r.visualConcepts?.status === "ok",
      (r) => (r.visualConcepts?.status === "failed" ? "visual concepts failed" : null),
      15 * 60_000,
    );
    const stagingFactId: number = prepared.stagingFactId;
    const candidate = (prepared.visualConcepts.candidates as any[]).find(
      (c) => c.tokenValid && (c.bubbles ?? []).every((b: any) => b.tokenValid),
    );
    if (!candidate) throw new JourneyError("3", "pick a Visual Concept", "no token-valid candidate");
    // A gag may carry an invented line even for a fact with no dialogue: the
    // locked gag-writer prompt (docs/plans/gag-prompt-LOCKED.md, PR #936)
    // allows one that serves the gag, so the old "no bubble on a dialogue-free
    // fact" check (PR229 step 14) is retired. The candidate picked above is
    // token-valid, bubbles included, and its bubbles apply with it below.
    // The count stays in the journey's evidence.
    const withBubbles = (prepared.visualConcepts.candidates as any[]).filter((c) => (c.bubbles ?? []).length > 0).length;

    // Gag 1 is pre-filled from the first usable idea, its cast read by the
    // server (plan PLAN_FACT_LIFECYCLE_REBUILD.md, item 9; Issue #1018,
    // increment 1.3b): the journey waits for it instead of saving one.
    const filled = await poll(
      "3",
      "gag 1, filled from the first idea",
      () => admin.json<{ gags: Array<{ id: number; slot: number; pendingContent: { coreSceneOverride?: string } | null }> }>("3", "GET", `/api/admin/facts/${stagingFactId}/gags`),
      (v) => v.gags.some((g) => g.slot === 1),
      () => null,
      10 * 60_000,
    );
    const gag1 = filled.gags.find((g) => g.slot === 1)!;
    if (gag1.pendingContent?.coreSceneOverride !== candidate.sceneDescription) {
      throw new JourneyError("3", "gag 1 filled from the first idea", "gag 1's scene is not the first usable idea's");
    }
    const gagId = gag1.id;
    await admin.json("3", "POST", `/api/admin/reviews/${reviewId}/approve-visual-concept`, {});
    log("journey 3: the gag saved and the gags step approved");

    // A gag's working render per kind (plans PLAN_GAG_EXAMPLES.md and
    // PLAN_RENDER_HISTORY.md D1). Nothing draws by
    // itself (Issue #1282, plan PLAN_RENDERS_MANUAL.md): the moderator asks for
    // the male render first, then the rest, the same vendor calls in the same
    // order as when the male one started on arrival, so the recordings hold.
    const tiles = async () => {
      const view = await admin.json<{ gags: Array<{ id: number; roles: Record<"male" | "female" | "pet", { working: { status: string; message?: string | null; imageUrl?: string | null; latestAttemptId?: number | null } | null }> }> }>("3", "GET", `/api/admin/facts/${stagingFactId}/gags`);
      const g = view.gags.find((x) => x.id === gagId);
      if (!g) throw new JourneyError("3", "the gag's renders", `gag ${gagId} is not in the view`);
      return { male: g.roles.male.working, female: g.roles.female.working, pet: g.roles.pet.working };
    };
    await admin.json("3", "POST", `/api/admin/facts/${stagingFactId}/gags/${gagId}/renders`, { kinds: ["male"], reviewId });
    log("journey 3: the male render running");
    const male = await poll("3", "the male render", tiles, (r) => settledBaselineRenders(r, ["male"]) !== null, () => null, 20 * 60_000);
    if (options.expectRenderFailure) {
      const tile = settledBaselineRenders(male, ["male"])![0]!;
      ev.controlRenders = [{ key: "male", status: tile.status, message: tile.message ?? undefined }];
      throw new RenderFailureControl(tile.status === "failed", tile);
    }
    await admin.json("3", "POST", `/api/admin/facts/${stagingFactId}/gags/${gagId}/renders`, { kinds: ["female", "pet"], reviewId });
    log("journey 3: the female and pet renders running");
    const renders = await poll(
      "3",
      "the gag's male, female and pet renders",
      tiles,
      (r) => settledBaselineRenders(r) !== null,
      () => null,
      20 * 60_000,
    );
    const coverage = renderCoverageProblems(renders);
    if (coverage.length > 0) throw new JourneyError("3", "the baseline's renders", coverage.join(", "));
    const required = settledBaselineRenders(renders)!;
    const notDone = required.filter((c) => c.status !== "done");
    if (notDone.length > 0) {
      throw new JourneyError("3", "the gag's renders", notDone.map((c) => `${c.kind}=${c.status}${c.message ? ` (${c.message})` : ""}`).join(", "));
    }
    // The renders are stored and readable: each one's image decodes.
    const renderImages = [];
    for (const card of required as Array<{ kind: string; imageUrl?: string | null }>) {
      if (!card.imageUrl) throw new JourneyError("3", `the ${card.kind} render image`, "the done tile carries no image URL");
      const img = await readImage(admin, "3", `the ${card.kind} render image`, card.imageUrl);
      renderImages.push({ key: card.kind, format: img.format, width: img.width, height: img.height });
    }
    // Approving the male, female and pet renders makes them the gag's examples
    // and the gag approved; a fact goes live only with an approved gag.
    for (const card of required as Array<{ kind: string; latestAttemptId?: number | null }>) {
      if (card.latestAttemptId == null) throw new JourneyError("3", `approve the ${card.kind} example`, "the tile names no render");
      await admin.json("3", "POST", `/api/admin/facts/${stagingFactId}/gags/${gagId}/approve`, { attemptId: card.latestAttemptId, reviewId });
    }
    const approved = await admin.json<{ factId: number }>("3", "POST", `/api/admin/reviews/${reviewId}/approve-for-production`, {
      hashtags: hashtags.length > 0 ? hashtags : ["baseline"],
      adminNote: "AI baseline",
    });
    factId = approved.factId;
    const active = await free.json<any>("3", "GET", `/api/facts/${factId}`);
    if (active?.isActive === false) throw new JourneyError("3", "active fact", "the approved fact is not active");
    // Anyone browsing the facts list, newest first, finds it (PR293 step R5).
    const listed = await anonymous.json<{ facts: Array<{ id: number }> }>("3", "GET", "/api/facts?sort=newest&limit=50");
    if (!listed.facts.some((f) => f.id === factId)) throw new JourneyError("3", "the public facts list", `fact ${factId} is not among the ${listed.facts.length} newest`);
    Object.assign(ev, { reviewId, factId, renderImages, candidatesWithBubbles: withBubbles, listedInFacts: true });
  });
  const control = controlFrom(outcomes);
  if (options.expectRenderFailure) {
    return { ...result(), control: control ?? { ok: false, renders: [], detail: "journey 3 never reached its renders" } };
  }

  // --- journey 7: photo upload ----------------------------------------------
  let objectPath = "";
  await run("7", [], async (ev) => {
    const photo = fixture("photo.jpg");
    const upload = await free.request("POST", "/api/storage/upload-meme", photo, "image/jpeg");
    const uploadBody = (await upload.json()) as { objectPath?: string };
    if (upload.status !== 200 || !uploadBody.objectPath) throw new JourneyError("7", "upload", `${upload.status} ${JSON.stringify(uploadBody)}`);
    objectPath = uploadBody.objectPath;
    const own = await readImage(free, "7", "the owner reads the photo", `/api/storage${objectPath}`);
    if (!own.bytes.equals(photo)) throw new JourneyError("7", "the owner reads the photo", `${own.bytes.length} bytes differ from the ${photo.length} uploaded`);
    const otherStatus = (await paid.request("GET", `/api/storage${objectPath}`)).status;
    if (otherStatus !== 403) throw new JourneyError("7", "another user reads the photo", `expected 403, got ${otherStatus}`);
    // The same photo as a profile picture: uploaded through the avatar route and set (PR425 step 15).
    const avatar = await free.request("POST", "/api/storage/upload-avatar", photo, "image/jpeg");
    const avatarBody = (await avatar.json()) as { objectPath?: string };
    if (avatar.status !== 200 || !avatarBody.objectPath) throw new JourneyError("7", "upload a profile photo", `${avatar.status} ${JSON.stringify(avatarBody)}`);
    await free.json("7", "POST", "/api/users/me/profile-image", { objectPath: avatarBody.objectPath });
    const me = await free.json<{ profileImageUrl: string | null }>("7", "GET", "/api/users/me");
    if (me.profileImageUrl !== `/api/storage${avatarBody.objectPath}`) throw new JourneyError("7", "the profile photo is set", `profileImageUrl is ${me.profileImageUrl}`);
    const stored = await readImage(free, "7", "the profile photo is stored", me.profileImageUrl);
    if (!stored.bytes.equals(photo)) throw new JourneyError("7", "the profile photo is stored", `${stored.bytes.length} bytes differ from the ${photo.length} uploaded`);
    Object.assign(ev, { objectPath, ownerBytesEqual: true, otherUserStatus: otherStatus, avatarObjectPath: avatarBody.objectPath, avatarBytesEqual: true });
  });

  // --- journey 4: the free user's public photo meme --------------------------
  await run("4", ["3", "7"], async (ev) => {
    options.beforeJourney4?.(objectPath);
    const photoMeme = await free.json<{ permalinkSlug: string }>(
      "4",
      "POST",
      "/api/memes",
      { factId, imageSource: { type: "upload", uploadKey: objectPath }, isPublic: true, aspectRatio: "landscape" },
      [201],
    );
    const slug = photoMeme.permalinkSlug;
    const permalinkStatus = (await anonymous.request("GET", `/api/memes/${slug}`)).status;
    if (permalinkStatus !== 200) throw new JourneyError("4", "anyone reads the public meme's permalink", String(permalinkStatus));
    const meme = await readImage(anonymous, "4", "anyone reads the public meme image", `/api/memes/${slug}/image`, "landscape");

    // The unfurl page a crawler reads names this meme's own image, and that image serves (PR308 step R8).
    const og = await anonymous.request("GET", `/api/og/m/${slug}?noredirect=1`);
    const ogImage = /<meta property="og:image" content="([^"]+)"/.exec(await og.text())?.[1];
    if (og.status !== 200 || !ogImage) throw new JourneyError("4", "the unfurl page", `${og.status}, og:image ${ogImage ?? "absent"}`);
    const ogPath = new URL(ogImage, "http://unfurl.invalid").pathname;
    if (ogPath !== `/api/memes/${slug}/image`) throw new JourneyError("4", "the unfurl page's og:image", `names ${ogImage}, not this meme's image`);
    const unfurled = await readImage(anonymous, "4", "the unfurl page's og:image", ogPath, "landscape");

    // The served caption draws the creator's identity exactly as a hand-typed
    // twin of the same split does (PR398 steps 1, 3–8; PR223 step 1). The same
    // drawing is the proof: a surviving token, a brace, a shortened name or a
    // wrong conjugation could not render identically to the typed words. Each
    // saved meme carries its own invisible watermark (image tracing, #912), so
    // two saves are never byte-identical; "the same drawing" is no colour value
    // differing by more than SAME_DRAWING_TOLERANCE anywhere. Measured for #912:
    // two marks of one drawing differ by at most 18 of 255, while changing one
    // punctuation mark moves 4,106 pixels by more than 64.
    const me = await free.json<{ displayName: string | null }>("4", "GET", "/api/users/me");
    const name = me.displayName;
    if (!name) throw new JourneyError("4", "the creator's display name", "the free account has none");
    const served = async (what: string, topText: string, bottomText: string): Promise<Buffer> => {
      const res = await free.request("POST", "/api/memes", { factId, imageSource: { type: "upload", uploadKey: objectPath }, textOptions: { topText, bottomText }, isPublic: true, aspectRatio: "landscape" });
      const saved = (await res.json().catch(() => ({}))) as { permalinkSlug?: string };
      if (res.status !== 201 || !saved.permalinkSlug) throw new JourneyError("4", `save ${what}`, `${res.status} ${JSON.stringify(saved).slice(0, 300)}`);
      const img = await readImage(anonymous, "4", what, `/api/memes/${saved.permalinkSlug}/image`, "landscape");
      return sharp(img.bytes).removeAlpha().raw().toBuffer();
    };
    const twin = async (what: string, tokenised: [string, string], typed: [string, string], opts: { name?: boolean } = {}) => {
      const [a, b] = [await served(`${what}, tokenised`, ...tokenised), await served(`${what}, typed by hand`, ...typed)];
      if (!sameLettering(a, b)) throw new JourneyError("4", what, "the served image's lettering differs from its hand-typed twin");
      if (opts.name && !nameDrawnInBrandColour(a, b)) throw new JourneyError("4", what, "the name was not drawn in the brand colour");
      if (!opts.name && !sameDrawing(a, b)) throw new JourneyError("4", what, "the served image differs from its hand-typed twin");
      return a;
    };
    const setPronouns = (pronouns: string) => free.json("4", "PATCH", "/api/users/me", { pronouns });
    const captions: Record<string, Buffer> = {};
    captions.nameInTop = await twin("the name in the top half", ["{NAME} counted to infinity", "twice."], [`${name} counted to infinity`, "twice."], { name: true });
    captions.nameInBottom = await twin("the name in the bottom half", ["Infinity was counted", "by {NAME}, twice."], ["Infinity was counted", `by ${name}, twice.`], { name: true });
    // The bottom line's guard: a different typed bottom line must change the picture, or the bottom twin proves nothing.
    if (sameLettering(await served("a different bottom line, typed by hand", "Infinity was counted", "by Someone Else, twice."), captions.nameInBottom!)) {
      throw new JourneyError("4", "the bottom-line guard", "a different bottom line served the same image");
    }
    // The guard: a different typed name must not match, or equality proves nothing.
    if (sameLettering(await served("a different name, typed by hand", "Someone Else counted to infinity", "twice."), captions.nameInTop!)) {
      throw new JourneyError("4", "the caption guard", "a different name served the same image");
    }
    await setPronouns("they/them");
    captions.theyKeep = await twin("they/them agreement", ["{Subj} {keeps|keep} counting", "to infinity."], ["They keep counting", "to infinity."]);
    // Its own bottom line: the save route treats a repeated body as the same meme.
    await setPronouns("he/him");
    captions.heKeeps = await twin("he/him agreement", ["{Subj} {keeps|keep} counting", "to infinity, twice."], ["He keeps counting", "to infinity, twice."]);
    if (sameDrawing(await served("they/them wording, typed by hand", "They keep counting", "to infinity, twice."), captions.heKeeps!)) {
      throw new JourneyError("4", "the pronoun guard", "they/them wording served the he/him image");
    }

    Object.assign(ev, {
      memeSlug: slug,
      permalinkStatus,
      meme: { format: meme.format, width: meme.width, height: meme.height },
      unfurl: { ogImage, format: unfurled.format, width: unfurled.width, height: unfurled.height },
      creatorName: name,
      captionTwinsEqual: Object.keys(captions),
    });
  });

  return result();
}

/** Thrown inside journey 3 under `expectRenderFailure`, to stop the run at the control's one observation. */
class RenderFailureControl extends Error {
  constructor(ok: boolean, male: { status?: string; message?: string | null } | undefined) {
    super(ok ? `control: the recorded vendor error left the male render failed (${male?.message ?? "no message"})` : `control: the male render is ${male?.status}, expected failed`);
  }
}

function controlFrom(outcomes: Map<JourneyKey, JourneyOutcome>): DriveResult["control"] | undefined {
  const three = outcomes.get("3");
  if (!three?.error?.startsWith("control:")) return undefined;
  const ok = three.error.startsWith("control: the recorded vendor error left the male render failed");
  // A control never counts as a journey outcome.
  outcomes.set("3", { journey: "3", status: "not-run", evidence: {}, error: "the render-failure control stops the run here" });
  return { ok, renders: (three.evidence.controlRenders as NonNullable<DriveResult["control"]>["renders"]) ?? [], detail: three.error };
}
