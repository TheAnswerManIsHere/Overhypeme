/**
 * Phase 2 — pre-generate confirmation modal.
 *
 * Lifecycle:
 *   1. Open with `{ factId, uploadedObjectPath }`.
 *   2. POST /api/memes/ai/:factId/analyze-source → SourceImageAnalysis.
 *   3. Render the per-subjectKind warning + choice buttons.
 *   4. On user choice, POST /api/memes/ai/:factId/generate-v2 → renderJobId.
 *   5. Poll GET /api/memes/ai/renders/:renderJobId until image_ready / failed.
 *   6. Call onComplete(generatedImageObjectPath) or onCancel().
 *
 * The caller (AiBgPicker) opens this modal whenever the user generates from a
 * reference-photo upload; Generic (no-upload) generation still falls through
 * to the legacy /generate route.
 */

import { useEffect, useState, useRef, useCallback } from "react";
import { Loader2, AlertTriangle } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/Button";

// Subset of @workspace/api-zod types — duplicated narrowly so this component
// can compile without pulling the entire taxonomy package into the frontend.
type SourceSubjectKind =
  | "human_face"
  | "human_subject_no_usable_face"
  | "animal_subject"
  | "object_subject"
  | "vehicle_subject"
  | "mascot_or_character_subject"
  | "multiple_subjects"
  | "scene_no_clear_subject"
  | "ambiguous"
  | "detection_failed";

type SubjectRenderMode = "human_identity_i2i" | "nonhuman_subject_i2i" | "t2i_fallback";

interface SourceImageAnalysis {
  subjectKind: SourceSubjectKind;
  confidence: "high" | "medium" | "low";
  hasUsableHumanFace: boolean;
  hasUsableSubject: boolean;
  subjectCount: number;
  subjectDescription?: string;
  suggestedRenderMode: SubjectRenderMode;
  warnings: string[];
  classificationMethod: string;
}

interface ChoiceOption {
  kind: "proceed_human" | "proceed_nonhuman" | "proceed_t2i_fallback" | "upload_different";
  label: string;
  subjectRenderMode?: SubjectRenderMode;
}

interface SubjectMessage {
  title: string;
  body: string;
  options: ChoiceOption[];
  experimental?: boolean;
}

function messageFor(kind: SourceSubjectKind): SubjectMessage {
  switch (kind) {
    case "human_face":
      return {
        title: "Face detected",
        body: "We found a clear face. We'll use this photo as the identity source.",
        options: [
          { kind: "proceed_human", label: "Use this face", subjectRenderMode: "human_identity_i2i" },
          { kind: "upload_different", label: "Upload a different image" },
        ],
      };
    case "human_subject_no_usable_face":
      return {
        title: "Face not usable",
        body:
          "We can see a person in this photo but the face isn't usable for likeness preservation (back-facing, blurry, or occluded). We'll generate without face preservation — or upload a clearer headshot.",
        options: [
          { kind: "proceed_t2i_fallback", label: "Generate without face preservation", subjectRenderMode: "t2i_fallback" },
          { kind: "upload_different", label: "Upload a different image" },
        ],
      };
    case "animal_subject":
      return {
        title: "Animal detected",
        body:
          "This looks like an animal rather than a person. You can still use it as the star of the meme. Some facts may get surreal, but it can be funny.",
        options: [
          { kind: "proceed_nonhuman", label: "Use this animal as the protagonist", subjectRenderMode: "nonhuman_subject_i2i" },
          { kind: "proceed_t2i_fallback", label: "Generate a person instead", subjectRenderMode: "t2i_fallback" },
          { kind: "upload_different", label: "Upload a different image" },
        ],
      };
    case "object_subject":
    case "vehicle_subject":
    case "mascot_or_character_subject":
      return {
        title: "Object detected",
        body:
          "This looks like an object rather than a person. Experimental mode can use it as the protagonist, but some facts may not make visual sense.",
        experimental: true,
        options: [
          { kind: "proceed_nonhuman", label: "Use this object anyway", subjectRenderMode: "nonhuman_subject_i2i" },
          { kind: "proceed_t2i_fallback", label: "Generate a person instead", subjectRenderMode: "t2i_fallback" },
          { kind: "upload_different", label: "Upload a different image" },
        ],
      };
    case "multiple_subjects":
      return {
        title: "Multiple subjects",
        body: "We found multiple possible subjects. The result may not preserve the person or subject you intended.",
        options: [
          { kind: "proceed_nonhuman", label: "Use image anyway", subjectRenderMode: "nonhuman_subject_i2i" },
          { kind: "proceed_t2i_fallback", label: "Generate without this image", subjectRenderMode: "t2i_fallback" },
          { kind: "upload_different", label: "Upload a different image" },
        ],
      };
    case "scene_no_clear_subject":
      return {
        title: "No clear subject",
        body: "We couldn't find a clear subject in this image.",
        options: [
          { kind: "proceed_t2i_fallback", label: "Generate without this image", subjectRenderMode: "t2i_fallback" },
          { kind: "upload_different", label: "Upload a different image" },
        ],
      };
    default:
      return {
        title: "Subject unclear",
        body: "We couldn't confidently identify the main subject in this image. We can still try, or generate without it.",
        options: [
          { kind: "proceed_nonhuman", label: "Use image anyway", subjectRenderMode: "nonhuman_subject_i2i" },
          { kind: "proceed_t2i_fallback", label: "Generate without this image", subjectRenderMode: "t2i_fallback" },
          { kind: "upload_different", label: "Upload a different image" },
        ],
      };
  }
}

