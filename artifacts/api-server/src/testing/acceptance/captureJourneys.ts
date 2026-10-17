/**
 * The real-render capture journeys (Launch Phase 2, increment 8, #631;
 * `docs/plans/PLAN_PHASE2_INC8_CAPTURE.md` D7), run by the inner program
 * (`./inner.ts`) under `scripts/acceptance-run.ts --mode capture`: on the
 * Repl only, the real AI clients under the recorder and its allowance, reuse
 * off, against a disposable marked test database with the legacy fixture.
 *
 * Each journey makes the calls the product's own frontend makes and writes
 * the image the UAT step is read from, full size and unaltered:
 *
 * - PR223 step 1 — the paid (legendary) test account uploads the reference
 *   photo fixture and generates through `POST /api/memes/pulid-jobs`, the
 *   path the meme builder wizard's AI styling takes for a reference photo
 *   (`Step2Image.handleAiCreate`), polls `GET /api/memes/pulid-jobs/:jobId`,
 *   and reads the result as its owner;
 * - PR229 step 6 — the dev admin takes a fact to concept review the way
 *   acceptance journey 3 does, saves a Visual Concept override whose one
 *   speech bubble is attributed to "the mailman" (a character not in the
 *   scene) through the fact enrichment PATCH, approves the concept (which
 *   starts the review render grid), waits for that grid to settle, then runs
 *   the moderation test render (`POST /admin/reviews/:id/render`) and reads
 *   its image.
 *
 * The journeys are independent: one failing never stops the other. The run's
 * verdict is only whether each shot was produced (and, for PR229, whether the
 * compiler reported the bubble's entity unresolved); the reading is Claude's.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BASELINE_FACT, JourneyError, poll, readImage, Session } from "./driver";
import { CAPTURE_DOCS, writeShot, type CaptureDoc, type ManifestLine } from "./captureShots";
import { settledBaselineRenders } from "../aiBaselineCoverage";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** The repository's publishable reference photo (plan D6, D7: a committed fixture, never a person's own photo). */
export const REFERENCE_PHOTO = path.join(API_ROOT, "src/assets/test-face.jpg");

export const MAILMAN_BUBBLE = { type: "speech" as const, entity: "the mailman", text: "Special delivery!" };

const accounts = JSON.parse(fs.readFileSync(path.join(API_ROOT, "scripts/e2e-test-accounts.json"), "utf8")) as {
  password: string;
  paid: { email: string };
};

export interface CaptureFact {
  id: number;
  text: string;
}

export interface CaptureResult {
  shots: ManifestLine[];
  /** Why the run is not green: a shot not produced, or a premise that did not hold. */
  problems: string[];
  /** What each journey observed, for the report. */
  evidence: Record<string, Record<string, unknown>>;
}

