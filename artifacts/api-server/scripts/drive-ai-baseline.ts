/**
 * The AI baseline driver (Launch Phase 2, increment 4, #631; design D6/D7).
 *
 * Walks the journeys the AI doubles must serve, over HTTP, making the calls
 * the frontend makes, as the seeded ordinary accounts and the bootstrap admin:
 *
 * - journey 3 — the free user submits a fact (tokenise, duplicate check,
 *   hashtags, submit); the admin takes it through triage, preparation, the
 *   saved Visual Concept and the required review renders to an active fact;
 * - journey 6 — the paid user generates an AI image for that fact and saves
 *   it as a private meme; the owner reads it, another user is refused;
 * - journey 7 — the free user uploads a photo; the owner reads it, another
 *   user is refused;
 * - journey 4 — the free user saves a public photo meme from it.
 *
 * The same driver runs against `AI_BACKEND=recorder` on the Repl, where its
 * requests become the recordings, and against `AI_BACKEND=recorded-double`
 * anywhere, where the replay proves those recordings carry the real
 * consumers through. Every input is fixed — the fact text, the account data,
 * the committed fixture images — so the second run's requests are the first
 * run's.
 *
 * Journey 6's "spend recorded against that user" is not asserted: the live
 * generation path records no spend (#651; David, 2026-10-12, "next").
 *
 *   pnpm exec tsx scripts/drive-ai-baseline.ts --base http://127.0.0.1:8090
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderCoverageProblems, settledBaselineRenders } from "../src/testing/aiBaselineCoverage";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The baseline fact, as a user types it (plain text; the tokeniser turns the
 * name and pronouns into tokens). Fixed: every recorded request downstream
 * derives from it.
 */
export const BASELINE_FACT =
  "Chuck Norris once counted to infinity. Twice. The second time he did it backwards to check his work.";

const accounts = JSON.parse(fs.readFileSync(path.join(HERE, "e2e-test-accounts.json"), "utf8")) as {
  password: string;
  free: { email: string };
  paid: { email: string };
};
const fixture = (name: string) => fs.readFileSync(path.join(HERE, "fixtures/ai-baseline", name));

export class JourneyError extends Error {
  constructor(journey: string, step: string, detail: string) {
    super(`[journey ${journey}] ${step}: ${detail}`);
    this.name = "JourneyError";
  }
}

