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
 * - PR229 step 6 — the dev admin takes a fact to concept review the way
 *   acceptance journey 3 does, saves a Visual Concept override whose one
 *   speech bubble is attributed to "the mailman" (a character not in the
 *   scene) through the fact enrichment PATCH, approves the concept (which
 *   starts the review render grid), waits for that grid to settle, then runs
 *   the moderation test render (`POST /admin/reviews/:id/render`) and reads
 *   its image.
 *
 * The PR223 reference-photo journey went with PuLID (launch Phase 4, removal 3;
 * `docs/retired/README.md`). The run's verdict is only whether each shot was
 * produced and whether the compiler reported the bubble's entity unresolved;
 * the reading is Claude's.
 */
import { BASELINE_FACT, JourneyError, poll, readImage, Session } from "./driver";
import { CAPTURE_DOCS, writeShot, type CaptureDoc, type ManifestLine } from "./captureShots";
import { settledBaselineRenders } from "../aiBaselineCoverage";

export const MAILMAN_BUBBLE = { type: "speech" as const, entity: "the mailman", text: "Special delivery!" };
/**
 * A moderator role binding for the subject alone. Moderator role bindings take
 * precedence over the planner's characters, so with this one saved the scene
 * has no secondary character at all and the mailman matches nothing, on every
 * run, whatever the planner wrote.
 */
export const SUBJECT_ONLY_ROLE = { entity: "subject", visualRole: "the person the fact is about" };

export interface CaptureResult {
  shots: ManifestLine[];
  /** Why the run is not green: a shot not produced, or a premise that did not hold. */
  problems: string[];
  /** What each journey observed, for the report. */
  evidence: Record<string, Record<string, unknown>>;
}

export async function driveCaptures(base: string, opts: { doc: CaptureDoc; out: string; commit: string; log: (line: string) => void }): Promise<CaptureResult> {
  const { out, commit, log } = opts;
  const result: CaptureResult = { shots: [], problems: [], evidence: { pr229: {} } };
  log(`capturing ${opts.doc}`);
  const shot = (name: string, bytes: Buffer, format: string, meta: { doc: string; step: string; shows: string }) => {
    result.shots.push(writeShot(out, name, bytes, format, meta, commit));
    log(`captured ${name} (${bytes.length} bytes)`);
  };

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
        roleBindings: [{ ...SUBJECT_ONLY_ROLE }],
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
      pr229.unresolvedReported = unresolved;
      // The subject-only role binding leaves the mailman nothing to match, so a
      // missing warning means the run did not exercise step 6's premise.
      if (!unresolved) result.problems.push(`pr229-s6-render: the compiler did not report "${MAILMAN_BUBBLE.entity}" unresolved despite the subject-only role binding (warnings: ${warnings.map((w) => w.code).join(", ") || "none"})`);

      const image = await readImage(admin, "pr229", "the test render's image", `/api/admin/reviews/${reviewId}/renders/${renderJobId}/image`);
      shot("pr229-s6-render", image.bytes, image.format, {
        doc: "PR229_BUBBLE_CONTROLS_UAT",
        step: "6",
        shows: `The full-size moderation test render (${image.width}×${image.height}, POST /api/admin/reviews/${reviewId}/render) of a Visual Concept whose one speech bubble reads "${vso.bubbles[0]!.text}" and is attributed to "${vso.bubbles[0]!.entity}", a character not in the scene: the one role binding saved is the subject's. ${unresolved ? "The compiler reported bubble_entity_unresolved for it." : `The compiler did not report the entity unresolved (warnings: ${warnings.map((w) => w.code).join(", ") || "none"}), so this run did not exercise the premise.`} Read only for what anyone would verify the same way: the render completed and a balloon reads "${vso.bubbles[0]!.text}". Who speaks the line is not a criterion.`,
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
