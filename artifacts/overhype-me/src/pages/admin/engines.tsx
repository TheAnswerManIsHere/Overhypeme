import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import {
  Boxes,
  Star,
  Eye,
  EyeOff,
  Trash2,
  Undo2,
  Save,
  ChevronDown,
  ChevronUp,
  Beaker,
  Loader2,
} from "lucide-react";
import { OPENAI_CHAT_MODEL_OPTIONS, REASONING_EFFORT_OPTIONS } from "./_configShared";

interface EngineRow {
  id: string;
  provider: string;
  endpointId: string;
  label: string;
  description: string;
  kind: "image" | "video" | "utility" | string;
  tierRequirement: string;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
  allowedDurationsSec: number[] | null;
  defaultDurationSec: number | null;
  allowedResolutions: string[] | null;
  defaultResolution: string | null;
  allowedAspectRatios: string[] | null;
  defaultAspectRatio: string | null;
  supportedModes: string[] | null;
  defaultMode: string | null;
  audioHandling: string;
  paramSchema: unknown;
  estimatedCostUsdPerCall: string | number | null;
  estimatedCostUsdPerSecond: string | number | null;
  expectedRunMs: number;
  featureFlagRequired: string | null;
  defaultTemperature: string | number | null;
  defaultMaxTokens: number | null;
  defaultReasoningEffort: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface ListResponse {
  engines: EngineRow[];
  editableFields: string[];
}

// Fields the backend's PATCH endpoint accepts. Kept in sync with
// ADMIN_EDITABLE_FIELDS in artifacts/api-server/src/routes/adminEngines.ts.
const EDITABLE_FIELDS = [
  "isActive",
  "isDefault",
  "sortOrder",
  "tierRequirement",
  "featureFlagRequired",
  "defaultDurationSec",
  "defaultResolution",
  "defaultAspectRatio",
  "defaultMode",
  "expectedRunMs",
  "estimatedCostUsdPerCall",
  "estimatedCostUsdPerSecond",
  "endpointId",
  "defaultTemperature",
  "defaultMaxTokens",
  "defaultReasoningEffort",
] as const;

// Section labels. Image engines are split into their two benches
// (text-to-image vs image-to-image) so each gets its own section.
const KIND_LABELS: Record<string, string> = {
  video: "Video engines",
  "text-to-image": "Text-to-image engines",
  "image-to-image": "Image-to-image engines",
  image: "Image engines",
  utility: "Utility engines",
};

function msToHuman(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

function fmtCost(v: string | number | null): string {
  if (v === null || v === undefined) return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return String(v);
  return `$${n.toFixed(4)}`;
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function ReadOnlyField({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div>
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-xs font-mono text-foreground break-all">{value === null || value === "" ? "—" : String(value)}</p>
    </div>
  );
}

// ─── Test workbench ──────────────────────────────────────────────────────────
//
// Built as a tuning sandbox, not just a "did fal accept this" smoke check.
// Admins can edit every meaningful param (prompt, dialogue, duration, aspect,
// resolution, mode, engine-specific knobs) and re-run until the output matches
// the desired behavior. Once the right settings are found, they can be locked
// into the engine's row defaults via the EngineEditor below.

// Default prompts used when no override is supplied. Kept in sync with the
// server's TEST_MOTION_PROMPT / TEST_DIALOGUE_TEXT — these are the fallbacks
// the admin starts from when opening the panel for a fresh engine.
const DEFAULT_TEST_MOTION_PROMPT =
  "Subject slowly turns their head 45 degrees to the left over 2 seconds, " +
  "then returns to center while making eye contact with the camera. " +
  "Slow dolly push-in throughout. Soft window light from the left.";

const DEFAULT_TEST_DIALOGUE_FULL =
  "This is a synthetic engine test. The quick brown fox jumps over the lazy dog.";

// Short dialogue used by Experiment B (padding detector). About half the
// length of the full phrase so audio engines that invent extra dialogue
// to fill clip silence (Grok quirk) reveal themselves.
const DEFAULT_TEST_DIALOGUE_SHORT = "This is a synthetic engine test.";

// Default transform/scene prompt for the image benches. Image-to-image should
// transform the supplied face; text-to-image renders the scene from scratch.
const DEFAULT_TEST_IMAGE_PROMPT =
  "A cinematic portrait of the subject as a 1920s film noir detective in a " +
  "rain-soaked alley, dramatic chiaroscuro lighting, volumetric fog.";

/**
 * Renders a fact template down to the hardcoded workbench test identity
 * (David Franklin, he/him) for display — mirrors the server's
 * `renderPersonalized` so the picker shows readable text instead of raw
 * {NAME}/{SUBJ} tokens. Display-only; the server re-renders authoritatively
 * when assembling the actual prompt.
 */
const FACT_TOKEN_MAP: Record<string, string> = {
  NAME: "David Franklin",
  SUBJ: "he", Subj: "He", OBJ: "him", Obj: "Him",
  POSS: "his", Poss: "His", POSS_PRO: "his", Poss_Pro: "His",
  REFL: "himself", Refl: "Himself",
};
function renderFactText(template: string): string {
  return template.replace(/\{([^{}]+)\}/g, (m, inner: string) => {
    if (inner in FACT_TOKEN_MAP) return FACT_TOKEN_MAP[inner]!;
    if (inner.includes("|")) return inner.split("|")[0] ?? m; // singular form (he/him)
    return m;
  });
}

/**
 * Which bench a given engine drives. Mirrors the server's `engineBenchType`
 * (adminEngines.ts): video/utility map from kind; image engines split on
 * whether the schema declares a source image (referenceImageUrl/imageUrl).
 */
type BenchType = "text-to-image" | "image-to-image" | "video" | "utility";
function engineBenchType(engine: {
  kind: string;
  paramSchema?: unknown;
}): BenchType {
  if (engine.kind === "video") return "video";
  if (engine.kind === "utility") return "utility";
  const params =
    (engine.paramSchema as { params?: Array<{ from?: string }> } | null | undefined)?.params ?? [];
  const needsSourceImage = params.some(
    (p) => p.from === "referenceImageUrl" || p.from === "imageUrl",
  );
  return needsSourceImage ? "image-to-image" : "text-to-image";
}

// Universal pipeline keys handled by named form fields below. Anything in the
// engine's paramSchema with a `from` key NOT in this set gets surfaced as an
// engine-specific input.
const UNIVERSAL_FROM_KEYS = new Set([
  "imageUrl",
  "referenceImageUrl",
  "videoUrl",
  "motionPrompt",
  "imagePrompt",
  "durationSec",
  "aspectRatio",
  "resolution",
  "mode",
  "generateAudio",
  "endUserId",
  "dialogueText",
]);

interface ParamSchemaEntryLike {
  name?: string;
  from?: string;
  type?: string;
  default?: unknown;
  enum?: unknown[];
  range?: { min?: number; max?: number };
}

type ExperimentMode = "A" | "B" | "C" | "custom";

function EngineTestPanel({ engine }: { engine: EngineRow }) {
  const benchType = useMemo(() => engineBenchType(engine), [engine]);
  const isVideoBench = benchType === "video";
  const isImagePromptBench = benchType === "text-to-image" || benchType === "image-to-image";
  const needsSourceAsset = benchType !== "text-to-image";
  const sampleIsVideo = benchType === "utility";

  // ── Form state ────────────────────────────────────────────────────────────
  const [experiment, setExperiment] = useState<ExperimentMode>("A");
  const [sampleUrl, setSampleUrl] = useState("");
  const [imagePrompt, setImagePrompt] = useState(DEFAULT_TEST_IMAGE_PROMPT);
  const [motionPrompt, setMotionPrompt] = useState(DEFAULT_TEST_MOTION_PROMPT);
  const [dialogueEnabled, setDialogueEnabled] = useState(engine.audioHandling !== "none");
  const [dialogueText, setDialogueText] = useState(DEFAULT_TEST_DIALOGUE_FULL);
  const [durationSec, setDurationSec] = useState<string>(
    engine.defaultDurationSec !== null ? String(engine.defaultDurationSec) : "",
  );
  const [aspectRatio, setAspectRatio] = useState<string>(engine.defaultAspectRatio ?? "");
  const [resolution, setResolution] = useState<string>(engine.defaultResolution ?? "");
  const [mode, setMode] = useState<string>(engine.defaultMode ?? "");
  const [generateAudio, setGenerateAudio] = useState(engine.audioHandling !== "none");

  // Engine-specific params discovered from paramSchema.
  const engineParams = useMemo(() => {
    const schema = engine.paramSchema as { params?: ParamSchemaEntryLike[] } | null;
    const params = schema?.params ?? [];
    return params.filter(
      (p) => typeof p.from === "string" && !UNIVERSAL_FROM_KEYS.has(p.from),
    );
  }, [engine.paramSchema]);

  // Map of from-key → current value (string for inputs; coerced at send time).
  const [extraParams, setExtraParams] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of engineParams) {
      if (p.from && p.default !== undefined && p.default !== null) {
        init[p.from] = String(p.default);
      }
    }
    return init;
  });