/** A cookie jar per identity: Set-Cookie parsed by hand, so Secure cookies work over local http. */
class Session {
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
    let payload: BodyInit | undefined;
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

async function poll<T>(journey: string, what: string, read: () => Promise<T>, done: (v: T) => boolean, failed: (v: T) => string | null, timeoutMs: number): Promise<T> {
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

export interface BaselineEvidence {
  journey3: { reviewId: number; factId: number; suggestedHashtags: string[]; renderCards: Array<{ key: string; status: string }> };
  journey6: {
    renderJobId: string;
    generatedImageObjectPath: string;
    memeSlug: string;
    ownerImageBytes: number;
    otherUserPermalinkStatus: number;
    otherUserImageStatus: number;
  };
  journey7: { objectPath: string; ownerStatus: number; otherUserStatus: number };
  journey4: { memeSlug: string; anonymousStatus: number };
}

export interface DriveOptions {
  /**
   * Run with `AI_DOUBLE_FAIL=fal.subscribe:fal-ai/nano-banana-2`: journey 3's
   * text-to-image render must end failed — the recorded vendor error carried
   * through the real render job — and the run stops there.
   */
  expectRenderFailure?: boolean;
}

export async function driveBaseline(
  base: string,
  log: (line: string) => void = () => {},
  options: DriveOptions = {},
): Promise<BaselineEvidence | { renderFailure: Array<{ key: string; status: string; message?: string }> }> {
  const free = new Session(base, "free");
  const paid = new Session(base, "paid");
  const admin = new Session(base, "admin");

  // --- sign in -------------------------------------------------------------
  await free.json("3", "POST", "/api/auth/local-login", { email: accounts.free.email, password: accounts.password });
  await paid.json("6", "POST", "/api/auth/local-login", { email: accounts.paid.email, password: accounts.password });
  await admin.json("3", "POST", "/api/auth/dev-admin-login");
  await free.json("3", "POST", "/api/users/me/complete-onboarding", { captchaToken: "baseline" });
  log("signed in: free, paid, admin");

  // --- journey 3: submission ----------------------------------------------
  const { template } = await free.json<{ template: string }>("3", "POST", "/api/ai/tokenize-fact", { text: BASELINE_FACT });
  const dup = await free.json<{ isDuplicate: boolean; confidence: number; matchingFactId?: number }>("3", "POST", "/api/ai/check-duplicate", { text: template });
  const { hashtags } = await free.json<{ hashtags: string[] }>("3", "POST", "/api/ai/suggest-hashtags", { text: template });
  const submitted = await free.json<{ reviewId: number }>(
    "3",
    "POST",
    "/api/facts/submit-review",
    {
      text: template,
      hashtags,
      ...(dup.confidence > 0 ? { matchingFactId: dup.matchingFactId, matchingSimilarity: dup.confidence, isDuplicate: dup.isDuplicate } : {}),
    },
    [201],
  );
  const reviewId = submitted.reviewId;
  log(`journey 3: submitted review ${reviewId}`);

  // --- journey 3: moderation ----------------------------------------------
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
    if (t2i?.status !== "failed") throw new JourneyError("3", "recorded render failure", `generic_t2i is ${t2i?.status}, expected failed`);
    log(`journey 3: the recorded vendor error left generic_t2i failed (${t2i.message ?? "no message"})`);
    return { renderFailure: required.map((c) => ({ key: c.key, status: c.status, message: c.message })) };
  }
  const notDone = required.filter((c) => c.status !== "done" || c.stale);
  if (notDone.length > 0) {
    throw new JourneyError("3", "required review renders", notDone.map((c) => `${c.key}=${c.status}${c.message ? ` (${c.message})` : ""}`).join(", "));
  }
  const approved = await admin.json<{ factId: number }>("3", "POST", `/api/admin/reviews/${reviewId}/approve-for-production`, {
    hashtags: hashtags.length > 0 ? hashtags : ["baseline"],
    adminNote: "AI baseline",
  });
  const factId = approved.factId;
  const active = await free.json<any>("3", "GET", `/api/facts/${factId}`);
  if (active?.isActive === false) throw new JourneyError("3", "active fact", "the approved fact is not active");
  log(`journey 3: fact ${factId} active`);

  // --- journey 6: paid AI image meme ---------------------------------------
  const { renderJobId } = await paid.json<{ renderJobId: string }>("6", "POST", `/api/memes/ai/${factId}/generate`, { aspectRatio: "landscape" }, [202]);
  const render = await poll(
    "6",
    "AI image generation",
    () => paid.json<any>("6", "GET", `/api/memes/ai/renders/${renderJobId}`),
    (r) => r.status === "image_ready",
    (r) => (r.status === "failed" || r.status === "blocked" ? `${r.status}: ${r.errorCode ?? r.error ?? r.blockReason}` : null),
    10 * 60_000,
  );
  const generatedImageObjectPath: string = render.generatedImageObjectPath;
  const saved = await paid.json<{ permalinkSlug: string }>(
    "6",
    "POST",
    "/api/memes",
    {
      factId,
      imageSource: { type: "upload", uploadKey: generatedImageObjectPath },
      isPublic: false,
      aspectRatio: "landscape",
      previewImageBase64: fixture("preview.jpg").toString("base64"),
    },
    [201],
  );
  const memeSlug = saved.permalinkSlug;
  await paid.json("6", "GET", `/api/memes/${memeSlug}`);
  const ownerImage = await paid.request("GET", `/api/memes/${memeSlug}/image`);
  if (ownerImage.status !== 200) throw new JourneyError("6", "owner reads the private meme image", String(ownerImage.status));
  const ownerImageBytes = (await ownerImage.arrayBuffer()).byteLength;
  // The permalink and the image are separate routes; another user is refused both.
  const otherUserPermalinkStatus = (await free.request("GET", `/api/memes/${memeSlug}`)).status;
  if (otherUserPermalinkStatus !== 404) {
    throw new JourneyError("6", "another user reads the private meme's permalink", `expected 404, got ${otherUserPermalinkStatus}`);
  }
  const otherUserImageStatus = (await free.request("GET", `/api/memes/${memeSlug}/image`)).status;
  if (otherUserImageStatus !== 404) {
    throw new JourneyError("6", "another user reads the private meme's image", `expected 404, got ${otherUserImageStatus}`);
  }
  log(`journey 6: private meme ${memeSlug} saved, owner reads permalink and image, another user gets 404 on both`);

  // --- journey 7: photo upload ---------------------------------------------
  const upload = await free.request("POST", "/api/storage/upload-meme", fixture("photo.jpg"), "image/jpeg");
  const uploadBody = (await upload.json()) as { objectPath?: string };
  if (upload.status !== 200 || !uploadBody.objectPath) throw new JourneyError("7", "upload", `${upload.status} ${JSON.stringify(uploadBody)}`);
  const objectPath = uploadBody.objectPath;
  const ownerStatus = (await free.request("GET", `/api/storage${objectPath}`)).status;
  const otherStatus = (await paid.request("GET", `/api/storage${objectPath}`)).status;
  if (ownerStatus !== 200 || otherStatus !== 403) throw new JourneyError("7", "read-back", `owner ${ownerStatus}, other ${otherStatus}`);
  log(`journey 7: ${objectPath} readable by its owner only`);

  // --- journey 4: free public photo meme -----------------------------------
  const photoMeme = await free.json<{ permalinkSlug: string }>(
    "4",
    "POST",
    "/api/memes",
    {
      factId,
      imageSource: { type: "upload", uploadKey: objectPath },
      isPublic: true,
      aspectRatio: "landscape",
      previewImageBase64: fixture("preview.jpg").toString("base64"),
    },
    [201],
  );
  const anonymous = new Session(base, "anonymous");
  const anonymousStatus = (await anonymous.request("GET", `/api/memes/${photoMeme.permalinkSlug}/image`)).status;
  if (anonymousStatus !== 200) throw new JourneyError("4", "anonymous reads the public meme image", String(anonymousStatus));
  log(`journey 4: public meme ${photoMeme.permalinkSlug} readable by anyone`);

  return {
    journey3: { reviewId, factId, suggestedHashtags: hashtags, renderCards: required.map((c) => ({ key: c.key, status: c.status })) },
    journey6: { renderJobId, generatedImageObjectPath, memeSlug, ownerImageBytes, otherUserPermalinkStatus, otherUserImageStatus },
    journey7: { objectPath, ownerStatus, otherUserStatus: otherStatus },
    journey4: { memeSlug: photoMeme.permalinkSlug, anonymousStatus },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf("--base");
  const base = i > 0 ? process.argv[i + 1] : "http://127.0.0.1:8090";
  const evidence = await driveBaseline(base, (l) => console.log(`[baseline] ${l}`));
  console.log(JSON.stringify(evidence, null, 2));
}
