import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { Sparkles, Loader2, Upload, X, RefreshCw } from "lucide-react";
import { Link } from "wouter";
import { ImageCard } from "@/components/ui/ImageCard";
import { Button } from "@/components/ui/Button";
import { IMAGE_STYLES } from "@/config/imageStyles";
import type { AiMemeImages } from "@/components/MemeBuilder";

// ─── Shared admin constants (same as MemeBuilder) ────────────────────────────

const ADMIN_FAL_MODELS: { group: string; models: { value: string; label: string }[] }[] = [
  {
    group: "Standard (text-to-image)",
    models: [
      { value: "fal-ai/flux-pro/v1.1",       label: "FLUX Pro v1.1 (default standard)" },
      { value: "fal-ai/flux-pro/v1.1-ultra",  label: "FLUX Pro v1.1 Ultra" },
      { value: "fal-ai/flux-pro",             label: "FLUX Pro" },
      { value: "fal-ai/flux/dev",             label: "FLUX Dev" },
      { value: "fal-ai/flux/schnell",         label: "FLUX Schnell (fast)" },
      { value: "fal-ai/recraft-v3",           label: "Recraft V3" },
      { value: "fal-ai/ideogram/v2",          label: "Ideogram V2" },
      { value: "fal-ai/aura-flow",            label: "AuraFlow" },
    ],
  },
  {
    group: "Reference photo (face-preserving)",
    models: [
      { value: "fal-ai/flux-pulid",                label: "FLUX PuLID (default reference)" },
      { value: "fal-ai/ip-adapter-face-id-plus",   label: "IP-Adapter FaceID Plus" },
      { value: "fal-ai/flux-pro/v1.1",             label: "FLUX Pro v1.1 (no face ref)" },
    ],
  },
];

type AdminParamDef = {
  key: string;
  label: string;
  placeholder: string;
  type: "number" | "select";
  options?: { value: string; label: string }[];
};

const ADMIN_MODEL_PARAMS: Record<string, AdminParamDef[]> = {
  "fal-ai/flux-pro/v1.1": [
    { key: "num_inference_steps", label: "Inference Steps", placeholder: "28", type: "number" },
    { key: "guidance_scale",      label: "Guidance Scale",  placeholder: "3.5", type: "number" },
    { key: "safety_tolerance",    label: "Safety Tolerance (1–6)", placeholder: "2", type: "number" },
    { key: "output_format",       label: "Output Format",   placeholder: "jpeg", type: "select", options: [{ value: "", label: "default" }, { value: "jpeg", label: "jpeg" }, { value: "png", label: "png" }] },
    { key: "seed",                label: "Seed",            placeholder: "random", type: "number" },
  ],
  "fal-ai/flux-pro": [
    { key: "num_inference_steps", label: "Inference Steps", placeholder: "28", type: "number" },
    { key: "guidance_scale",      label: "Guidance Scale",  placeholder: "3.5", type: "number" },
    { key: "safety_tolerance",    label: "Safety Tolerance (1–6)", placeholder: "2", type: "number" },
    { key: "output_format",       label: "Output Format",   placeholder: "jpeg", type: "select", options: [{ value: "", label: "default" }, { value: "jpeg", label: "jpeg" }, { value: "png", label: "png" }] },
    { key: "seed",                label: "Seed",            placeholder: "random", type: "number" },
  ],
  "fal-ai/flux/dev": [
    { key: "num_inference_steps", label: "Inference Steps", placeholder: "28", type: "number" },
    { key: "guidance_scale",      label: "Guidance Scale",  placeholder: "3.5", type: "number" },
    { key: "output_format",       label: "Output Format",   placeholder: "jpeg", type: "select", options: [{ value: "", label: "default" }, { value: "jpeg", label: "jpeg" }, { value: "png", label: "png" }] },
    { key: "seed",                label: "Seed",            placeholder: "random", type: "number" },
  ],
  "fal-ai/flux/schnell": [
    { key: "num_inference_steps", label: "Inference Steps", placeholder: "4", type: "number" },
    { key: "output_format",       label: "Output Format",   placeholder: "jpeg", type: "select", options: [{ value: "", label: "default" }, { value: "jpeg", label: "jpeg" }, { value: "png", label: "png" }] },
    { key: "seed",                label: "Seed",            placeholder: "random", type: "number" },
  ],
  "fal-ai/flux-pro/v1.1-ultra": [
    { key: "aspect_ratio",     label: "Aspect Ratio",       placeholder: "1:1", type: "select", options: [{ value: "", label: "default" }, { value: "1:1", label: "1:1" }, { value: "16:9", label: "16:9" }, { value: "9:16", label: "9:16" }, { value: "4:3", label: "4:3" }, { value: "3:4", label: "3:4" }] },
    { key: "safety_tolerance", label: "Safety Tolerance (1–6)", placeholder: "2", type: "number" },
    { key: "output_format",    label: "Output Format",      placeholder: "jpeg", type: "select", options: [{ value: "", label: "default" }, { value: "jpeg", label: "jpeg" }, { value: "png", label: "png" }] },
    { key: "seed",             label: "Seed",               placeholder: "random", type: "number" },
  ],
  "fal-ai/flux-pulid": [
    { key: "id_scale",             label: "ID Scale (face similarity)",  placeholder: "0.70", type: "number" },
    { key: "guidance_scale",       label: "Guidance Scale",              placeholder: "5.5",  type: "number" },
    { key: "num_inference_steps",  label: "Inference Steps",             placeholder: "30",   type: "number" },
    { key: "true_cfg_scale",       label: "True CFG Scale",              placeholder: "off",  type: "number" },
    { key: "start_step",           label: "Start Step",                  placeholder: "off",  type: "number" },
  ],
};

