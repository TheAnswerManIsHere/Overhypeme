/**
 * Step 2 (video) orchestrator.
 *
 * Layout (top to bottom):
 *   - LockedVideoPreview (sticky)
 *   - VideoSourcePanel (the visible source picker)
 *   - Advanced options trigger (opens VideoAdvancedOptionsSheet)
 *   - Primary action button (rendered by the parent shell)
 *
 * When the user taps the primary action, we POST /api/memes/video-jobs and
 * mount GodModeLoadingTakeover (a sibling, full-screen overlay) which owns
 * the rest of the flow.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { AspectRatio, MyImageSource, ViewerContext } from "../../types";
import type { VideoSourceMode } from "../state/wizardStorage";
import type { WizardRuntimeState } from "../state/useWizardState";
import { useVideoCatalogue } from "./data/useVideoCatalogue";
import type { VideoCatalogueOverrides } from "./data/useVideoCatalogue";
import { LockedVideoPreview } from "./LockedVideoPreview";
import { AspectRatioToggle } from "./AspectRatioToggle";
import { VideoSourcePanel } from "./VideoSourcePanel";
import { VideoAdvancedOptionsSheet, type VideoAdvancedOptionsValue } from "./VideoAdvancedOptionsSheet";
import { GodModeLoadingTakeover, type VideoJobApi, type VideoJobStatus } from "./GodModeLoadingTakeover";
import { buildVideoJobPayload } from "./util/saveVideoMemePayload";
import {
  resolveSourceImagePath,
  storageUrlFor,
} from "./util/resolveSourceImagePath";
import { DEFAULT_LOOK_STYLE_ID } from "./aiStylePresets";

interface Step2VideoProps {
  factId: string;
  factText: string;
  viewerContext: ViewerContext;
  state: WizardRuntimeState;
  dispatch: React.Dispatch<{
    type:
      | "set-source"
      | "set-aspect-ratio"
      | "set-video-source-mode"
      | "set-video-look-style-id"
      | "set-video-motion-preset-id"
      | "set-video-engine-id"
      | "set-video-engine-mode"
      | "set-video-custom-mode-prompt"
      | "set-video-override-look"
      | "set-advanced-options";
    // We use an `any`-like body here because the discriminated union for
    // wizard actions is too narrow to type as a single union of props.
    // Step2Video calls dispatch with full action shapes (see below).
    [key: string]: unknown;
  }>;
  onComplete: (permalinkUrl: string) => void;
  onCancel: () => void;
  /** Test seam: inject mock fetchers for the catalogue. */
  catalogueOverrides?: VideoCatalogueOverrides;
  /** Test seam: inject a mock API client. */
  apiOverride?: VideoJobApi;
}