  // ── Production test inputs (fact / gender / look style / motion preset) ──
  // The workbench tests against real meme-generator prompts: pick a fact and
  // (for image) a gender + look style, or (for video) a motion preset, and the
  // server assembles the exact production prompt into the editable boxes below.
  const [factQuery, setFactQuery] = useState("");
  const [factResults, setFactResults] = useState<{ id: number; text: string }[]>([]);
  const [selectedFact, setSelectedFact] = useState<{ id: number; text: string } | null>(null);
  const [gender, setGender] = useState<"male" | "female" | "neutral">("neutral");
  const [lookStyles, setLookStyles] = useState<{ id: string; label: string }[]>([]);
  const [lookStyleId, setLookStyleId] = useState("");
  const [motionPresets, setMotionPresets] = useState<{ id: string; label: string }[]>([]);
  const [motionPresetId, setMotionPresetId] = useState("");
  const [assembling, setAssembling] = useState(false);
  const [assembleError, setAssembleError] = useState<string | null>(null);
  // Video benches have no server-side cache for the generated AI Video Motion
  // Prompt (production regenerates per render). Hold the last generated value
  // here, keyed by fact + source image, so swapping the motion preset reuses it
  // instead of re-rolling — only a new image/fact or the explicit "Regenerate"
  // link forces a fresh one (the motion prompt depends on the image).
  const videoStyleRef = useRef<{ key: string; value: string } | null>(null);

  // Fetch the look-style + motion-preset catalogues once (only what the bench needs).
  useEffect(() => {
    if (isImagePromptBench) {
      fetch("/api/look-styles", { credentials: "include" })
        .then((r) => (r.ok ? r.json() : []))
        .then((rows) => setLookStyles(Array.isArray(rows) ? rows : []))
        .catch(() => setLookStyles([]));
    }
    if (isVideoBench) {
      fetch("/api/motion-presets", { credentials: "include" })
        .then((r) => (r.ok ? r.json() : []))
        .then((rows) => setMotionPresets(Array.isArray(rows) ? rows : []))
        .catch(() => setMotionPresets([]));
    }
  }, [isImagePromptBench, isVideoBench]);