const CLIENT_MAX_DIMENSION = 3600;
const CLIENT_JPEG_QUALITY = 0.9;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AiBgSelection {
  url: string;
  storagePath: string | null;
  label: string;
}

interface RefGenImage {
  id: number;
  storagePath: string;
  gender: string;
  createdAt: string;
}

interface UploadEntry {
  objectPath: string;
  width: number;
  height: number;
  isLowRes: boolean;
  fileSizeBytes: number;
  createdAt: string;
}

export interface AiBgPickerProps {
  factId: number;
  initialImages: AiMemeImages | null;
  aiGender: "male" | "female" | "neutral";
  isGendered: boolean;
  isPremium: boolean;
  isAdmin: boolean;
  onSelect: (selection: AiBgSelection | null) => void;
  /** Whether to show the style picker (AI generation style). Default: false */
  showStylePicker?: boolean;
  /** Initial selected style ID. Default: "none" */
  defaultStyleId?: string;
  /** Thumbnail pixel size for the image grids — controlled by the parent's slider. Default: 158 */
  thumbPx?: number;
}

// ─── Image pre-processor (same as MemeBuilder) ───────────────────────────────

async function preProcessImageFile(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { naturalWidth: w, naturalHeight: h } = img;
      const longestEdge = Math.max(w, h);
      if (longestEdge > CLIENT_MAX_DIMENSION) {
        const scale = CLIENT_MAX_DIMENSION / longestEdge;
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("Canvas unavailable")); return; }
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (blob) => {
          if (!blob) { reject(new Error("Image encoding failed")); return; }
          resolve({ blob, width: w, height: h });
        },
        "image/jpeg",
        CLIENT_JPEG_QUALITY,
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to load image")); };
    img.src = url;
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AiBgPicker({
  factId,
  initialImages,
  aiGender,
  isGendered,
  isPremium,
  isAdmin,
  onSelect,
  showStylePicker = false,
  defaultStyleId = "none",
  thumbPx = 158,
}: AiBgPickerProps) {

  // ── Config from server ──────────────────────────────────────────────────────
  const [aiGalleryDisplayLimit, setAiGalleryDisplayLimit] = useState(100);
  const [aiModelStandard, setAiModelStandard] = useState("fal-ai/flux-pro/v1.1");
  const [aiModelReference, setAiModelReference] = useState("fal-ai/flux-pulid");

  useEffect(() => {
    fetch("/api/config")
      .then(r => r.json())
      .then((cfg: Record<string, number | string | boolean>) => {
        const limit = cfg["ai_gallery_display_limit"];
        if (typeof limit === "number" && limit > 0) setAiGalleryDisplayLimit(limit);
        const std = cfg["ai_image_model_standard"];
        if (typeof std === "string" && std) setAiModelStandard(std);
        const ref = cfg["ai_image_model_reference"];
        if (typeof ref === "string" && ref) setAiModelReference(ref);
      })
      .catch(() => {});
  }, []);

  // ── AI image state ──────────────────────────────────────────────────────────
  const [localImages, setLocalImages] = useState<AiMemeImages | null>(initialImages ?? null);
  const [selectedAiIndex, setSelectedAiIndex] = useState<number | null>(null);
  const [aiCacheBuster, setAiCacheBuster] = useState(0);

  useEffect(() => { setLocalImages(initialImages ?? null); }, [initialImages]);

  const aiImageSlots = useMemo<Array<{ path: string; origIdx: number }>>(() => {
    if (!localImages) return [];
    const arr = localImages[aiGender] ?? [];
    const slots: Array<{ path: string; origIdx: number }> = [];
    for (let i = 0; i < arr.length && slots.length < aiGalleryDisplayLimit; i++) {
      if (arr[i]) slots.push({ path: arr[i], origIdx: i });
    }
    return slots;
  }, [localImages, aiGender, aiGalleryDisplayLimit]);

  // Auto-select first image on mount / when images change
  useEffect(() => {
    if (aiImageSlots.length > 0 && selectedAiIndex === null) {
      const first = aiImageSlots[0]!;
      setSelectedAiIndex(first.origIdx);
    }
  }, [aiImageSlots, selectedAiIndex]);

  const getGenericUrl = useCallback((origIdx: number) => {
    const cb = aiCacheBuster ? `&cb=${aiCacheBuster}` : "";
    return `/api/memes/ai/${factId}/image?gender=${aiGender}&imageIndex=${origIdx}&raw=true${cb}`;
  }, [factId, aiGender, aiCacheBuster]);

  // ── Sub-mode: generic / reference ──────────────────────────────────────────
  const [aiSubMode, setAiSubMode] = useState<"generic" | "reference">("generic");

  // ── Reference-generated images ─────────────────────────────────────────────
  const [refGenImages, setRefGenImages] = useState<RefGenImage[]>([]);
  const [isLoadingRefGenImages, setIsLoadingRefGenImages] = useState(false);
  const [selectedRefGenPath, setSelectedRefGenPath] = useState<string | null>(null);

  const getRefUrl = useCallback((storagePath: string) => {
    const cb = aiCacheBuster ? `&cb=${aiCacheBuster}` : "";
    return `/api/memes/ai-user/image?storagePath=${encodeURIComponent(storagePath)}${cb}`;
  }, [aiCacheBuster]);

  const fetchRefGenImages = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch(`/api/users/me/ai-images?factId=${factId}&imageType=reference`, {
      credentials: "include",
      signal,
    });
    if (!res.ok) return null;
    const data = await res.json() as { images: RefGenImage[] };
    return data.images;
  }, [factId]);

  useEffect(() => {
    if (!isPremium || aiSubMode !== "reference") return;
    const controller = new AbortController();
    setIsLoadingRefGenImages(true);
    fetchRefGenImages(controller.signal)
      .then(images => { if (images) setRefGenImages(images); })
      .catch(() => {})
      .finally(() => setIsLoadingRefGenImages(false));
    return () => { controller.abort(); };
  }, [isPremium, aiSubMode, fetchRefGenImages]);

  // ── Reference photo uploads ─────────────────────────────────────────────────
  const [refUploads, setRefUploads] = useState<UploadEntry[]>([]);
  const [selectedRefUpload, setSelectedRefUpload] = useState<UploadEntry | null>(null);
  const [isLoadingRefUploads, setIsLoadingRefUploads] = useState(false);
  const [isUploadingRefPhoto, setIsUploadingRefPhoto] = useState(false);
  const refFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isPremium || aiSubMode !== "reference") return;
    let cancelled = false;
    setIsLoadingRefUploads(true);
    fetch("/api/users/me/uploads", { credentials: "include" })
      .then(r => r.json())
      .then((data: { uploads?: UploadEntry[] }) => {
        if (!cancelled) setRefUploads(data.uploads ?? []);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setIsLoadingRefUploads(false); });
    return () => { cancelled = true; };
  }, [isPremium, aiSubMode]);

  const handleRefPhotoUpload = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    setIsUploadingRefPhoto(true);
    try {
      let uploadBlob: Blob = file;
      try {
        const processed = await preProcessImageFile(file);
        uploadBlob = processed.blob;
      } catch { /* use original */ }
      const uploadRes = await fetch("/api/storage/upload-meme", {
        method: "POST",
        headers: { "Content-Type": "image/jpeg" },
        body: uploadBlob,
      });
      if (!uploadRes.ok) {
        const errBody = await uploadRes.json() as { error?: string };
        throw new Error(errBody.error ?? "Upload failed");
      }
      const result = await uploadRes.json() as { objectPath: string; width?: number; height?: number; isLowRes?: boolean };
      const newEntry: UploadEntry = {
        objectPath: result.objectPath,
        width: result.width ?? 0,
        height: result.height ?? 0,
        isLowRes: result.isLowRes ?? false,
        fileSizeBytes: 0,
        createdAt: new Date().toISOString(),
      };
      setRefUploads(prev => [newEntry, ...prev]);
      setSelectedRefUpload(newEntry);
    } catch (e) {
      setAiGenerateError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setIsUploadingRefPhoto(false);
    }
  }, []);

  // ── Style picker ────────────────────────────────────────────────────────────
  const [selectedStyleId, setSelectedStyleId] = useState(defaultStyleId);

  // ── Admin overrides ─────────────────────────────────────────────────────────
  const [adminModelOverride, setAdminModelOverride] = useState("");
  const [adminParamOverrides, setAdminParamOverrides] = useState<Record<string, string>>({});
  useEffect(() => { setAdminParamOverrides({}); }, [adminModelOverride]);

  // ── Generation state ────────────────────────────────────────────────────────
  const [aiGenState, setAiGenState] = useState<"idle" | "generating" | "completed" | "error">("idle");
  const isGenerating = aiGenState === "generating";
  const [aiGenerateError, setAiGenerateError] = useState<string | null>(null);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [generationElapsed, setGenerationElapsed] = useState(0);
  const [cancelDisabled, setCancelDisabled] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const generationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const generationIdRef = useRef(0);

  useEffect(() => {
    return () => {
      if (generationTimerRef.current) clearInterval(generationTimerRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, []);

  // ── Admin scene prompt debug ────────────────────────────────────────────────
  const [sceneDebug, setSceneDebug] = useState<{
    prompts: Record<string, string> | null;
    styleSuffix: string | null;
    falCallPreview: { model: string; input: Record<string, unknown> } | null;
  } | null>(null);
  const [showPromptDebug, setShowPromptDebug] = useState(false);
  const [isRefreshingScene, setIsRefreshingScene] = useState(false);
  const [scenePromptVersion, setScenePromptVersion] = useState(0);

  useEffect(() => {
    if (!isAdmin || !factId) return;
    if (aiGenState === "generating") return;
    const params = new URLSearchParams({
      styleId: selectedStyleId,
      gender: aiGender,
      ...(adminModelOverride.trim() ? { modelOverride: adminModelOverride.trim() } : {}),
      ...(Object.keys(adminParamOverrides).some(k => adminParamOverrides[k] !== "")
        ? { paramsOverride: JSON.stringify(Object.fromEntries(Object.entries(adminParamOverrides).filter(([, v]) => v !== ""))) }
        : {}),
    });
    fetch(`/api/memes/ai/${factId}/prompts?${params.toString()}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((d: { prompts: Record<string, string> | null; styleSuffix: string | null; falCallPreview: { model: string; input: Record<string, unknown> } | null } | null) => {
        if (d) setSceneDebug({ prompts: d.prompts, styleSuffix: d.styleSuffix, falCallPreview: d.falCallPreview });
      })
      .catch(() => {});
  }, [isAdmin, factId, selectedStyleId, aiGender, aiSubMode, aiGenState, scenePromptVersion, adminModelOverride, adminParamOverrides]);

  const handleRefreshScene = useCallback(async () => {
    if (isRefreshingScene) return;
    setIsRefreshingScene(true);
    try {
      const res = await fetch(`/api/memes/ai/${factId}/regenerate-scene-prompts`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) setScenePromptVersion(v => v + 1);
    } catch { /* ignore */ }
    finally { setIsRefreshingScene(false); }
  }, [factId, isRefreshingScene]);

  // ── Cancel generation ───────────────────────────────────────────────────────
  const handleCancel = () => {
    setCancelDisabled(true);
    if (abortControllerRef.current) { abortControllerRef.current.abort(); abortControllerRef.current = null; }
    generationIdRef.current += 1;
    if (generationTimerRef.current) { clearInterval(generationTimerRef.current); generationTimerRef.current = null; }
    setAiGenState("idle");
    setGenerationProgress(0);
    setGenerationElapsed(0);
    setTimeout(() => setCancelDisabled(false), 200);
  };

  // ── Delete generic image ────────────────────────────────────────────────────
  const handleDeleteGenericImage = async (origIdx: number) => {
    const res = await fetch(
      `/api/memes/ai/${factId}/image?gender=${aiGender}&imageIndex=${origIdx}`,
      { method: "DELETE", credentials: "include" }
    );
    if (!res.ok) {
      const body = await res.json() as { error?: string };
      throw new Error(body.error ?? "Delete failed");
    }
    setLocalImages(prev => {
      if (!prev) return prev;
      const arr = [...(prev[aiGender] ?? [])];
      arr[origIdx] = "";
      return { ...prev, [aiGender]: arr };
    });
    if (selectedAiIndex === origIdx) {
      setSelectedAiIndex(null);
      onSelect(null);
    }
  };

  // ── Notify parent on selection changes ─────────────────────────────────────
  useEffect(() => {
    if (aiSubMode === "generic") {
      if (selectedAiIndex === null) { onSelect(null); return; }
      const storagePath = localImages?.[aiGender]?.[selectedAiIndex] ?? null;
      const url = getGenericUrl(selectedAiIndex);
      if (storagePath) onSelect({ url, storagePath, label: "AI background" });
      else onSelect(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiSubMode, selectedAiIndex, localImages, aiGender]);

  useEffect(() => {
    if (aiSubMode === "reference") {
      if (!selectedRefGenPath) { onSelect(null); return; }
      const url = getRefUrl(selectedRefGenPath);
      onSelect({ url, storagePath: selectedRefGenPath, label: "AI reference background" });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiSubMode, selectedRefGenPath]);

  // ── Generate new AI images ──────────────────────────────────────────────────
  const handleGenerate = async () => {
    if (isGenerating) return;
    if (aiSubMode === "reference" && !selectedRefUpload) {
      setAiGenerateError("Select a reference photo below before generating.");
      return;
    }

    if (abortControllerRef.current) abortControllerRef.current.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const myId = generationIdRef.current + 1;
    generationIdRef.current = myId;

    setAiGenState("generating");
    setAiGenerateError(null);
    setGenerationProgress(0);
    setGenerationElapsed(0);

    const startTime = Date.now();
    if (generationTimerRef.current) clearInterval(generationTimerRef.current);
    generationTimerRef.current = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      setGenerationElapsed(Math.floor(elapsed));
      let progress: number;
      if (elapsed <= 30) progress = (elapsed / 30) * 80;
      else { const extra = elapsed - 30; progress = 80 + 19 * (1 - Math.exp(-extra / 60)); }
      setGenerationProgress(Math.min(progress, 99));
    }, 250);

    const POLL_INTERVAL = 4_000;
    const MAX_POLLS = 22;

    try {
      let baselineRefCount = 0;
      let baselineSlotPath: string | null = null;
      let baselineUpdatedAt: string | null = null;

      if (aiSubMode === "reference") {
        const baseline = await fetchRefGenImages().catch(() => null) ?? [];
        baselineRefCount = baseline.filter(img => img.gender === aiGender).length;
      } else {
        try {
          const initRes = await fetch(`/api/facts/${factId}`, { credentials: "include", cache: "no-store" });
          if (initRes.ok) {
            const init = await initRes.json() as { updatedAt?: string; aiMemeImages?: AiMemeImages | null };
            baselineSlotPath = init.aiMemeImages?.[aiGender]?.[0] ?? null;
            baselineUpdatedAt = init.updatedAt ?? null;
          }
        } catch { /* proceed without baseline */ }
      }

      const res = await fetch(`/api/memes/ai/${factId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({
          ...(aiSubMode === "reference" && selectedRefUpload
            ? { referenceImagePath: selectedRefUpload.objectPath, targetGender: aiGender, styleId: selectedStyleId }
            : { scope: isGendered ? "gendered" : "abstract", styleId: selectedStyleId }),
          ...(isAdmin && adminModelOverride.trim() ? { modelOverride: adminModelOverride.trim() } : {}),
          ...(isAdmin && Object.keys(adminParamOverrides).some(k => adminParamOverrides[k] !== "")
            ? { paramsOverride: Object.fromEntries(Object.entries(adminParamOverrides).filter(([, v]) => v !== "")) }
            : {}),
        }),
      });

      if (generationIdRef.current !== myId) return;

      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? "Generation failed");
      }

      if (aiSubMode === "reference") {
        let polls = 0;
        const pollRef = async () => {
          if (generationIdRef.current !== myId) return;
          polls++;
          try {
            const images = await fetchRefGenImages();
            if (images) {
              const newCount = images.filter(img => img.gender === aiGender).length;
              if (newCount > baselineRefCount) {
                if (generationIdRef.current !== myId) return;
                if (generationTimerRef.current) { clearInterval(generationTimerRef.current); generationTimerRef.current = null; }
                abortControllerRef.current = null;
                setRefGenImages(images);
                const newest = images.find(img => img.gender === aiGender);
                if (newest) setSelectedRefGenPath(newest.storagePath);
                setAiCacheBuster(Date.now());
                setGenerationProgress(100);
                setTimeout(() => {
                  if (generationIdRef.current !== myId) return;
                  setAiGenState("completed");
                  setGenerationProgress(0);
                  setGenerationElapsed(0);
                }, 400);
                fetch(`/api/memes/ai/${factId}/prompts`, { credentials: "include" })
                  .then(r => r.ok ? r.json() : null)
                  .then((d: { prompts: Record<string, string> | null; falCallPreview?: { model: string; input: Record<string, unknown> } | null } | null) => {
                    if (d?.prompts) setSceneDebug(prev => ({ ...prev!, prompts: d.prompts!, falCallPreview: d.falCallPreview ?? prev?.falCallPreview ?? null }));
                  }).catch(() => {});
                return;
              }
            }
          } catch { /* keep polling */ }
          if (polls >= MAX_POLLS) {
            if (generationIdRef.current !== myId) return;
            if (generationTimerRef.current) { clearInterval(generationTimerRef.current); generationTimerRef.current = null; }
            setGenerationProgress(0);
            setGenerationElapsed(0);
            setAiGenerateError("Generation is taking longer than expected. Try again.");
            setAiGenState("error");
            return;
          }
          setTimeout(() => void pollRef(), POLL_INTERVAL);
        };
        setTimeout(() => void pollRef(), POLL_INTERVAL);
      } else {
        let polls = 0;
        const poll = async () => {
          if (generationIdRef.current !== myId) return;
          polls++;
          try {
            const factRes = await fetch(`/api/facts/${factId}`, { credentials: "include", cache: "no-store" });
            if (factRes.ok) {
              const data = await factRes.json() as { updatedAt?: string; aiMemeImages?: AiMemeImages | null };
              const newSlotPath = data.aiMemeImages?.[aiGender]?.[0] ?? null;
              const newUpdatedAt = data.updatedAt ?? null;
              const done = baselineSlotPath === null
                ? newSlotPath !== null
                : newUpdatedAt !== baselineUpdatedAt && newSlotPath !== null;
              if (done) {
                if (generationIdRef.current !== myId) return;
                if (generationTimerRef.current) { clearInterval(generationTimerRef.current); generationTimerRef.current = null; }
                abortControllerRef.current = null;
                setGenerationProgress(100);
                setLocalImages(data.aiMemeImages ?? null);
                setSelectedAiIndex(0);
                setAiCacheBuster(Date.now());
                setTimeout(() => {
                  if (generationIdRef.current !== myId) return;
                  setAiGenState("completed");
                  setGenerationProgress(0);
                  setGenerationElapsed(0);
                }, 400);
                fetch(`/api/memes/ai/${factId}/prompts`, { credentials: "include" })
                  .then(r => r.ok ? r.json() : null)
                  .then((d: { prompts: Record<string, string> | null; falCallPreview?: { model: string; input: Record<string, unknown> } | null } | null) => {
                    if (d?.prompts) setSceneDebug(prev => ({ ...prev!, prompts: d.prompts!, falCallPreview: d.falCallPreview ?? prev?.falCallPreview ?? null }));
                  }).catch(() => {});
                return;
              }
            }
          } catch { /* keep polling */ }
          if (polls >= MAX_POLLS) {
            if (generationIdRef.current !== myId) return;
            if (generationTimerRef.current) { clearInterval(generationTimerRef.current); generationTimerRef.current = null; }
            setGenerationProgress(0);
            setGenerationElapsed(0);
            setAiGenerateError("Generation is taking longer than expected. Try again.");
            setAiGenState("error");
            return;
          }
          setTimeout(() => void poll(), POLL_INTERVAL);
        };
        setTimeout(() => void poll(), POLL_INTERVAL);
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      if (generationIdRef.current !== myId) return;
      if (generationTimerRef.current) { clearInterval(generationTimerRef.current); generationTimerRef.current = null; }
      setGenerationProgress(0);
      setGenerationElapsed(0);
      setAiGenerateError(e instanceof Error ? e.message : "Generation failed");
      setAiGenState("error");
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (!isPremium) {
    return (
      <div className="border-2 border-dashed border-amber-400/30 bg-amber-400/5 p-5 text-center space-y-2">
        <Sparkles className="w-6 h-6 text-amber-400 mx-auto" />
        <p className="text-sm font-bold text-amber-400 uppercase tracking-wider">Legendary Feature</p>
        <p className="text-xs text-muted-foreground">AI-generated backgrounds require a Legendary membership.</p>
        <Link href="/pricing">
          <Button size="sm" className="mt-2">Go Legendary</Button>
        </Link>
      </div>
    );
  }

  const myRefImages = refGenImages.filter(img => img.gender === aiGender);

  return (
    <div className="space-y-3">
      {/* Sub-mode toggle: Generic / Reference Photo */}
      <div className="flex gap-1 p-0.5 bg-muted/40 rounded-sm">
        <button
          onClick={() => { setAiSubMode("generic"); setAiGenerateError(null); }}
          className={`flex-1 text-[10px] font-display uppercase tracking-widest py-1 rounded-sm transition-colors ${
            aiSubMode === "generic" ? "bg-violet-500 text-white" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Generic
        </button>
        <button
          onClick={() => { setAiSubMode("reference"); setAiGenerateError(null); }}
          className={`flex-1 text-[10px] font-display uppercase tracking-widest py-1 rounded-sm transition-colors ${
            aiSubMode === "reference" ? "bg-violet-500 text-white" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Reference Photo
        </button>
      </div>

      {/* Generic sub-mode: fact-level AI backgrounds */}
      {aiSubMode === "generic" && (
        aiImageSlots.length > 0 ? (
          <>
            <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              AI backgrounds for this fact
              <span className="ml-1 text-primary">({aiGender})</span>
            </p>
            <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbPx}px, 1fr))` }}>
              {aiImageSlots.map((slot, displayIdx) => (
                <ImageCard
                  key={slot.path}
                  src={getGenericUrl(slot.origIdx)}
                  alt={`AI option ${displayIdx + 1}`}
                  aspectRatio="aspect-video"
                  selected={selectedAiIndex === slot.origIdx}
                  onSelect={() => setSelectedAiIndex(slot.origIdx)}
                  compact
                  actions={["delete", "openFull"]}
                  onDelete={() => handleDeleteGenericImage(slot.origIdx)}
                  deleteConfirmMessage="Remove this AI background? This cannot be undone."
                />
              ))}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <Sparkles className="w-8 h-8 text-violet-400/50" />
            <p className="text-xs text-muted-foreground">No AI backgrounds yet for this fact.</p>
          </div>
        )
      )}

      {/* Reference sub-mode: reference-generated images */}
      {aiSubMode === "reference" && (
        isLoadingRefGenImages ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
          </div>
        ) : myRefImages.length > 0 ? (
          <>
            <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              Your reference-generated backgrounds
              <span className="ml-1 text-primary">({aiGender})</span>
            </p>
            <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbPx}px, 1fr))` }}>
              {myRefImages.map((img, idx) => (
                <ImageCard
                  key={img.storagePath}
                  src={getRefUrl(img.storagePath)}
                  alt={`Reference AI option ${idx + 1}`}
                  aspectRatio="aspect-video"
                  isAuthProtected
                  selected={selectedRefGenPath === img.storagePath}
                  onSelect={() => setSelectedRefGenPath(img.storagePath)}
                  compact
                  actions={["openFull"]}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <Sparkles className="w-8 h-8 text-violet-400/50" />
            <p className="text-xs text-muted-foreground">
              No reference-generated images yet. Pick a photo below and click Generate New.
            </p>
          </div>
        )
      )}

      {/* Reference photo picker */}
      {aiSubMode === "reference" && (
        <div className="space-y-2">
          <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
            Pick a reference photo
          </p>
          <input
            ref={refFileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) void handleRefPhotoUpload(f);
              e.target.value = "";
            }}
          />
          {isLoadingRefUploads ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
            </div>
          ) : (
            <div className="grid gap-1.5 max-h-40 overflow-y-auto pr-0.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbPx}px, 1fr))` }}>
              <button
                onClick={() => refFileInputRef.current?.click()}
                disabled={isUploadingRefPhoto}
                className="relative aspect-video border-2 border-dashed border-border hover:border-violet-400 transition-colors flex flex-col items-center justify-center gap-0.5 text-muted-foreground hover:text-violet-400 disabled:opacity-50"
                title="Upload a new photo"
              >
                {isUploadingRefPhoto
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Upload className="w-3.5 h-3.5" />
                }
                <span className="text-[8px] font-display uppercase tracking-wider leading-tight">
                  {isUploadingRefPhoto ? "Uploading…" : "Upload New"}
                </span>
              </button>
              {refUploads.map(entry => {
                const isSelected = selectedRefUpload?.objectPath === entry.objectPath;
                return (
                  <ImageCard
                    key={entry.objectPath}
                    src={`/api/storage${entry.objectPath}`}
                    alt={`${entry.width}×${entry.height}px`}
                    aspectRatio="aspect-video"
                    isAuthProtected
                    selected={isSelected}
                    onSelect={() => setSelectedRefUpload(isSelected ? null : entry)}
                    compact
                    actions={["openFull"]}
                  />
                );
              })}
              {refUploads.length === 0 && !isUploadingRefPhoto && (
                <p className="col-span-2 text-[10px] text-muted-foreground/60 py-2">
                  No uploads yet — click Upload New above.
                </p>
              )}
            </div>
          )}
          {selectedRefUpload && (
            <p className="text-[10px] text-violet-400">
              Reference selected · 1 image will be generated ({aiGender})
            </p>
          )}
        </div>
      )}

      {/* Style picker (optional) */}
      {showStylePicker && (
        <div className="space-y-1">
          <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">Style</p>
          <select
            value={selectedStyleId}
            onChange={e => setSelectedStyleId(e.target.value)}
            className="w-full bg-secondary border border-border text-foreground text-xs rounded-sm px-2 py-1.5 focus:outline-none focus:border-primary transition-colors"
          >
            {IMAGE_STYLES.map(style => (
              <option key={style.id} value={style.id}>{style.label}</option>
            ))}
          </select>
        </div>
      )}

      {/* Generate New button row */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void handleGenerate()}
          disabled={isGenerating || (aiSubMode === "reference" && !selectedRefUpload)}
          className="gap-2 border-violet-500/50 text-violet-400 hover:border-violet-400 disabled:opacity-50"
        >
          {isGenerating
            ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Generating…</>
            : <><Sparkles className="w-3.5 h-3.5" />Generate New</>
          }
        </Button>
        {isGenerating && (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleCancel}
            disabled={cancelDisabled}
            className="gap-1.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <X className="w-3.5 h-3.5" />Cancel
          </Button>
        )}
        {isAdmin && !isGenerating && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void handleRefreshScene()}
            disabled={isRefreshingScene}
            title="Regenerate stored scene prompts (admin only)"
            className="gap-1.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingScene ? "animate-spin" : ""}`} />
            {isRefreshingScene ? "Refreshing…" : "Refresh Scene"}
          </Button>
        )}
        {!isGenerating && (
          <span className="text-[10px] text-muted-foreground">
            {aiSubMode === "reference"
              ? "1 image from your photo"
              : isGendered ? "3 images (gendered)" : "1 image (abstract)"}
          </span>
        )}
      </div>

      {/* Admin debug: prompt preview + fal.ai call */}
      {isAdmin && (() => {
        const styleDef = IMAGE_STYLES.find(s => s.id === selectedStyleId);
        const suffix = sceneDebug?.styleSuffix
          ?? (aiSubMode === "reference" ? (styleDef?.promptSuffixReference ?? "") : (styleDef?.promptSuffix ?? ""));
        const genderKey = aiGender as string;
        const sceneBase = sceneDebug?.prompts?.[genderKey] ?? null;
        const scenePart = sceneBase ?? "(scene prompt will be generated)";
        const finalPrompt = suffix ? `${scenePart.trim()} ${suffix}` : scenePart;
        return (
          <div className="mt-1 space-y-1">
            <button
              type="button"
              onClick={() => setShowPromptDebug(v => !v)}
              className="text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors"
            >
              {showPromptDebug ? "Hide prompt" : "Show prompt"}
            </button>
            {showPromptDebug && (
              <div className="rounded border border-border bg-muted/30 p-2 space-y-2 text-[10px]">
                <div>
                  <span className="text-muted-foreground font-semibold uppercase tracking-wide">Scene prompt ({genderKey})</span>
                  {sceneBase
                    ? <p className="mt-0.5 text-foreground/80 font-mono leading-relaxed">{sceneBase}</p>
                    : <p className="mt-0.5 text-muted-foreground italic">Not yet generated — GPT will write this on first run</p>
                  }
                </div>
                {suffix && (
                  <div>
                    <span className="text-muted-foreground font-semibold uppercase tracking-wide">Style suffix ({styleDef?.label}) — live from DB</span>
                    <p className="mt-0.5 text-foreground/80 font-mono leading-relaxed">{suffix}</p>
                  </div>
                )}
                <div className="border-t border-border pt-2">
                  <span className="text-violet-400 font-semibold uppercase tracking-wide">Full prompt sent to AI</span>
                  <p className="mt-0.5 text-foreground font-mono leading-relaxed break-words">{finalPrompt}</p>
                </div>
                {sceneDebug?.falCallPreview && (
                  <div className="border-t border-border pt-2 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-amber-400 font-semibold uppercase tracking-wide">fal.ai API call</span>
                      <span className="text-[9px] font-mono text-muted-foreground/60 bg-muted/40 px-1.5 py-0.5 rounded">
                        fal.subscribe("{sceneDebug.falCallPreview.model}", …)
                      </span>
                    </div>
                    <pre className="mt-0.5 text-foreground/90 font-mono text-[9px] leading-relaxed break-words whitespace-pre-wrap bg-black/20 rounded p-2 overflow-x-auto">
                      {JSON.stringify({ model: sceneDebug.falCallPreview.model, input: sceneDebug.falCallPreview.input }, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Admin model + param overrides */}
      {isAdmin && (
        <div className="space-y-1.5 mt-1 p-2 rounded border border-violet-500/20 bg-violet-500/5">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-violet-400/80 font-semibold uppercase tracking-wide shrink-0">⚡ Admin</span>
            <span className="text-[10px] text-muted-foreground/60 shrink-0">Model:</span>
            <select
              value={adminModelOverride}
              onChange={e => setAdminModelOverride(e.target.value)}
              className="flex-1 min-w-0 text-[10px] font-mono px-1.5 py-0.5 rounded border border-border bg-muted/30 text-foreground focus:outline-none focus:border-violet-500/60"
            >
              <option value="">Use default (from config)</option>
              {ADMIN_FAL_MODELS.map(group => (
                <optgroup key={group.group} label={group.group}>
                  {group.models.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          {(() => {
            const effectiveModel = adminModelOverride.trim() || (aiSubMode === "reference" ? aiModelReference : aiModelStandard);
            const params = ADMIN_MODEL_PARAMS[effectiveModel] ?? [];
            if (params.length === 0) return null;
            return (
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1 border-t border-violet-500/10">
                {params.map(p => (
                  <div key={p.key} className="flex items-center gap-1.5">
                    <span className="text-[9px] text-muted-foreground/60 shrink-0 w-24 leading-tight">{p.label}</span>
                    {p.type === "select" && p.options ? (
                      <select
                        value={adminParamOverrides[p.key] ?? ""}
                        onChange={e => setAdminParamOverrides(prev => ({ ...prev, [p.key]: e.target.value }))}
                        className="flex-1 min-w-0 text-[9px] font-mono px-1 py-0.5 rounded border border-border bg-muted/30 text-foreground focus:outline-none focus:border-violet-500/60"
                      >
                        {p.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : (
                      <input
                        type="number"
                        value={adminParamOverrides[p.key] ?? ""}
                        onChange={e => setAdminParamOverrides(prev => ({ ...prev, [p.key]: e.target.value }))}
                        placeholder={p.placeholder}
                        className="flex-1 min-w-0 text-[9px] font-mono px-1 py-0.5 rounded border border-border bg-muted/30 text-foreground focus:outline-none focus:border-violet-500/60 placeholder:text-muted-foreground/30"
                      />
                    )}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* Model attribution */}
      <p className="text-[10px] text-muted-foreground/50">
        AI-generated scene · {adminModelOverride.trim() && isAdmin
          ? adminModelOverride.trim()
          : (aiSubMode === "reference" ? aiModelReference : aiModelStandard)}
      </p>

      {/* Error display */}
      {aiGenerateError && (
        <p className="text-[10px] text-destructive">{aiGenerateError}</p>
      )}

      {/* Generation progress */}
      {isGenerating && (
        <div className="space-y-1.5">
          <div className="w-full h-1.5 rounded-full bg-violet-500/15 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                generationProgress >= 100 ? "bg-green-500" : "bg-violet-500"
              }`}
              style={{ width: `${generationProgress}%` }}
            />
          </div>
          <p className="text-[10px] text-muted-foreground/60">
            Generating… {generationElapsed}s — thumbnails will refresh automatically.
          </p>
        </div>
      )}
    </div>
  );
}
