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
 *   Visual Concept and the required review renders to an active fact; each
 *   render's image decodes;
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

import { checkImage } from "./imageCheck";
import { renderCoverageProblems, settledBaselineRenders } from "../aiBaselineCoverage";

/** The committed account definitions and fixture images live beside the scripts that seed and record them. */
const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts");

/**
 * The baseline fact, as a user types it (plain text; the tokeniser turns the
 * name and pronouns into tokens). Fixed: every recorded request downstream
 * derives from it.
 */
export const BASELINE_FACT =
  "Chuck Norris once counted to infinity. Twice. The second time he did it backwards to check his work.";

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
   * Run with `AI_DOUBLE_FAIL=fal.subscribe:fal-ai/nano-banana-2`: journey 3's
   * text-to-image render must end failed — the recorded vendor error carried
   * through the real render job — and the run stops there. A control, never
   * an acceptance pass.
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
  } catch (err) {
    return { ...result(), setupError: (err as Error).message };
  }

  // --- journey 2: the free user submits a fact -----------------------------
  let reviewId = 0;
  let hashtags: string[] = [];
  await run("2", [], async (ev) => {
    await free.json("2", "POST", "/api/users/me/complete-onboarding", { captchaToken: "baseline" });
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
    if (listed.workflowStage !== "triage_pending") throw new JourneyError("2", "the moderation queue", `review ${reviewId} is at ${listed.workflowStage}, expected triage_pending`);
    Object.assign(ev, { reviewId, stage: listed.workflowStage, duplicateConfidence: dup.confidence, suggestedHashtags: hashtags });
  });

  // --- journey 3: moderation to an active fact ------------------------------
  let factId = 0;
  await run("3", ["2"], async (ev) => {
    await admin.json("3", "POST", `/api/admin/reviews/${reviewId}/provisional-approve`, { adminNote: "AI baseline" });
    const prepared = await poll(
      "3",
      "preparation (enrichment, then Visual Ideas)",
      () => admin.json<any>("3", "GET", `/api/admin/reviews/${reviewId}`),
      (r) => r.workflowStage === "concept_review" && r.visualConcepts?.status === "ok",
      (r) => (r.workflowStage === "prep_failed" ? "prep_failed" : r.visualConcepts?.status === "failed" ? "visual concepts failed" : null),
      15 * 60_000,
    );
    const stagingFactId: number = prepared.stagingFactId;
    const candidate = (prepared.visualConcepts.candidates as any[]).find(
      (c) => c.tokenValid && (c.bubbles ?? []).every((b: any) => b.tokenValid),
    );
    if (!candidate) throw new JourneyError("3", "pick a Visual Concept", "no token-valid candidate");
    // The baseline fact has no dialogue, so no proposed idea carries a speech or thought bubble (PR229 step 14).
    const withBubbles = (prepared.visualConcepts.candidates as any[]).filter((c) => (c.bubbles ?? []).length > 0).length;
    if (withBubbles > 0) throw new JourneyError("3", "Visual Ideas for a dialogue-free fact", `${withBubbles} candidate(s) propose a bubble`);

    const fact = await admin.json<any>("3", "GET", `/api/admin/facts/${stagingFactId}`);
    const enrichment = structuredClone(fact.enrichment);
    const vso = {
      ...(enrichment.visualPromptStrategyOverride ?? {
        version: 1,
        requiredVisualDetails: [],
        forbiddenVisualDetails: [],
        roleBindings: [],
        bubbles: [],
        compositionGuidance: [],
        styleAgnosticPromptAdditions: [],
        negativePromptAdditions: [],
      }),
      coreSceneOverride: candidate.sceneDescription,
      bubbles: (candidate.bubbles ?? []).map(({ type, entity, text }: any) => ({ type, entity, text })),
    };
    // Tokenise the saved prose, as the editor does before it saves.
    const entries = [
      { path: "coreSceneOverride", value: vso.coreSceneOverride, kind: "prose" },
      ...vso.bubbles.flatMap((b: any, i: number) => [
        { path: `bubbles[${i}].text`, value: b.text, kind: "prose" },
        ...(b.entity ? [{ path: `bubbles[${i}].entity`, value: b.entity, kind: "entity" }] : []),
      ]),
    ];
    const tokenised = await admin.json<{ results: Array<{ path: string; value: string; error?: string }> }>(
      "3",
      "POST",
      "/api/ai/tokenize-enrichment",
      { entries, subjectContext: { names: [] } },
    );
    for (const r of tokenised.results) {
      if (r.error) throw new JourneyError("3", "tokenise the Visual Concept", `${r.path}: ${r.error}`);
      const m = /^bubbles\[(\d+)\]\.(text|entity)$/.exec(r.path);
      if (r.path === "coreSceneOverride") vso.coreSceneOverride = r.value;
      else if (m) vso.bubbles[Number(m[1])][m[2]] = r.value;
    }
    enrichment.visualPromptStrategyOverride = vso;
    await admin.json("3", "PATCH", `/api/admin/facts/${stagingFactId}/enrichment`, { enrichment });
    await admin.json("3", "POST", `/api/admin/reviews/${reviewId}/approve-visual-concept`, {});
    log("journey 3: Visual Concept saved and approved; review renders running");

    const renders = await poll(
      "3",
      "required review renders",
      () => admin.json<any>("3", "GET", `/api/admin/reviews/${reviewId}/render-scenarios`),
      (r) => settledBaselineRenders(r.cards as any[]) !== null,
      // A grid that has cards but lacks an expected scenario will not grow one; an empty grid may still be building.
      (r) => ((r.cards as any[]).length > 0 ? renderCoverageProblems(r.cards as any[]).join(", ") || null : null),
      20 * 60_000,
    );
    const coverage = renderCoverageProblems(renders.cards as any[]);
    if (coverage.length > 0) throw new JourneyError("3", "the baseline's review renders", coverage.join(", "));
    const required = settledBaselineRenders(renders.cards as any[])!;
    if (options.expectRenderFailure) {
      const t2i = required.find((c) => c.key === "generic_t2i");
      ev.controlRenders = required.map((c) => ({ key: c.key, status: c.status, message: c.message ?? undefined }));
      throw new RenderFailureControl(t2i?.status === "failed", t2i);
    }
    const notDone = required.filter((c) => c.status !== "done" || c.stale);
    if (notDone.length > 0) {
      throw new JourneyError("3", "required review renders", notDone.map((c) => `${c.key}=${c.status}${c.message ? ` (${c.message})` : ""}`).join(", "));
    }
    // The renders are stored and readable: each one's image decodes (read before approval, while the review owns them).
    const renderImages = [];
    for (const card of required as Array<{ key: string; imageUrl?: string | null }>) {
      if (!card.imageUrl) throw new JourneyError("3", `the ${card.key} render image`, "the done card carries no image URL");
      const img = await readImage(admin, "3", `the ${card.key} render image`, card.imageUrl);
      renderImages.push({ key: card.key, format: img.format, width: img.width, height: img.height });
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
    // twin of the same split does (PR398 steps 1, 3–8; PR223 step 1). Equal
    // bytes are the proof: a surviving token, a brace, a shortened name or a
    // wrong conjugation could not render identically to the typed words.
    const me = await free.json<{ displayName: string | null }>("4", "GET", "/api/users/me");
    const name = me.displayName;
    if (!name) throw new JourneyError("4", "the creator's display name", "the free account has none");
    const served = async (what: string, topText: string, bottomText: string) => {
      const res = await free.request("POST", "/api/memes", { factId, imageSource: { type: "upload", uploadKey: objectPath }, textOptions: { topText, bottomText }, isPublic: true, aspectRatio: "landscape" });
      const saved = (await res.json().catch(() => ({}))) as { permalinkSlug?: string };
      if (res.status !== 201 || !saved.permalinkSlug) throw new JourneyError("4", `save ${what}`, `${res.status} ${JSON.stringify(saved).slice(0, 300)}`);
      const img = await readImage(anonymous, "4", what, `/api/memes/${saved.permalinkSlug}/image`, "landscape");
      return createHash("sha256").update(img.bytes).digest("hex");
    };
    const twin = async (what: string, tokenised: [string, string], typed: [string, string]) => {
      const [a, b] = [await served(`${what}, tokenised`, ...tokenised), await served(`${what}, typed by hand`, ...typed)];
      if (a !== b) throw new JourneyError("4", what, "the served image differs from its hand-typed twin");
      return a;
    };
    const setPronouns = (pronouns: string) => free.json("4", "PATCH", "/api/users/me", { pronouns });
    const captions: Record<string, string> = {};
    captions.nameInTop = await twin("the name in the top half", ["{NAME} counted to infinity", "twice."], [`${name} counted to infinity`, "twice."]);
    captions.nameInBottom = await twin("the name in the bottom half", ["Infinity was counted", "by {NAME}, twice."], ["Infinity was counted", `by ${name}, twice.`]);
    // The guard: a different typed name must not match, or equality proves nothing.
    if ((await served("a different name, typed by hand", "Someone Else counted to infinity", "twice.")) === captions.nameInTop) {
      throw new JourneyError("4", "the caption guard", "a different name served the same image");
    }
    await setPronouns("they/them");
    captions.theyKeep = await twin("they/them agreement", ["{Subj} {keeps|keep} counting", "to infinity."], ["They keep counting", "to infinity."]);
    // Its own bottom line: the save route treats a repeated body as the same meme.
    await setPronouns("he/him");
    captions.heKeeps = await twin("he/him agreement", ["{Subj} {keeps|keep} counting", "to infinity, twice."], ["He keeps counting", "to infinity, twice."]);
    if ((await served("they/them wording, typed by hand", "They keep counting", "to infinity, twice.")) === captions.heKeeps) {
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
  constructor(ok: boolean, t2i: { status?: string; message?: string } | undefined) {
    super(ok ? `control: the recorded vendor error left generic_t2i failed (${t2i?.message ?? "no message"})` : `control: generic_t2i is ${t2i?.status}, expected failed`);
  }
}

function controlFrom(outcomes: Map<JourneyKey, JourneyOutcome>): DriveResult["control"] | undefined {
  const three = outcomes.get("3");
  if (!three?.error?.startsWith("control:")) return undefined;
  const ok = three.error.startsWith("control: the recorded vendor error left generic_t2i failed");
  // A control never counts as a journey outcome.
  outcomes.set("3", { journey: "3", status: "not-run", evidence: {}, error: "the render-failure control stops the run here" });
  return { ok, renders: (three.evidence.controlRenders as NonNullable<DriveResult["control"]>["renders"]) ?? [], detail: three.error };
}