export function Step2Video(props: Step2VideoProps) {
  const {
    factId,
    factText,
    viewerContext,
    state,
    dispatch,
    onComplete,
    onCancel,
    catalogueOverrides,
    apiOverride,
  } = props;
  void factText;

  const { lookStyles, motionPresets, engines, loading: catalogueLoading } = useVideoCatalogue(catalogueOverrides);

  const advanced = state.advancedOptions ?? {};

  // Resolve the default engine once the catalogue is in. We seed advancedOptions
  // with the server-default values so the rest of the UI has something to read.
  useEffect(() => {
    if (catalogueLoading || engines.length === 0) return;
    const defaultEngine = engines.find((e) => e.isDefault) ?? engines[0];
    const patch: Record<string, unknown> = {};
    if (!advanced.videoEngineId) {
      patch.videoEngineId = defaultEngine.id;
    }
    if (!advanced.videoLengthSeconds) {
      patch.videoLengthSeconds = defaultEngine.defaultDurationSec;
    }
    if (!advanced.videoResolution) {
      patch.videoResolution = defaultEngine.defaultResolution;
    }
    if (!advanced.videoSourceMode) {
      patch.videoSourceMode = "stylize-then-video";
    }
    if (!advanced.videoLookStyleId) {
      patch.videoLookStyleId = DEFAULT_LOOK_STYLE_ID;
    }
    if (!advanced.videoEngineMode && defaultEngine.defaultMode) {
      patch.videoEngineMode = defaultEngine.defaultMode;
    }
    if (Object.keys(patch).length > 0) {
      dispatch({
        type: "set-advanced-options",
        advancedOptions: { ...advanced, ...patch },
      });
    }
    // Seed aspect ratio with the engine's default IF it's one of the three
    // wizard values. Veo's default is "auto" (not a wizard value), so we fall
    // back to portrait — vertical is the meme-native default and is in every
    // video engine's allowed set.
    if (!state.aspectRatio) {
      const seed = isWizardAspect(defaultEngine.defaultAspectRatio)
        ? defaultEngine.defaultAspectRatio
        : "portrait";
      dispatch({ type: "set-aspect-ratio", aspectRatio: seed });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogueLoading, engines.length]);

  const sourceMode: VideoSourceMode = advanced.videoSourceMode ?? "stylize-then-video";
  const lookStyleId = advanced.videoLookStyleId ?? DEFAULT_LOOK_STYLE_ID;
  const motionPresetId = advanced.videoMotionPresetId ?? null;
  const engineId = advanced.videoEngineId ?? engines[0]?.id ?? "";
  const engineMode = advanced.videoEngineMode;
  const customModePrompt = advanced.videoCustomModePrompt;
  const overrideLookForSource = advanced.videoOverrideLookForSource;
  const lengthSeconds = advanced.videoLengthSeconds ?? engines[0]?.defaultDurationSec ?? 6;
  const resolution = advanced.videoResolution ?? engines[0]?.defaultResolution ?? "480p";
  const aspectRatio: AspectRatio = state.aspectRatio ?? "portrait";

  // Aspect choices the selected engine actually accepts (the DTO speaks wizard
  // values; non-wizard entries like "auto"/"4:3" are filtered out). Veo Lite,
  // for example, allows only landscape + portrait — no square.
  const selectedEngine = engines.find((e) => e.id === engineId);
  const allowedAspects = useMemo<AspectRatio[]>(() => {
    const raw = selectedEngine?.allowedAspectRatios ?? [];
    const filtered = raw.filter(isWizardAspect);
    return filtered.length > 0 ? filtered : ["landscape", "square", "portrait"];
  }, [selectedEngine]);

  // If the engine changes and no longer allows the current aspect, coerce to a
  // supported one so we never submit an aspect the engine will reject.
  useEffect(() => {
    if (state.aspectRatio && !allowedAspects.includes(state.aspectRatio)) {
      dispatch({ type: "set-aspect-ratio", aspectRatio: allowedAspects[0] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedAspects, state.aspectRatio]);

  // Normalized crop focus for drag-to-reposition. Local to this screen (the
  // takeover mounts immediately after submit), and reset to centre whenever the
  // source image or target aspect changes — a new crop window invalidates the
  // old focus.
  const [framingFocus, setFramingFocus] = useState<{ x: number; y: number }>({ x: 0.5, y: 0.5 });
  const sourcePathForReset = state.source?.kind === "self-upload"
    ? resolveSourceImagePath(state.source.image)
    : null;
  useEffect(() => {
    setFramingFocus({ x: 0.5, y: 0.5 });
  }, [sourcePathForReset, aspectRatio]);

  const handleAspectChange = useCallback(
    (next: AspectRatio) => {
      dispatch({ type: "set-aspect-ratio", aspectRatio: next });
    },
    [dispatch],
  );

  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Resolve a preview URL for the picked source.
  const previewUrl = useMemo(() => {
    const src = state.source;
    if (!src || src.kind !== "self-upload") return null;
    const path = resolveSourceImagePath(src.image);
    return path ? storageUrlFor(path) : null;
  }, [state.source]);

  const sourceKind =
    state.source?.kind === "self-upload" ? state.source.image.kind : null;
  const sourceIsAiStyling = sourceKind === "ai-styling";

  const styleLabel = lookStyles.find((s) => s.id === lookStyleId)?.label;
  const motionLabel = motionPresets.find((p) => p.id === motionPresetId)?.label
    ?? (motionPresetId === null ? "Default" : undefined);

  // ─── Source picker → state.source dispatch ───
  const handleSourceSelect = useCallback(
    (img: MyImageSource) => {
      dispatch({
        type: "set-source",
        source: { kind: "self-upload", image: img, stylizeWithAi: sourceMode === "stylize-then-video" },
      });
      // Auto-sync sourceMode to the kind of image the user just picked.
      // AI styling images implicitly use the "use-existing-ai-image" path;
      // switching away from an AI styling reverts to "stylize-then-video".
      if (img.kind === "ai-styling" && sourceMode !== "use-existing-ai-image") {
        dispatch({ type: "set-video-source-mode", videoSourceMode: "use-existing-ai-image" });
      } else if (img.kind !== "ai-styling" && sourceMode === "use-existing-ai-image") {
        dispatch({ type: "set-video-source-mode", videoSourceMode: "stylize-then-video" });
      }
    },
    [dispatch, sourceMode],
  );

  // ─── Advanced options patch handler ───
  const applyAdvancedPatch = useCallback(
    (patch: Partial<VideoAdvancedOptionsValue>) => {
      if (patch.sourceMode !== undefined) {
        dispatch({ type: "set-video-source-mode", videoSourceMode: patch.sourceMode });
      }
      if (patch.lookStyleId !== undefined) {
        dispatch({ type: "set-video-look-style-id", videoLookStyleId: patch.lookStyleId });
      }
      if (patch.motionPresetId !== undefined) {
        dispatch({ type: "set-video-motion-preset-id", videoMotionPresetId: patch.motionPresetId });
      }
      if (patch.lengthSeconds !== undefined) {
        dispatch({
          type: "set-advanced-options",
          advancedOptions: { ...advanced, videoLengthSeconds: patch.lengthSeconds },
        });
      }
      if (patch.resolution !== undefined) {
        dispatch({
          type: "set-advanced-options",
          advancedOptions: { ...advanced, videoResolution: patch.resolution },
        });
      }
      if (patch.engineId !== undefined) {
        dispatch({ type: "set-video-engine-id", videoEngineId: patch.engineId });
      }
      if (patch.engineMode !== undefined) {
        dispatch({ type: "set-video-engine-mode", videoEngineMode: patch.engineMode });
      }
      if (patch.customModePrompt !== undefined) {
        dispatch({ type: "set-video-custom-mode-prompt", videoCustomModePrompt: patch.customModePrompt });
      }
      if (patch.overrideLookForSource !== undefined) {
        dispatch({ type: "set-video-override-look", videoOverrideLookForSource: patch.overrideLookForSource });
      }
    },
    [dispatch, advanced],
  );

  // ─── Job lifecycle ───
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const factIdNum = useMemo(() => {
    const n = Number.parseInt(factId, 10);
    return Number.isFinite(n) ? n : factId;
  }, [factId]);

  const sourceReady =
    state.source?.kind === "self-upload" &&
    !!resolveSourceImagePath(state.source.image);

  const handleSubmit = useCallback(async () => {
    if (!state.source || state.source.kind !== "self-upload") return;
    const sourceImagePath = resolveSourceImagePath(state.source.image);
    if (!sourceImagePath) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const payload = buildVideoJobPayload({
        factId: typeof factIdNum === "number" ? factIdNum : 0,
        sourceMode,
        sourceImagePath,
        lookStyleId,
        motionPresetId,
        videoEngineId: engineId,
        engineMode,
        customModePrompt,
        lengthSeconds,
        resolution,
        aspectRatio,
        framingFocus,
        name: state.name ?? viewerContext.name,
        pronouns: state.pronouns ?? viewerContext.pronouns,
      });

      const res = await fetch("/api/memes/video-jobs", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        // Best-effort error parsing.
        let body: { error?: string; resetDate?: string } = {};
        try {
          body = await res.json();
        } catch {
          // ignore
        }
        if (res.status === 429 && body.error === "BUDGET_EXCEEDED") {
          setSubmitError(`BUDGET_EXCEEDED:${body.resetDate ?? ""}`);
          return;
        }
        setSubmitError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { jobId: string };
      setJobId(data.jobId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [
    aspectRatio,
    framingFocus,
    customModePrompt,
    engineId,
    engineMode,
    factIdNum,
    lengthSeconds,
    lookStyleId,
    motionPresetId,
    resolution,
    sourceMode,
    state.name,
    state.pronouns,
    state.source,
    viewerContext.name,
    viewerContext.pronouns,
  ]);

  const defaultApi: VideoJobApi = useMemo(() => makeDefaultVideoJobApi(), []);
  const api = apiOverride ?? defaultApi;

  // If we got a budget-exceeded error at POST time, surface the locked
  // budget screen without ever creating a real job. We model it as a
  // synthetic "failed" status fed to the takeover.
  const budgetError = submitError?.startsWith("BUDGET_EXCEEDED:")
    ? { resetDate: submitError.slice("BUDGET_EXCEEDED:".length) }
    : null;

  if (budgetError) {
    return (
      <div className="fixed inset-0 z-[60] flex flex-col bg-[#0a0a0a] text-white" data-testid="step2-video-budget-locked">
        {/* Use the same screen the takeover uses for symmetry. */}
        <div className="flex-1 overflow-y-auto overscroll-y-none">
          <BudgetLockedFallback resetDate={budgetError.resetDate} onGoBack={() => { setSubmitError(null); }} />
        </div>
      </div>
    );
  }

  if (jobId) {
    return (
      <GodModeLoadingTakeover
        jobId={jobId}
        aspectRatio={aspectRatio}
        currentLookStyleId={lookStyleId}
        lookStyles={lookStyles}
        bypassedStage1={sourceMode !== "stylize-then-video"}
        api={api}
        onComplete={onComplete}
        onCancel={() => {
          setJobId(null);
          onCancel();
        }}
        onGoBack={() => setJobId(null)}
      />
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="step2-video">
      {/* Preview is locked outside the scroll container — it never scrolls. */}
      <LockedVideoPreview
        sourceUrl={previewUrl}
        aspectRatio={aspectRatio}
        framingFocus={framingFocus}
        onFramingChange={setFramingFocus}
        summary={{
          styleLabel,
          motionLabel,
          lengthSec: lengthSeconds,
          resolution,
        }}
      />

      {/* Controls scroll under the preview; flex-1 fills whatever height remains. */}
      <div className="flex-1 overflow-y-auto overscroll-y-none">
        <div className="mx-auto max-w-md space-y-4 px-5 pt-4 pb-32">
          <header className="text-center">
            <p className="font-mono text-[11px] uppercase tracking-widest text-white/50">
              Step 1 of 2:
            </p>
            <h1 className="text-white text-2xl font-[Bebas_Neue,sans-serif] tracking-wide uppercase mt-0.5">
              Pick a photo, choose your options.
            </h1>
          </header>

          <VideoSourcePanel
            factId={factId}
            sourceMode={sourceMode}
            selected={
              state.source?.kind === "self-upload" ? state.source.image : null
            }
            onSelect={handleSourceSelect}
          />

          <div className="space-y-2">
            <p className="font-mono text-[11px] uppercase tracking-widest text-white/50">
              Output shape
            </p>
            <AspectRatioToggle
              value={aspectRatio}
              onChange={handleAspectChange}
              allowed={allowedAspects}
            />
            <p className="text-[11px] leading-snug text-white/40">
              Your photo is stylized at this shape, and the video inherits it.
              Drag the preview above to reposition.
            </p>
          </div>

          <div className="flex flex-col gap-2 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setAdvancedOpen(true)}
              data-testid="step2-video-open-advanced"
            >
              Advanced options
            </Button>

            <Button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!sourceReady || submitting}
              isLoading={submitting}
              data-testid="step2-video-make-meme"
            >
              Make my meme
            </Button>

            {submitError && !budgetError && (
              <p className="text-center text-xs text-destructive" data-testid="step2-video-error">
                {submitError}
              </p>
            )}
          </div>
        </div>
      </div>

      <VideoAdvancedOptionsSheet
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        value={{
          sourceMode,
          lookStyleId,
          motionPresetId,
          lengthSeconds,
          resolution,
          engineId,
          engineMode,
          customModePrompt,
          overrideLookForSource,
        }}
        onChange={applyAdvancedPatch}
        lookStyles={lookStyles}
        motionPresets={motionPresets}
        engines={engines}
        sourceKind={sourceKind}
      />
    </div>
  );
}

const WIZARD_ASPECTS: readonly AspectRatio[] = ["landscape", "square", "portrait"];

/** True when a value is one of the three wizard aspect ratios (filters "auto" etc.). */
function isWizardAspect(value: unknown): value is AspectRatio {
  return typeof value === "string" && WIZARD_ASPECTS.includes(value as AspectRatio);
}

function BudgetLockedFallback({ resetDate, onGoBack }: { resetDate: string; onGoBack: () => void }) {
  // Same copy as VideoBudgetExceededScreen — inlined to avoid a redundant
  // import cycle through the takeover. The takeover screen is the canonical
  // version; this is the pre-job synchronous variant.
  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-6 text-center">
      <div className="max-w-sm space-y-4">
        <h2 className="font-display text-3xl uppercase tracking-wide">
          You've out-legended your monthly budget.
        </h2>
        <p className="text-white/70">
          Your reset is {resetDate}. Come back wilder.
        </p>
        <Button type="button" variant="secondary" onClick={onGoBack}>
          Go back
        </Button>
      </div>
    </div>
  );
}

/**
 * Default fetch-based implementation of the VideoJobApi. Each method is a
 * thin wrapper around the documented server contract.
 */
function makeDefaultVideoJobApi(): VideoJobApi {
  return {
    async poll(jobId) {
      const res = await fetch(`/api/memes/video-jobs/${jobId}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`poll: ${res.status}`);
      return (await res.json()) as VideoJobStatus;
    },
    async proceed(jobId) {
      const res = await fetch(`/api/memes/video-jobs/${jobId}/proceed`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`proceed: ${res.status}`);
    },
    async regenerate(jobId, lookStyleId) {
      const res = await fetch(`/api/memes/video-jobs/${jobId}/regenerate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lookStyleId ? { lookStyleId } : {}),
      });
      if (!res.ok) throw new Error(`regenerate: ${res.status}`);
    },
    async proceedWithNoFaceFallback(jobId) {
      const res = await fetch(
        `/api/memes/video-jobs/${jobId}/proceed-with-no-face-fallback`,
        { method: "POST", credentials: "include" },
      );
      if (!res.ok) throw new Error(`proceed-no-face: ${res.status}`);
    },
    async cancel(jobId) {
      const res = await fetch(`/api/memes/video-jobs/${jobId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`cancel: ${res.status}`);
      try {
        return (await res.json()) as { promotedStillObjectPath?: string };
      } catch {
        return {};
      }
    },
  };
}