  // Debounced fact search.
  useEffect(() => {
    const q = factQuery.trim();
    if (q.length < 2) { setFactResults([]); return; }
    const t = setTimeout(() => {
      // templatedOnly=true → real templated facts only (user- or Replit-generated);
      // excludes hand-typed test stubs like "Alex pushes the limit".
      fetch(`/api/facts?search=${encodeURIComponent(q)}&limit=15&templatedOnly=true`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : { facts: [] }))
        .then((data) => setFactResults(Array.isArray(data?.facts) ? data.facts : []))
        .catch(() => setFactResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [factQuery]);

  // Assemble the production prompt from the current selection and fill the
  // editable prompt boxes. `forceRegenerate` re-runs scene-prompt generation
  // server-side (overwriting a stale/misclassified cache) — used by the
  // "Regenerate scene prompts" button.
  const runAssemble = useCallback(async (forceRegenerate: boolean) => {
    if (!selectedFact || benchType === "utility") return;
    setAssembling(true);
    setAssembleError(null);
    // Reuse the cached video motion prompt unless a regenerate was asked for.
    // The motion prompt depends on the fact AND the source image, so a change to
    // either invalidates the cache; the motion preset does not.
    const videoCacheKey = `${selectedFact.id}|${sampleUrl.trim()}`;
    const cachedVideoStyle =
      !forceRegenerate && videoStyleRef.current?.key === videoCacheKey
        ? videoStyleRef.current.value
        : undefined;
    try {
      const r = await fetch(`/api/admin/engines/${engine.id}/assemble-prompt`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          factId: selectedFact.id,
          gender,
          lookStyleId: lookStyleId || undefined,
          motionPresetId: motionPresetId || undefined,
          // i2i analyzes + renders against the sample image, so send it for
          // image-to-image too (not just video). t2i sends none.
          sampleImageUrl: (isVideoBench || benchType === "image-to-image") ? (sampleUrl.trim() || undefined) : undefined,
          // The new prompt engine renders in the bench's chosen aspect ratio.
          aspectRatio: isImagePromptBench ? (aspectRatio || undefined) : undefined,
          videoDirection: cachedVideoStyle,
          forceRegenerate,
        }),
      });
      const json = await r.json().catch(() => null);
      if (!r.ok) {
        const code = json?.error ?? `HTTP ${r.status}`;
        const friendly =
          code === "fact_enrichment_invalid"
            ? "This fact has no valid enrichment — enrich it before using the image bench."
            : code === "image_prompt_generation_failed"
              ? "The image-prompt engine failed while building the prompt. Try again or check the fact's enrichment."
              : code === "source_image_analysis_failed"
                ? "Could not analyze the sample image for image-to-image. Check the sample image URL."
                : code;
        throw new Error(friendly);
      }
      const data = json as { imagePrompt?: string; motionPrompt?: string; dialogueText?: string; videoDirection?: string };
      if (typeof data.imagePrompt === "string") setImagePrompt(data.imagePrompt);
      if (typeof data.motionPrompt === "string") { setMotionPrompt(data.motionPrompt); setExperiment("custom"); }
      if (typeof data.dialogueText === "string") { setDialogueText(data.dialogueText); setDialogueEnabled(true); }
      if (typeof data.videoDirection === "string") {
        videoStyleRef.current = { key: videoCacheKey, value: data.videoDirection };
      }
    } catch (e) {
      setAssembleError(String(e instanceof Error ? e.message : e));
    } finally {
      setAssembling(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFact?.id, gender, lookStyleId, motionPresetId, sampleUrl, aspectRatio, isImagePromptBench, isVideoBench, benchType, engine.id]);

  // Auto-assemble (cached prompts) whenever the selection changes.
  useEffect(() => { void runAssemble(false); }, [runAssemble]);

  // ── Experiment radio → auto-fill dialogue ───────────────────────────────
  const applyExperiment = (next: ExperimentMode) => {
    setExperiment(next);
    if (next === "A") {
      setDialogueEnabled(engine.audioHandling !== "none");
      setDialogueText(DEFAULT_TEST_DIALOGUE_FULL);
    } else if (next === "B") {
      setDialogueEnabled(engine.audioHandling !== "none");
      setDialogueText(DEFAULT_TEST_DIALOGUE_SHORT);
    } else if (next === "C") {
      setDialogueEnabled(false);
      setDialogueText("");
    }
    // "custom" leaves the form alone — set when admin edits something manually.
  };

  const [running, setRunning] = useState(false);
  const [pollPhase, setPollPhase] = useState<"queued" | "in_progress" | null>(null);
  // AbortController + cleanup-on-unmount keep the poll loop from leaking
  // setState calls on an unmounted component when the admin closes the
  // panel mid-run. The ref is updated on every Run press; the effect's
  // cleanup aborts whichever controller is current when the component
  // unmounts.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const [result, setResult] = useState<{
    ok?: boolean;
    falInput?: unknown;
    falResult?: unknown;
    error?: { message?: string; body?: unknown; status?: unknown };
    durationMs?: number;
    testFixtures?: {
      motionPrompt?: string;
      imagePrompt?: string;
      dialogueText?: string | null;
    };
  } | null>(null);
  const [httpError, setHttpError] = useState<string | null>(null);

  // Dry-run preview of the exact call that WILL be sent to the engine, shown
  // above the Run button so the admin can verify the shape without rendering.
  const [preview, setPreview] = useState<{ endpointId?: string; falInput?: unknown } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Coerce engine-param string inputs back to the type the schema declared
  // so the server sees proper types (boolean true vs "true", number 0.5 vs "0.5").
  function coerceExtraValue(entry: ParamSchemaEntryLike, raw: string): unknown {
    if (raw === "") return undefined;
    switch (entry.type) {
      case "boolean":
        return raw === "true" || raw === "1";
      case "int":
        return Math.round(Number(raw));
      case "stringInt":
        return String(Math.round(Number(raw)));
      case "float":
        return Number(raw);
      case "stringArray":
        // Comma- or newline-separated → array of trimmed non-empty strings.
        // Single value stays a one-element array, which is what
        // engines like Nano Banana Pro expect for image_urls.
        return raw
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      default:
        return raw;
    }
  }

  // Convert a camelCase from-key into a readable label.
  //   autoFix          → "Auto fix"
  //   safetyTolerance  → "Safety tolerance"
  //   numInferenceSteps → "Num inference steps"
  // Acronyms like "cfg" stay as the original camelCase boundary.
  function humanizeKey(key: string): string {
    const spaced = key.replace(/([A-Z])/g, " $1").trim().toLowerCase();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  // Build the exact request body sent to POST /:id/test. Shared by the live
  // run and the dry-run preview so the preview can never drift from reality.
  const buildRequestBody = (): Record<string, unknown> => {
    const body: Record<string, unknown> = {};
    if (sampleUrl.trim()) body.sampleImageUrl = sampleUrl.trim();
    // Transform/scene prompt — image benches only.
    if (isImagePromptBench && imagePrompt.trim()) {
      body.imagePrompt = imagePrompt.trim();
    }
    // Motion + dialogue + duration + audio are video-only concepts.
    if (isVideoBench) {
      if (motionPrompt.trim() && motionPrompt !== DEFAULT_TEST_MOTION_PROMPT) {
        body.motionPrompt = motionPrompt;
      }
      // dialogueText: null = explicit silence, string = override, undefined = default
      if (!dialogueEnabled) {
        body.dialogueText = null;
      } else if (dialogueText.trim() && dialogueText !== DEFAULT_TEST_DIALOGUE_FULL) {
        body.dialogueText = dialogueText;
      }
      if (durationSec && Number(durationSec) > 0) body.durationSec = Number(durationSec);
      if (generateAudio !== (engine.audioHandling !== "none")) {
        body.generateAudio = generateAudio;
      }
      if (mode) body.mode = mode;
    }
    if (aspectRatio && benchType !== "utility") body.aspectRatio = aspectRatio;
    if (resolution) body.resolution = resolution;
    if (engineParams.length > 0) {
      const extras: Record<string, unknown> = {};
      for (const p of engineParams) {
        if (!p.from) continue;
        const raw = extraParams[p.from] ?? "";
        const coerced = coerceExtraValue(p, raw);
        if (coerced !== undefined) extras[p.from] = coerced;
      }
      if (Object.keys(extras).length > 0) body.extraParams = extras;
    }
    return body;
  };

  // Serialized snapshot of the request body; the preview effect re-runs only
  // when the body that would be sent actually changes.
  const requestBodyJson = JSON.stringify(buildRequestBody());

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        setPreviewError(null);
        const r = await fetch(`/api/admin/engines/${engine.id}/test`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...(JSON.parse(requestBodyJson) as Record<string, unknown>), dryRun: true }),
          signal: controller.signal,
        });
        const json = await r.json().catch(() => null);
        if (!r.ok || !json) {
          const errMsg =
            (typeof json?.error === "string" ? json.error : json?.error?.message) ||
            json?.message ||
            `Preview failed (HTTP ${r.status})`;
          setPreview(null);
          setPreviewError(errMsg);
          return;
        }
        setPreview({ endpointId: json.endpointId, falInput: json.falInput });
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        setPreview(null);
        setPreviewError("Preview unavailable");
      }
    }, 400);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [requestBodyJson, engine.id]);

  const handleRun = async () => {
    // Abort any in-flight poll loop from a previous Run before starting a new one.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;

    setRunning(true);
    setHttpError(null);
    setResult(null);
    setPollPhase(null);
    try {
      const body = buildRequestBody();

      const submittedAt = Date.now();
      const r = await fetch(`/api/admin/engines/${engine.id}/test`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      const json = await r.json().catch(() => null);
      // 502 is the deliberate "fal.queue.submit threw" status — the body
      // still carries falInput + structured error. Don't surface it as a
      // generic httpError; let the result panel render it like any other
      // ok:false outcome.
      if (!r.ok && r.status !== 502) {
        setHttpError(json?.message || json?.error || `HTTP ${r.status}`);
        return;
      }

      // Submit failed synchronously (e.g. invalid input before fal call,
      // or fal.queue.submit threw → 502 with ok:false body).
      if (json?.ok === false) {
        setResult(json);
        return;
      }

      // 202 — fal job submitted; poll for result
      if (json?.status === "submitted" && json?.requestId) {
        const { requestId, falInput, testFixtures } = json as {
          requestId: string;
          falInput: unknown;
          testFixtures: { motionPrompt?: string; imagePrompt?: string; dialogueText?: string | null };
        };
        // Show the fal input immediately so the admin can inspect the payload shape
        setResult({ falInput, testFixtures });
        setPollPhase("queued");

        // Bound the poll loop so a stuck fal queue can't spin forever:
        // 4× the engine's expected runtime, clamped to [60 s, 5 min].
        // We tolerate up to 3 consecutive transient poll-fetch errors
        // (HTTP 5xx, dropped requests) before terminating with httpError.
        const MAX_POLL_MS = Math.min(
          Math.max(engine.expectedRunMs * 4, 60_000),
          5 * 60_000,
        );
        const POLL_INTERVAL_MS = 3000;
        const MAX_TRANSIENT_ERRORS = 3;
        let transientErrors = 0;
        const deadline = Date.now() + MAX_POLL_MS;

        while (Date.now() < deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          if (signal.aborted) return;

          let pr: Response;
          try {
            pr = await fetch(`/api/admin/engines/${engine.id}/test/poll/${requestId}`, {
              credentials: "include",
              signal,
            });
          } catch (fetchErr) {
            if (signal.aborted) return;
            transientErrors += 1;
            if (transientErrors > MAX_TRANSIENT_ERRORS) {
              setHttpError(`Poll fetch failed after ${MAX_TRANSIENT_ERRORS} retries: ${String(fetchErr)}`);
              return;
            }
            continue;
          }
          const pjson = await pr.json().catch(() => null);
          if (!pr.ok || !pjson) {
            transientErrors += 1;
            if (transientErrors > MAX_TRANSIENT_ERRORS) {
              setHttpError(`Poll failed after ${MAX_TRANSIENT_ERRORS} retries: HTTP ${pr.status}`);
              return;
            }
            continue;
          }
          transientErrors = 0;

          if (pjson.done) {
            // Fall back to a client-side computed runtime if the server
            // didn't return one (e.g. the submit-timestamp map was
            // evicted by the TTL during a very long-lived run).
            const durationMs =
              typeof pjson.durationMs === "number"
                ? pjson.durationMs
                : Date.now() - submittedAt;
            setResult({
              ok: pjson.ok,
              falInput,
              falResult: pjson.falResult,
              error: pjson.error,
              durationMs,
              testFixtures,
            });
            return;
          }
          setPollPhase(pjson.phase === "IN_QUEUE" ? "queued" : "in_progress");
        }

        // Hit the deadline without seeing done:true. Surface the timeout
        // as an explicit error rather than leaving the run state hanging.
        setResult({
          ok: false,
          falInput,
          testFixtures,
          error: {
            message: `Workbench poll timed out after ${Math.round(MAX_POLL_MS / 1000)}s without a terminal status from fal`,
          },
          durationMs: Date.now() - submittedAt,
        });
        return;
      }

      // Fallback: synchronous-looking result (shouldn't normally happen)
      setResult(json);
    } catch (e) {
      if (signal.aborted) return;
      setHttpError(String(e));
    } finally {
      if (!signal.aborted) {
        setRunning(false);
        setPollPhase(null);
      }
    }
  };

  const resetToDefaults = () => {
    setSampleUrl("");
    setImagePrompt(DEFAULT_TEST_IMAGE_PROMPT);
    setMotionPrompt(DEFAULT_TEST_MOTION_PROMPT);
    setDialogueEnabled(engine.audioHandling !== "none");
    setDialogueText(DEFAULT_TEST_DIALOGUE_FULL);
    setDurationSec(engine.defaultDurationSec !== null ? String(engine.defaultDurationSec) : "");
    setAspectRatio(engine.defaultAspectRatio ?? "");
    setResolution(engine.defaultResolution ?? "");
    setMode(engine.defaultMode ?? "");
    setGenerateAudio(engine.audioHandling !== "none");
    const reset: Record<string, string> = {};
    for (const p of engineParams) {
      if (p.from && p.default !== undefined && p.default !== null) {
        reset[p.from] = String(p.default);
      }
    }
    setExtraParams(reset);
    setExperiment("A");
  };

  const inputCls =
    "w-full px-2 py-1.5 text-xs font-mono bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary";
  const selectCls =
    "w-full px-2 py-1.5 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary";
  const labelCls = "block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide";

  return (
    <div className="mt-4 border-t border-border pt-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Beaker className="w-4 h-4 text-primary" />
          <h4 className="text-xs font-bold text-foreground uppercase tracking-wide">Synthetic test workbench</h4>
        </div>
        <button
          type="button"
          onClick={resetToDefaults}
          className="text-[10px] text-muted-foreground hover:text-foreground underline"
        >
          Reset to defaults
        </button>
      </div>

      {/* Bench-type banner so the admin knows which use-case this engine serves. */}
      <p className="text-[10px] font-mono uppercase tracking-wider text-primary/80" data-testid="engine-bench-type">
        {benchType.replace(/-/g, " ")} bench
      </p>

      {/* ── Production test inputs: pick a real fact (+ style/motion) ──── */}
      {benchType !== "utility" && (
        <div className="space-y-3 rounded-sm border border-primary/30 bg-primary/5 p-2">
          <p className="text-[10px] font-semibold text-primary uppercase tracking-wider">
            Test against a real fact
          </p>

          {/* Fact picker */}
          <div className="relative">
            <label className={labelCls}>Fact</label>
            {selectedFact ? (
              <div className="flex items-start gap-2 rounded-sm border border-border bg-muted/30 px-2 py-1.5">
                <span className="flex-1 text-xs">{renderFactText(selectedFact.text)}</span>
                <button
                  type="button"
                  onClick={() => { setSelectedFact(null); setFactQuery(""); }}
                  className="text-[10px] text-muted-foreground hover:text-foreground underline shrink-0"
                >
                  change
                </button>
              </div>
            ) : (
              <>
                <input
                  value={factQuery}
                  onChange={(e) => setFactQuery(e.target.value)}
                  placeholder="Search facts by text…"
                  className={inputCls}
                  data-testid="engine-test-fact-search"
                />
                {factResults.length > 0 && (
                  <div className="mt-1 max-h-44 overflow-y-auto rounded-sm border border-border bg-card">
                    {factResults.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => { setSelectedFact({ id: f.id, text: f.text }); setFactResults([]); }}
                        className="block w-full px-2 py-1.5 text-left text-xs hover:bg-muted/50 border-b border-border last:border-0"
                      >
                        {renderFactText(f.text)}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Gender (image benches — scene prompts are per-gender) */}
          {isImagePromptBench && (
            <div>
              <label className={labelCls}>Subject gender (scene prompt)</label>
              <select
                value={gender}
                onChange={(e) => setGender(e.target.value as "male" | "female" | "neutral")}
                className={selectCls}
                data-testid="engine-test-gender"
              >
                <option value="neutral">neutral</option>
                <option value="male">male</option>
                <option value="female">female</option>
              </select>
            </div>
          )}

          {/* Look style (image benches) */}
          {isImagePromptBench && (
            <div>
              <label className={labelCls}>Look style</label>
              <select
                value={lookStyleId}
                onChange={(e) => setLookStyleId(e.target.value)}
                className={selectCls}
                data-testid="engine-test-look-style"
              >
                <option value="">(no style suffix)</option>
                {lookStyles.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Motion preset (video bench) */}
          {isVideoBench && (
            <div>
              <label className={labelCls}>Motion preset</label>
              <select
                value={motionPresetId}
                onChange={(e) => setMotionPresetId(e.target.value)}
                className={selectCls}
                data-testid="engine-test-motion-preset"
              >
                <option value="">(no motion preset)</option>
                {motionPresets.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          )}

          <p className="text-[10px] text-muted-foreground">
            {assembling
              ? "Assembling the production prompt…"
              : assembleError
                ? `Assemble failed: ${assembleError}`
                : selectedFact
                  ? "Prompt below is auto-filled from this fact — edit freely before running."
                  : "Pick a fact to auto-fill the prompt the meme generator would send."}
          </p>

          {/* Regenerate: force fresh scene-prompt generation (image benches),
              overwriting a stale/misclassified cache on the fact. */}
          {isImagePromptBench && selectedFact && (
            <button
              type="button"
              disabled={assembling}
              onClick={() => void runAssemble(true)}
              className="text-[10px] text-primary hover:underline disabled:opacity-50"
              data-testid="engine-test-regenerate-prompt"
            >
              ↻ Regenerate scene prompts (overwrites this fact's cache)
            </button>
          )}

          {/* Regenerate: re-roll the AI Video Motion Prompt (generated from the
              source image, merged with the motion preset below). */}
          {isVideoBench && selectedFact && (
            <button
              type="button"
              disabled={assembling}
              onClick={() => void runAssemble(true)}
              className="text-[10px] text-primary hover:underline disabled:opacity-50"
              data-testid="engine-test-regenerate-video-style"
            >
              ↻ Regenerate AI Video Motion Prompt
            </button>
          )}
        </div>
      )}

      {/* ── Experiment selector (video only — dialogue behavior) ──────── */}
      {isVideoBench && (
        <div>
          <label className={labelCls}>Experiment shape</label>
          <div className="flex gap-2 flex-wrap">
            {([
              { value: "A", label: "A · Baseline (full dialogue)" },
              { value: "B", label: "B · Short dialogue (padding test)" },
              { value: "C", label: "C · No dialogue (silence test)" },
            ] as const).map((opt) => (
              <label key={opt.value} className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input
                  type="radio"
                  name={`exp-${engine.id}`}
                  value={opt.value}
                  checked={experiment === opt.value}
                  onChange={() => applyExperiment(opt.value)}
                  className="accent-primary"
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            A baseline = does the engine cleanly speak/narrate the dialogue?
            B = does it invent extra dialogue when there&apos;s clip time left after the cue?
            C = does it produce uninvited speech when given none?
          </p>
        </div>
      )}

      {/* ── Source asset (image for video/image-to-image; video URL for utility) ── */}
      {needsSourceAsset && (
        <div>
          <label className={labelCls}>
            {sampleIsVideo
              ? "Sample video URL (required — utility engines caption a video)"
              : "Sample image URL (optional — defaults to bundled face)"}
          </label>
          <input
            value={sampleUrl}
            onChange={(e) => setSampleUrl(e.target.value)}
            placeholder={sampleIsVideo ? "https://…/clip.mp4" : "https://…/face.jpg"}
            className={inputCls}
          />
        </div>
      )}

      {/* ── Transform / scene prompt (image benches) ──────────────────── */}
      {isImagePromptBench && (
        <div>
          <label className={labelCls}>
            {benchType === "image-to-image"
              ? "Transform prompt (how to restyle the source image)"
              : "Image prompt (scene to generate)"}
          </label>
          <textarea
            value={imagePrompt}
            onChange={(e) => setImagePrompt(e.target.value)}
            rows={4}
            className={`${inputCls} font-sans`}
            data-testid="engine-test-image-prompt"
          />
        </div>
      )}

      {/* ── Motion prompt (video only) ───────────────────────────────── */}
      {isVideoBench && (
        <div>
          <label className={labelCls}>Motion prompt (AI Video Motion Prompt + motion preset)</label>
          <textarea
            value={motionPrompt}
            onChange={(e) => { setMotionPrompt(e.target.value); setExperiment("custom"); }}
            rows={4}
            className={`${inputCls} font-sans`}
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            The motion is generated from the source image below (the model sees the still). Paste a real rendered still as the Sample image URL for an accurate preview — otherwise it falls back to the bundled placeholder.
          </p>
        </div>
      )}

      {/* ── Dialogue (video only) ────────────────────────────────────── */}
      {isVideoBench && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className={labelCls + " mb-0"}>Dialogue cue</label>
            <label className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={dialogueEnabled}
                onChange={(e) => { setDialogueEnabled(e.target.checked); setExperiment("custom"); }}
                className="accent-primary"
              />
              <span>Send dialogue</span>
            </label>
          </div>
          <textarea
            value={dialogueText}
            onChange={(e) => { setDialogueText(e.target.value); setExperiment("custom"); }}
            rows={2}
            disabled={!dialogueEnabled}
            placeholder={dialogueEnabled ? DEFAULT_TEST_DIALOGUE_FULL : "(silence)"}
            className={`${inputCls} font-sans ${!dialogueEnabled ? "opacity-50" : ""}`}
          />
        </div>
      )}

      {/* ── Universal option grid ────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3">
        {engine.allowedDurationsSec && engine.allowedDurationsSec.length > 0 ? (
          <div>
            <label className={labelCls}>Duration (sec)</label>
            <select
              value={durationSec}
              onChange={(e) => { setDurationSec(e.target.value); setExperiment("custom"); }}
              className={selectCls}
            >
              {engine.allowedDurationsSec.map((d) => (
                <option key={d} value={d}>{d}s</option>
              ))}
            </select>
          </div>
        ) : null}

        {engine.allowedResolutions && engine.allowedResolutions.length > 0 ? (
          <div>
            <label className={labelCls}>Resolution</label>
            <select
              value={resolution}
              onChange={(e) => { setResolution(e.target.value); setExperiment("custom"); }}
              className={selectCls}
            >
              {engine.allowedResolutions.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
        ) : null}

        {engine.allowedAspectRatios && engine.allowedAspectRatios.length > 0 ? (
          <div>
            <label className={labelCls}>Aspect ratio</label>
            <select
              value={aspectRatio}
              onChange={(e) => { setAspectRatio(e.target.value); setExperiment("custom"); }}
              className={selectCls}
            >
              {engine.allowedAspectRatios.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
        ) : null}

        {engine.supportedModes && engine.supportedModes.length > 0 ? (
          <div>
            <label className={labelCls}>Mode</label>
            <select
              value={mode}
              onChange={(e) => { setMode(e.target.value); setExperiment("custom"); }}
              className={selectCls}
            >
              {engine.supportedModes.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
        ) : null}

        {engine.audioHandling !== "none" && (
          <label className="flex items-center gap-1.5 text-xs cursor-pointer pt-5">
            <input
              type="checkbox"
              checked={generateAudio}
              onChange={(e) => { setGenerateAudio(e.target.checked); setExperiment("custom"); }}
              className="accent-primary"
            />
            <span>generate_audio</span>
          </label>
        )}
      </div>

      {/* ── Engine-specific params (auto-rendered from paramSchema) ────── */}
      {engineParams.length > 0 && (
        <div className="space-y-2 rounded-sm border border-amber-500/30 bg-amber-500/5 p-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold text-amber-500 uppercase tracking-wider">
              {engine.label} — engine-specific params
            </p>
            <span className="text-[10px] font-mono text-amber-500/70">
              {engineParams.length} knob{engineParams.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {engineParams.map((p) => {
              const key = p.from!;
              const value = extraParams[key] ?? "";
              const setValue = (v: string) => {
                setExtraParams((prev) => ({ ...prev, [key]: v }));
                setExperiment("custom");
              };
              const label = humanizeKey(key);
              const defaultBadge = p.default !== undefined && p.default !== null
                ? <span className="ml-1 text-[10px] text-muted-foreground/60 font-mono normal-case">default: {String(p.default)}</span>
                : null;
              const typeBadge = (
                <span className="ml-1 text-[9px] text-amber-500/60 font-mono normal-case">{p.type}</span>
              );
              const fieldName = (
                <>
                  <span>{label}</span>
                  {typeBadge}
                  {defaultBadge}
                </>
              );

              if (p.type === "boolean") {
                return (
                  <label key={key} className="flex items-center gap-1.5 text-xs cursor-pointer pt-4">
                    <input
                      type="checkbox"
                      checked={value === "true" || value === "1"}
                      onChange={(e) => setValue(e.target.checked ? "true" : "false")}
                      className="accent-primary"
                    />
                    <span>{fieldName}</span>
                  </label>
                );
              }
              if (p.enum && p.enum.length > 0) {
                return (
                  <div key={key}>
                    <label className={labelCls}>{fieldName}</label>
                    <select value={value} onChange={(e) => setValue(e.target.value)} className={selectCls}>
                      <option value="">(default{p.default !== undefined ? `: ${String(p.default)}` : ""})</option>
                      {p.enum.map((v) => (
                        <option key={String(v)} value={String(v)}>{String(v)}</option>
                      ))}
                    </select>
                  </div>
                );
              }
              if (p.type === "stringArray") {
                return (
                  <div key={key} className="col-span-2">
                    <label className={labelCls}>{fieldName}</label>
                    <input
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      type="text"
                      placeholder={p.default !== undefined ? String(p.default) : "comma-separated URLs"}
                      className={inputCls}
                    />
                  </div>
                );
              }
              const isNumber = p.type === "int" || p.type === "stringInt" || p.type === "float";
              return (
                <div key={key} className={isNumber ? "" : "col-span-2"}>
                  <label className={labelCls}>{fieldName}</label>
                  <input
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    type={isNumber ? "number" : "text"}
                    step={p.type === "float" ? "0.01" : "1"}
                    min={p.range?.min}
                    max={p.range?.max}
                    placeholder={p.default !== undefined ? String(p.default) : ""}
                    className={inputCls}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Live preview of the exact call that will be sent — no render cost. */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
            fal input (will be sent)
          </p>
          {preview?.endpointId && (
            <code className="text-[10px] font-mono text-primary/80 bg-primary/5 px-1.5 py-0.5 rounded-sm">
              {preview.endpointId}
            </code>
          )}
        </div>
        {previewError ? (
          <pre className="text-[11px] font-mono bg-destructive/5 border border-destructive/30 text-destructive rounded-sm p-2 overflow-x-auto whitespace-pre-wrap break-all">
            {previewError}
          </pre>
        ) : (
          <pre className="text-[11px] font-mono bg-muted/30 border border-border rounded-sm p-2 overflow-x-auto whitespace-pre-wrap break-all">
            {preview ? safeJson(preview.falInput) : "Building preview…"}
          </pre>
        )}
      </div>

      <button
        onClick={handleRun}
        disabled={running}
        className="flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-primary text-primary-foreground rounded-sm hover:bg-primary/90 disabled:opacity-50 transition-colors"
      >
        {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Beaker className="w-3.5 h-3.5" />}
        {running
          ? pollPhase === "queued" ? "In queue…"
          : pollPhase === "in_progress" ? "Running…"
          : "Submitting…"
          : "Run test"}
      </button>

      {running && pollPhase && (
        <p className="text-[11px] text-muted-foreground">
          {pollPhase === "queued" ? "Job is queued — polling every 3s…" : "Job is running — polling every 3s…"}
        </p>
      )}

      {httpError && <p className="text-xs text-destructive">{httpError}</p>}

      {result && (
        <div className="space-y-3">
          {typeof result.ok === "boolean" && (
            <div className="flex items-center gap-2 text-xs">
              <span className={`px-1.5 py-0.5 rounded font-bold ${result.ok ? "bg-green-500/10 text-green-400" : "bg-destructive/10 text-destructive"}`}>
                {result.ok ? "OK" : "FAIL"}
              </span>
              {result.durationMs !== undefined && <span className="text-muted-foreground">{msToHuman(result.durationMs)}</span>}
            </div>
          )}

          {result.testFixtures && (
            <div className="space-y-2 rounded-sm border border-amber-500/30 bg-amber-500/5 p-2">
              <p className="text-[10px] font-semibold text-amber-500 uppercase tracking-wider">Spot-check against these</p>
              <div className="space-y-1.5 text-[11px]">
                {isImagePromptBench && result.testFixtures.imagePrompt && (
                  <div>
                    <span className="text-muted-foreground">
                      {benchType === "image-to-image" ? "Expected transform: " : "Expected scene: "}
                    </span>
                    <span className="text-foreground">{result.testFixtures.imagePrompt}</span>
                  </div>
                )}
                {isVideoBench && (
                  <div>
                    <span className="text-muted-foreground">Expected motion: </span>
                    <span className="text-foreground">{result.testFixtures.motionPrompt}</span>
                  </div>
                )}
                {isVideoBench && result.testFixtures.dialogueText && (
                  <div>
                    <span className="text-muted-foreground">Expected audio (should say): </span>
                    <span className="text-foreground italic">&ldquo;{result.testFixtures.dialogueText}&rdquo;</span>
                  </div>
                )}
                {benchType === "utility" && (
                  <div className="text-muted-foreground italic">
                    Utility engine — captions the supplied video; no generated audio.
                  </div>
                )}
              </div>
            </div>
          )}

          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">fal input (sent)</p>
            <pre className="text-[11px] font-mono bg-muted/30 border border-border rounded-sm p-2 overflow-x-auto whitespace-pre-wrap break-all">
              {safeJson(result.falInput)}
            </pre>
          </div>

          {typeof result.ok === "boolean" && (result.ok ? (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">fal result</p>
              <pre className="text-[11px] font-mono bg-muted/30 border border-border rounded-sm p-2 overflow-x-auto whitespace-pre-wrap break-all">
                {safeJson(result.falResult)}
              </pre>
            </div>
          ) : (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Error</p>
              <pre className="text-[11px] font-mono bg-destructive/5 border border-destructive/30 rounded-sm p-2 overflow-x-auto whitespace-pre-wrap break-all">
                {safeJson(result.error)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EngineEditor({ engine, onSaved }: { engine: EngineRow; onSaved: (e: EngineRow) => void }) {
  const isLLM = engine.kind === "llm";
  const [form, setForm] = useState({
    isActive: engine.isActive,
    isDefault: engine.isDefault,
    sortOrder: String(engine.sortOrder),
    tierRequirement: engine.tierRequirement,
    featureFlagRequired: engine.featureFlagRequired ?? "",
    defaultDurationSec: engine.defaultDurationSec === null ? "" : String(engine.defaultDurationSec),
    defaultResolution: engine.defaultResolution ?? "",
    defaultAspectRatio: engine.defaultAspectRatio ?? "",
    defaultMode: engine.defaultMode ?? "",
    expectedRunMs: String(engine.expectedRunMs),
    estimatedCostUsdPerCall: engine.estimatedCostUsdPerCall === null ? "" : String(engine.estimatedCostUsdPerCall),
    estimatedCostUsdPerSecond: engine.estimatedCostUsdPerSecond === null ? "" : String(engine.estimatedCostUsdPerSecond),
    endpointId: engine.endpointId,
    defaultTemperature: engine.defaultTemperature === null ? "" : String(engine.defaultTemperature),
    defaultMaxTokens: engine.defaultMaxTokens === null ? "" : String(engine.defaultMaxTokens),
    defaultReasoningEffort: engine.defaultReasoningEffort ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof typeof form>(k: K, v: typeof form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const patch: Record<string, unknown> = {
        isActive: form.isActive,
        isDefault: form.isDefault,
        sortOrder: Number.parseInt(form.sortOrder, 10) || 0,
        tierRequirement: form.tierRequirement,
        featureFlagRequired: form.featureFlagRequired.trim() === "" ? null : form.featureFlagRequired.trim(),
        defaultDurationSec: form.defaultDurationSec === "" ? null : Number.parseInt(form.defaultDurationSec, 10),
        defaultResolution: form.defaultResolution === "" ? null : form.defaultResolution,
        defaultAspectRatio: form.defaultAspectRatio === "" ? null : form.defaultAspectRatio,
        defaultMode: form.defaultMode === "" ? null : form.defaultMode,
        expectedRunMs: Number.parseInt(form.expectedRunMs, 10) || 0,
        estimatedCostUsdPerCall: form.estimatedCostUsdPerCall === "" ? null : Number(form.estimatedCostUsdPerCall),
        estimatedCostUsdPerSecond: form.estimatedCostUsdPerSecond === "" ? null : Number(form.estimatedCostUsdPerSecond),
      };
      // LLM engines: model (endpointId) + sampling + reasoning effort are editable.
      if (isLLM) {
        patch.endpointId = form.endpointId;
        patch.defaultTemperature = form.defaultTemperature === "" ? null : Number(form.defaultTemperature);
        patch.defaultMaxTokens = form.defaultMaxTokens === "" ? null : Number.parseInt(form.defaultMaxTokens, 10);
        patch.defaultReasoningEffort = form.defaultReasoningEffort === "" ? null : form.defaultReasoningEffort;
      }
      const r = await fetch(`/api/admin/engines/${engine.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const updated: EngineRow = await r.json();
      onSaved(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const resolutionOpts = engine.allowedResolutions ?? [];
  const aspectOpts = engine.allowedAspectRatios ?? [];
  const modeOpts = engine.supportedModes ?? [];
  const durationOpts = engine.allowedDurationsSec ?? [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-4 border-t border-border">
      {/* ── Admin-editable column ────────────────────────────────────────── */}
      <div className="space-y-3">
        <h4 className="text-xs font-bold text-foreground uppercase tracking-wide">Admin-editable</h4>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => set("isActive", !form.isActive)}
            className={`flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 text-xs font-bold rounded-sm border transition-colors ${
              form.isActive ? "bg-green-500/10 border-green-500/40 text-green-400" : "bg-muted/30 border-border text-muted-foreground"
            }`}
          >
            {form.isActive ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            {form.isActive ? "Active" : "Inactive"}
          </button>
          <button
            onClick={() => set("isDefault", !form.isDefault)}
            className={`flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 text-xs font-bold rounded-sm border transition-colors ${
              form.isDefault ? "bg-amber-500/10 border-amber-500/40 text-amber-400" : "bg-muted/30 border-border text-muted-foreground"
            }`}
          >
            <Star className="w-3.5 h-3.5" />
            {form.isDefault ? "Default for kind" : "Not default"}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Sort order</label>
            <input
              type="number"
              value={form.sortOrder}
              onChange={(e) => set("sortOrder", e.target.value)}
              className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Tier requirement</label>
            <select
              value={form.tierRequirement}
              onChange={(e) => set("tierRequirement", e.target.value)}
              className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            >
              <option value="unregistered">unregistered</option>
              <option value="registered">registered</option>
              <option value="legendary">legendary</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Feature flag required (empty = none)</label>
          <input
            value={form.featureFlagRequired}
            onChange={(e) => set("featureFlagRequired", e.target.value)}
            placeholder="engine_experiments"
            className="w-full min-h-[40px] px-2 py-1 text-xs font-mono bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
          />
        </div>

        {isLLM && (
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Model (general intelligence)</label>
              <select
                value={form.endpointId}
                onChange={(e) => set("endpointId", e.target.value)}
                className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
              >
                {OPENAI_CHAT_MODEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                {!OPENAI_CHAT_MODEL_OPTIONS.some((o) => o.value === form.endpointId) && (
                  <option value={form.endpointId}>{form.endpointId} (current)</option>
                )}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Default temperature</label>
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={form.defaultTemperature}
                onChange={(e) => set("defaultTemperature", e.target.value)}
                className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Default max tokens</label>
              <input
                type="number"
                value={form.defaultMaxTokens}
                onChange={(e) => set("defaultMaxTokens", e.target.value)}
                className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Default reasoning effort (GPT-5 / o-series only)</label>
              <select
                value={form.defaultReasoningEffort}
                onChange={(e) => set("defaultReasoningEffort", e.target.value)}
                className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
              >
                <option value="">— none —</option>
                {REASONING_EFFORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
        )}

        {!isLLM && (
        <>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">
              Default duration (sec) {durationOpts.length > 0 && <span className="font-normal normal-case">— allowed: {durationOpts.join(", ")}</span>}
            </label>
            <input
              type="number"
              value={form.defaultDurationSec}
              onChange={(e) => set("defaultDurationSec", e.target.value)}
              className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Default resolution</label>
            <select
              value={form.defaultResolution}
              onChange={(e) => set("defaultResolution", e.target.value)}
              className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            >
              <option value="">— none —</option>
              {resolutionOpts.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Default aspect ratio</label>
            <select
              value={form.defaultAspectRatio}
              onChange={(e) => set("defaultAspectRatio", e.target.value)}
              className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            >
              <option value="">— none —</option>
              {aspectOpts.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Default mode</label>
            <select
              value={form.defaultMode}
              onChange={(e) => set("defaultMode", e.target.value)}
              className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            >
              <option value="">— none —</option>
              {modeOpts.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">
              Expected run (ms) — <span className="font-normal">{msToHuman(Number.parseInt(form.expectedRunMs, 10) || 0)}</span>
            </label>
            <input
              type="number"
              value={form.expectedRunMs}
              onChange={(e) => set("expectedRunMs", e.target.value)}
              className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">$ per call</label>
            <input
              type="number"
              step="0.0001"
              value={form.estimatedCostUsdPerCall}
              onChange={(e) => set("estimatedCostUsdPerCall", e.target.value)}
              placeholder="(null)"
              className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide">$ per second</label>
            <input
              type="number"
              step="0.0001"
              value={form.estimatedCostUsdPerSecond}
              onChange={(e) => set("estimatedCostUsdPerSecond", e.target.value)}
              placeholder="(null)"
              className="w-full min-h-[40px] px-2 py-1 text-xs bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            />
          </div>
        </div>
        </>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 min-h-[40px] px-4 py-1.5 text-xs font-bold uppercase tracking-wide bg-primary text-primary-foreground rounded-sm hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          <Save className="w-3.5 h-3.5" />
          {saving ? "Saving…" : saved ? "Saved!" : "Save changes"}
        </button>
      </div>

      {/* ── Read-only metadata ──────────────────────────────────────────── */}
      <div className="space-y-3">
        <h4 className="text-xs font-bold text-foreground uppercase tracking-wide">Read-only metadata (code-owned)</h4>
        <div className="grid grid-cols-2 gap-3">
          <ReadOnlyField label="id" value={engine.id} />
          <ReadOnlyField label="provider" value={engine.provider} />
          <ReadOnlyField label="kind" value={engine.kind} />
          <ReadOnlyField label="audio handling" value={engine.audioHandling} />
        </div>
        <ReadOnlyField label="endpoint" value={engine.endpointId} />
        <div className="grid grid-cols-2 gap-3">
          <ReadOnlyField label="allowed durations" value={engine.allowedDurationsSec?.join(", ") ?? null} />
          <ReadOnlyField label="allowed resolutions" value={engine.allowedResolutions?.join(", ") ?? null} />
          <ReadOnlyField label="allowed aspect ratios" value={engine.allowedAspectRatios?.join(", ") ?? null} />
          <ReadOnlyField label="supported modes" value={engine.supportedModes?.join(", ") ?? null} />
        </div>
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">paramSchema</p>
          <pre className="text-[11px] font-mono bg-muted/30 border border-border rounded-sm p-2 overflow-x-auto max-h-64 whitespace-pre-wrap break-all">
            {safeJson(engine.paramSchema)}
          </pre>
        </div>
      </div>
    </div>
  );
}

function EngineCard({
  engine,
  archived,
  onChanged,
}: {
  engine: EngineRow;
  archived: boolean;
  onChanged: (e: EngineRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [busy, setBusy] = useState<null | string>(null);

  const archive = async () => {
    if (!confirm(`Archive engine "${engine.label}"? It will be hidden from the wizard and interpreter but kept for video-job lineage.`)) return;
    setBusy("archive");
    try {
      const r = await fetch(`/api/admin/engines/${engine.id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      onChanged(await r.json());
    } finally { setBusy(null); }
  };

  const restore = async () => {
    setBusy("restore");
    try {
      const r = await fetch(`/api/admin/engines/${engine.id}/restore`, { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      onChanged(await r.json());
    } finally { setBusy(null); }
  };

  const setDefault = async () => {
    setBusy("setDefault");
    try {
      const r = await fetch(`/api/admin/engines/${engine.id}/set-default`, { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      onChanged(await r.json());
    } finally { setBusy(null); }
  };

  return (
    <div className={`bg-card border rounded-sm overflow-hidden ${!engine.isActive || archived ? "opacity-70" : "border-border"}`}>
      <div className="p-4 flex items-start gap-3">
        <button onClick={() => setExpanded((v) => !v)} className="flex items-start gap-3 flex-1 min-w-0 text-left">
          <div className={`mt-1 w-2 h-2 rounded-full shrink-0 ${engine.isActive && !archived ? "bg-green-400" : "bg-muted-foreground/40"}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-foreground">{engine.label}</span>
              <span className="text-[10px] font-mono text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">{engine.id}</span>
              <span className="text-[10px] font-bold text-muted-foreground bg-muted/30 px-1.5 py-0.5 rounded uppercase">{engine.provider}</span>
              {engine.isDefault && (
                <span className="flex items-center gap-0.5 text-[10px] font-bold text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
                  <Star className="w-2.5 h-2.5" /> default
                </span>
              )}
              {(() => {
                const params = (engine.paramSchema as { params?: unknown[] } | null)?.params;
                const count = Array.isArray(params) ? params.length : 0;
                return count > 0 ? (
                  <span className="text-[10px] font-mono text-amber-300/80 bg-amber-500/10 px-1.5 py-0.5 rounded">
                    {count} params
                  </span>
                ) : null;
              })()}
              {engine.featureFlagRequired && (
                <span className="text-[10px] font-mono text-purple-300 bg-purple-500/10 px-1.5 py-0.5 rounded">flag:{engine.featureFlagRequired}</span>
              )}
              {!engine.isActive && <span className="text-[10px] font-bold text-muted-foreground bg-muted px-1.5 py-0.5 rounded">INACTIVE</span>}
              {archived && <span className="text-[10px] font-bold text-destructive bg-destructive/10 px-1.5 py-0.5 rounded">ARCHIVED</span>}
            </div>
            <p className="text-[11px] text-muted-foreground font-mono mt-0.5 truncate">{engine.endpointId}</p>
            <p className="text-xs text-muted-foreground mt-1">{engine.description}</p>
          </div>
        </button>

        <div className="flex flex-col sm:flex-row gap-1 shrink-0">
          {!archived && (
            <>
              {/* The synthetic fal test bench doesn't apply to LLM engines. */}
              {engine.kind !== "llm" && (
                <button
                  onClick={() => setTestOpen((v) => !v)}
                  className="min-h-[36px] px-2 py-1 text-[11px] font-bold border border-border rounded-sm hover:border-primary/50 text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                  title="Run synthetic test"
                >
                  <Beaker className="w-3 h-3" /> Test
                </button>
              )}
              {!engine.isDefault && (
                <button
                  onClick={setDefault}
                  disabled={busy === "setDefault"}
                  className="min-h-[36px] px-2 py-1 text-[11px] font-bold border border-amber-500/40 rounded-sm hover:bg-amber-500/10 text-amber-400 transition-colors flex items-center gap-1"
                  title="Set as default for this kind"
                >
                  <Star className="w-3 h-3" /> Default
                </button>
              )}
              <button
                onClick={archive}
                disabled={busy === "archive"}
                className="min-h-[36px] px-2 py-1 text-[11px] font-bold border border-destructive/30 rounded-sm hover:bg-destructive/10 text-destructive transition-colors flex items-center gap-1"
              >
                <Trash2 className="w-3 h-3" /> Archive
              </button>
            </>
          )}
          {archived && (
            <button
              onClick={restore}
              disabled={busy === "restore"}
              className="min-h-[36px] px-2 py-1 text-[11px] font-bold border border-border rounded-sm hover:border-primary/50 text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
            >
              <Undo2 className="w-3 h-3" /> Restore
            </button>
          )}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="min-h-[36px] px-2 py-1 text-[11px] font-bold border border-border rounded-sm hover:border-primary/50 text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {expanded ? "Hide" : "Edit"}
          </button>
        </div>
      </div>

      {testOpen && !archived && (
        <div className="px-4 pb-4">
          <EngineTestPanel engine={engine} />
        </div>
      )}

      {expanded && (
        <div className="px-4 pb-4">
          <EngineEditor engine={engine} onSaved={onChanged} />
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-border">
            <ReadOnlyField label="created" value={new Date(engine.createdAt).toLocaleString()} />
            <ReadOnlyField label="updated" value={new Date(engine.updatedAt).toLocaleString()} />
            <ReadOnlyField label="cost/call" value={fmtCost(engine.estimatedCostUsdPerCall)} />
            <ReadOnlyField label="cost/sec" value={fmtCost(engine.estimatedCostUsdPerSecond)} />
          </div>
        </div>
      )}
    </div>
  );
}

type Tab = "live" | "archived";

export default function AdminEngines() {
  const [engines, setEngines] = useState<EngineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("live");

  useEffect(() => {
    fetch("/api/admin/engines", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data: ListResponse = await r.json();
        setEngines(data.engines);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const handleChanged = (updated: EngineRow) => {
    setEngines((prev) => (prev ? prev.map((e) => (e.id === updated.id ? updated : e)) : prev));
  };

  const grouped = useMemo(() => {
    if (!engines) return null;
    const filtered = engines.filter((e) => (tab === "archived" ? e.deletedAt !== null : e.deletedAt === null));
    const map = new Map<string, EngineRow[]>();
    for (const e of filtered) {
      // Split image engines into their two benches; everything else groups by kind.
      const section = e.kind === "image" ? engineBenchType(e) : e.kind;
      if (!map.has(section)) map.set(section, []);
      map.get(section)!.push(e);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    }
    const order = ["video", "text-to-image", "image-to-image", "utility"];
    return [...map.entries()].sort(([a], [b]) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  }, [engines, tab]);

  return (
    <AdminLayout title="Engines">
      <div className="max-w-5xl space-y-4">
        <div className="flex items-center gap-2">
          <Boxes className="w-5 h-5 text-primary" />
          <p className="text-sm text-muted-foreground">
            Manage the generative engines the video / image / utility pipelines call. Code-owned fields (paramSchema, endpoint, kind) are read-only; only the {EDITABLE_FIELDS.length} runtime knobs below are editable.
          </p>
        </div>

        <div className="flex items-center gap-1 border-b border-border">
          {(["live", "archived"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`min-h-[36px] px-3 py-1.5 text-xs font-bold uppercase tracking-wide border-b-2 transition-colors ${
                tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "live" ? "Live engines" : "Archived"}
            </button>
          ))}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {engines === null && !error && <p className="text-muted-foreground text-sm">Loading…</p>}

        {grouped !== null && grouped.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {tab === "archived" ? "No archived engines." : "No live engines configured."}
          </p>
        )}

        {grouped !== null && grouped.map(([kind, rows]) => (
          <div key={kind} className="space-y-2">
            <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest pt-2">
              {KIND_LABELS[kind] ?? kind} <span className="font-normal text-muted-foreground/60">({rows.length})</span>
            </h3>
            <div className="space-y-2">
              {rows.map((engine) => (
                <EngineCard
                  key={engine.id}
                  engine={engine}
                  archived={tab === "archived"}
                  onChanged={handleChanged}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </AdminLayout>
  );
}