export async function driveCaptures(base: string, opts: { doc: CaptureDoc; out: string; commit: string; fact: CaptureFact | null; log: (line: string) => void }): Promise<CaptureResult> {
  const { out, commit, log } = opts;
  const result: CaptureResult = { shots: [], problems: [], evidence: { pr223: {}, pr229: {} } };
  log(`capturing ${opts.doc}`);
  const shot = (name: string, bytes: Buffer, format: string, meta: { doc: string; step: string; shows: string }) => {
    result.shots.push(writeShot(out, name, bytes, format, meta, commit));
    log(`captured ${name} (${bytes.length} bytes)`);
  };

  if (opts.doc === "PR223_RENDER_REPRODUCIBILITY_UAT") {
    // --- PR223 step 1: a reference-photo generation by the paid account --------
    const pr223 = result.evidence.pr223!;
    try {
      if (!opts.fact) throw new JourneyError("pr223", "pick a fact", "the fixture holds no active fact whose text has {NAME}");
      const fact = opts.fact;
      const paid = new Session(base, "paid");
      await paid.json("pr223", "POST", "/api/auth/local-login", { email: accounts.paid.email, password: accounts.password });
      const photo = fs.readFileSync(REFERENCE_PHOTO);
      // The meme builder uploads the reference photo here (`useUploadModeration`).
      const upload = await paid.request("POST", "/api/storage/upload-meme", photo, "image/jpeg");
      const uploaded = (await upload.json().catch(() => ({}))) as { objectPath?: string };
      if (upload.status !== 200 || !uploaded.objectPath) throw new JourneyError("pr223", "upload the reference photo", `${upload.status} ${JSON.stringify(uploaded).slice(0, 300)}`);
      const reference = await readImage(paid, "pr223", "the owner reads the reference photo", `/api/storage${uploaded.objectPath}`);
      if (!reference.bytes.equals(photo)) throw new JourneyError("pr223", "the owner reads the reference photo", `${reference.bytes.length} bytes differ from the ${photo.length} uploaded`);
      shot("pr223-s1-reference", photo, reference.format, {
        doc: "PR223_RENDER_REPRODUCIBILITY_UAT",
        step: "1",
        shows: `The reference photo the paid (legendary) test account uploaded for the generation: the repository's test-face.jpg fixture, ${reference.width}×${reference.height}, byte-identical to what the API serves back to its owner.`,
      });
      Object.assign(pr223, { factId: fact.id, factText: fact.text, referenceObjectPath: uploaded.objectPath });

      const { jobId } = await paid.json<{ jobId: string }>("pr223", "POST", "/api/memes/pulid-jobs", { factId: fact.id, referenceImagePath: uploaded.objectPath });
      pr223.jobId = jobId;
      log(`pr223: reference-photo generation ${jobId} started for fact ${fact.id}`);
      const job = await poll(
        "pr223",
        "the reference-photo generation",
        () => paid.json<{ phase: string; generatedObjectPath?: string; errorCode?: string; errorMessage?: string }>("pr223", "GET", `/api/memes/pulid-jobs/${jobId}`),
        (j) => j.phase === "completed" && !!j.generatedObjectPath,
        (j) => (j.phase === "failed" ? `failed: ${j.errorCode ?? "?"} ${j.errorMessage ?? ""}` : j.phase === "no_face_review" ? "parked in no_face_review: no face was detected in the reference photo" : null),
        10 * 60_000,
      );
      pr223.generatedObjectPath = job.generatedObjectPath;
      // The wizard shows the result through the storage route (`AiSourcePanel`).
      const generated = await readImage(paid, "pr223", "the owner reads the generated image", `/api/storage${job.generatedObjectPath}`);
      shot("pr223-s1-result", generated.bytes, generated.format, {
        doc: "PR223_RENDER_REPRODUCIBILITY_UAT",
        step: "1",
        shows: `The full-size image (${generated.width}×${generated.height}) the reference-photo generation (POST /api/memes/pulid-jobs, the meme builder's AI styling path) produced for fact ${fact.id} ("${fact.text}"), from the reference photo pr223-s1-reference, as the API serves it to its owner. Read only for what anyone would verify the same way; whether it shows the person in the reference photo is PR223 step 7's, David's.`,
      });
    } catch (err) {
      pr223.error = (err as Error).message;
      log(`pr223: FAILED — ${(err as Error).message}`);
    }
  }

  if (opts.doc === "PR229_BUBBLE_CONTROLS_UAT") {
    // --- PR229 step 6: a bubble attributed to a character not in the scene -----
    const pr229 = result.evidence.pr229!;
    try {
      const admin = new Session(base, "admin");
      await admin.json("pr229", "POST", "/api/auth/dev-admin-login");
      const { template } = await admin.json<{ template: string }>("pr229", "POST", "/api/ai/tokenize-fact", { text: BASELINE_FACT });
      const { reviewId } = await admin.json<{ reviewId: number }>("pr229", "POST", "/api/facts/submit-review", { text: template, hashtags: ["capture"] }, [201]);
      pr229.reviewId = reviewId;
      await admin.json("pr229", "POST", `/api/admin/reviews/${reviewId}/provisional-approve`, { adminNote: "UAT capture" });
      const prepared = await poll(
        "pr229",
        "preparation (enrichment, then Visual Ideas)",
        () => admin.json<any>("pr229", "GET", `/api/admin/reviews/${reviewId}`),
        (r) => r.workflowStage === "concept_review" && r.visualConcepts?.status === "ok",
        (r) => (r.workflowStage === "prep_failed" ? "prep_failed" : r.visualConcepts?.status === "failed" ? "visual concepts failed" : null),
        15 * 60_000,
      );
      const stagingFactId: number = prepared.stagingFactId;
      const candidate = (prepared.visualConcepts.candidates as any[]).find((c) => c.tokenValid);
      if (!candidate) throw new JourneyError("pr229", "pick a Visual Concept", "no token-valid candidate");

      const fact = await admin.json<any>("pr229", "GET", `/api/admin/facts/${stagingFactId}`);
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
        bubbles: [{ ...MAILMAN_BUBBLE }],
      };
      // Tokenise the saved prose, as the editor does before it saves.
      const tokenised = await admin.json<{ results: Array<{ path: string; value: string; error?: string }> }>("pr229", "POST", "/api/ai/tokenize-enrichment", {
        entries: [
          { path: "coreSceneOverride", value: vso.coreSceneOverride, kind: "prose" },
          { path: "bubbles[0].text", value: MAILMAN_BUBBLE.text, kind: "prose" },
          { path: "bubbles[0].entity", value: MAILMAN_BUBBLE.entity, kind: "entity" },
        ],
        subjectContext: { names: [] },
      });
      for (const r of tokenised.results) {
        if (r.error) throw new JourneyError("pr229", "tokenise the Visual Concept", `${r.path}: ${r.error}`);
        if (r.path === "coreSceneOverride") vso.coreSceneOverride = r.value;
        else if (r.path === "bubbles[0].text") vso.bubbles[0]!.text = r.value;
        else if (r.path === "bubbles[0].entity") vso.bubbles[0]!.entity = r.value;
      }
      enrichment.visualPromptStrategyOverride = vso;
      await admin.json("pr229", "PATCH", `/api/admin/facts/${stagingFactId}/enrichment`, { enrichment });
      Object.assign(pr229, { stagingFactId, savedBubble: vso.bubbles[0], roleBindings: vso.roleBindings ?? [] });
      log("pr229: the mailman bubble saved; approving the concept");

      await admin.json("pr229", "POST", `/api/admin/reviews/${reviewId}/approve-visual-concept`, {});
      // Approval starts the review render grid. Let it settle first, so its
      // reservations are released before the test render asks the allowance.
      try {
        const grid = await poll(
          "pr229",
          "the review render grid",
          () => admin.json<any>("pr229", "GET", `/api/admin/reviews/${reviewId}/render-scenarios`),
          (r) => settledBaselineRenders(r.cards as any[]) !== null,
          () => null,
          20 * 60_000,
        );
        pr229.grid = (grid.cards as any[]).map((c) => ({ key: c.key, status: c.status }));
      } catch (err) {
        pr229.gridNote = `did not settle: ${(err as Error).message.slice(0, 300)}; the test render runs anyway`;
      }

      const { renderJobId } = await admin.json<{ renderJobId: string }>("pr229", "POST", `/api/admin/reviews/${reviewId}/render`, { renderControls: { aspectRatio: "landscape" } }, [202]);
      pr229.renderJobId = renderJobId;
      log(`pr229: moderation test render ${renderJobId} running`);
      const render = await poll(
        "pr229",
        "the moderation test render",
        () => admin.json<any>("pr229", "GET", `/api/admin/reviews/${reviewId}/renders/${renderJobId}`),
        (r) => r.status === "image_ready",
        (r) => (r.status === "failed" || r.status === "blocked" ? `${r.status}: ${r.errorCode ?? r.error ?? r.blockReason}` : null),
        10 * 60_000,
      );
      const warnings = ((render.compiledPrompt?.diagnostics?.warnings ?? []) as Array<{ code: string; context?: { entity?: string } }>);
      const unresolved = warnings.some((w) => w.code === "bubble_entity_unresolved" && (w.context?.entity ?? "").toLowerCase() === MAILMAN_BUBBLE.entity);
      pr229.warnings = warnings.map((w) => w.code);
      // Recorded, never a red: the real planner may write the mailman into the
      // scene, and then the compiler rightly finds nothing unmatched. The
      // warning itself is the unit tests' to prove (PR229 step 6's Check).
      pr229.unresolvedReported = unresolved;

      const image = await readImage(admin, "pr229", "the test render's image", `/api/admin/reviews/${reviewId}/renders/${renderJobId}/image`);
      shot("pr229-s6-render", image.bytes, image.format, {
        doc: "PR229_BUBBLE_CONTROLS_UAT",
        step: "6",
        shows: `The full-size moderation test render (${image.width}×${image.height}, POST /api/admin/reviews/${reviewId}/render) of a Visual Concept whose one speech bubble reads "${vso.bubbles[0]!.text}" and is attributed to "${vso.bubbles[0]!.entity}", a character not in the scene. ${unresolved ? `The compiler reported bubble_entity_unresolved for it: the entity matched no subject or role binding (role bindings saved: ${(vso.roleBindings ?? []).length}).` : `The compiler did not report the entity unresolved (warnings: ${warnings.map((w) => w.code).join(", ") || "none"}): the planner may have written him into the scene.`} Read only for what anyone would verify the same way: the render completed and a balloon reads "${vso.bubbles[0]!.text}". Who speaks the line is not a criterion.`,
      });
    } catch (err) {
      pr229.error = (err as Error).message;
      log(`pr229: FAILED — ${(err as Error).message}`);
    }
  }

  const produced = new Set(result.shots.map((s) => s.shot));
  for (const name of CAPTURE_DOCS[opts.doc]) {
    if (!produced.has(name)) result.problems.push(`${name}: no image was produced`);
  }
  return result;
}