export interface SourceImageConfirmModalProps {
  open: boolean;
  factId: number;
  uploadedObjectPath: string | null;
  lookStyleId?: string | null;
  fallbackSubjectGender?: "male" | "female" | "neutral" | null;
  aspectRatio?: string;
  onComplete: (result: {
    generatedImageObjectPath: string;
    subjectRenderMode: SubjectRenderMode;
    renderJobId: string;
  }) => void;
  onCancel: () => void;
  onUploadDifferent: () => void;
}

type Phase = "analyzing" | "confirm" | "generating" | "polling" | "completed" | "failed";

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 60;

export function SourceImageConfirmModal({
  open,
  factId,
  uploadedObjectPath,
  lookStyleId,
  fallbackSubjectGender,
  aspectRatio = "portrait",
  onComplete,
  onCancel,
  onUploadDifferent,
}: SourceImageConfirmModalProps) {
  const [phase, setPhase] = useState<Phase>("analyzing");
  const [analysis, setAnalysis] = useState<SourceImageAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renderJobId, setRenderJobId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset state when the modal opens / the upload changes.
  useEffect(() => {
    if (!open || !uploadedObjectPath) return;
    setPhase("analyzing");
    setAnalysis(null);
    setError(null);
    setRenderJobId(null);
    fetch(`/api/memes/ai/${factId}/analyze-source`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ uploadedObjectPath }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({ error: "analyze_failed" })) as { error?: string };
          throw new Error(body.error ?? "analyze_failed");
        }
        return r.json() as Promise<{ analysis: SourceImageAnalysis }>;
      })
      .then((data) => {
        setAnalysis(data.analysis);
        setPhase("confirm");
      })
      .catch((err: Error) => {
        setError(err.message);
        setPhase("failed");
      });
  }, [open, uploadedObjectPath, factId]);

  // Cleanup poll interval on unmount / close.
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  const handleChoice = useCallback(
    async (choice: ChoiceOption) => {
      if (!analysis) return;
      if (choice.kind === "upload_different") {
        onUploadDifferent();
        return;
      }
      const subjectRenderMode = choice.subjectRenderMode ?? analysis.suggestedRenderMode;
      setPhase("generating");
      try {
        const res = await fetch(`/api/memes/ai/${factId}/generate-v2`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            sourceImageAnalysis: analysis,
            userSelectedSubjectRenderMode: subjectRenderMode,
            renderControls: {
              aspectRatio,
              contentMode: "sfw",
              ...(fallbackSubjectGender ? { fallbackSubjectGender } : {}),
            },
            lookStyleId: lookStyleId ?? null,
            uploadedObjectPath: uploadedObjectPath ?? null,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "generate_v2_failed" })) as { error?: string };
          throw new Error(body.error ?? "generate_v2_failed");
        }
        const data = (await res.json()) as { renderJobId: string; attemptId: number };
        setRenderJobId(data.renderJobId);
        setPhase("polling");
        let polls = 0;
        pollRef.current = setInterval(async () => {
          polls++;
          if (polls > MAX_POLLS) {
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
            setError("Generation timed out.");
            setPhase("failed");
            return;
          }
          try {
            const pollRes = await fetch(`/api/memes/ai/renders/${data.renderJobId}`, { credentials: "include" });
            if (!pollRes.ok) return;
            const status = (await pollRes.json()) as {
              status: "pending" | "prompt_ready" | "image_ready" | "failed";
              generatedImageObjectPath: string | null;
              error: string | null;
            };
            if (status.status === "image_ready" && status.generatedImageObjectPath) {
              if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = null;
              }
              setPhase("completed");
              onComplete({
                generatedImageObjectPath: status.generatedImageObjectPath,
                subjectRenderMode,
                renderJobId: data.renderJobId,
              });
            } else if (status.status === "failed") {
              if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = null;
              }
              setError(status.error ?? "Generation failed.");
              setPhase("failed");
            }
          } catch {
            // Network blip — keep polling.
          }
        }, POLL_INTERVAL_MS);
      } catch (err) {
        setError((err as Error).message);
        setPhase("failed");
      }
    },
    [analysis, factId, aspectRatio, fallbackSubjectGender, lookStyleId, uploadedObjectPath, onComplete, onUploadDifferent],
  );

  if (!open) {
    return <></>;
  }

  const message = analysis ? messageFor(analysis.subjectKind) : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md bg-background border-border max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-bold uppercase tracking-wider text-foreground">
            {phase === "analyzing"
              ? "Analyzing your image..."
              : phase === "confirm" && message
                ? message.title
                : phase === "generating" || phase === "polling"
                  ? "Generating..."
                  : phase === "failed"
                    ? "Something went wrong"
                    : "Done"}
          </DialogTitle>
        </DialogHeader>

        <div className="py-3 space-y-3">
          {phase === "analyzing" && (
            <div className="flex items-center gap-3 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Checking what's in your upload…</span>
            </div>
          )}

          {phase === "confirm" && analysis && message && (
            <>
              {message.experimental && (
                <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-yellow-500/20 text-yellow-700 border border-yellow-500/40">
                  <AlertTriangle className="h-3 w-3" /> experimental
                </div>
              )}
              <p className="text-sm text-foreground/90">{message.body}</p>
              {analysis.subjectDescription && (
                <p className="text-xs text-muted-foreground italic">
                  Detected: {analysis.subjectDescription} ({analysis.confidence} confidence)
                </p>
              )}
              {analysis.warnings.length > 0 && (
                <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
                  {analysis.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </>
          )}

          {(phase === "generating" || phase === "polling") && (
            <div className="flex items-center gap-3 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>
                {phase === "generating" ? "Writing the prompt…" : "Rendering the image…"}
              </span>
            </div>
          )}

          {phase === "failed" && (
            <div className="text-sm text-red-500">{error ?? "Unknown error."}</div>
          )}
        </div>

        <DialogFooter className="flex flex-col gap-2">
          {phase === "confirm" && analysis && message && (
            <>
              {message.options.map((opt) => (
                <Button
                  key={opt.kind + (opt.subjectRenderMode ?? "")}
                  onClick={() => void handleChoice(opt)}
                  variant={opt.kind === "upload_different" ? "secondary" : "primary"}
                  className="w-full"
                >
                  {opt.label}
                </Button>
              ))}
            </>
          )}
          {phase === "failed" && (
            <Button variant="secondary" onClick={onCancel} className="w-full">
              Close
            </Button>
          )}
          {(phase === "analyzing" || phase === "generating" || phase === "polling") && (
            <Button variant="secondary" onClick={onCancel} className="w-full">
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
