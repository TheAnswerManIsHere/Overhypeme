import {
  useRef,
  useEffect,
  useState,
  useCallback,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { Link } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { Button } from "@/components/ui/Button";
import {
  X,
  Video,
  Loader2,
  Download,
  Upload,
  Lock,
  CheckCircle,
} from "lucide-react";

// ─── Constants ─────────────────────────────────────────────────────────────────

const CLIENT_MAX_DIMENSION = 3600;
const CLIENT_JPEG_QUALITY = 0.9;
const CLIENT_MAX_UPLOAD_MB = 15;

// ─── Types ─────────────────────────────────────────────────────────────────────

type SourceMode = "generic" | "upload";

type VideoState =
  | { status: "idle" }
  | { status: "generating" }
  | { status: "done"; url: string }
  | { status: "error"; message: string };

interface UploadEntry {
  objectPath: string;
  width: number;
  height: number;
  isLowRes: boolean;
  fileSizeBytes: number;
  createdAt: string;
}

interface VideoBuilderProps {
  factId: number;
  factText: string;
  onClose: () => void;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function renderFactImage(text: string): string {
  const W = 800;
  const H = 420;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#0a0e2e");
  grad.addColorStop(0.55, "#1a237e");
  grad.addColorStop(1, "#283593");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#ff6600";
  ctx.fillRect(0, 0, 12, H);

  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.font = `bold ${Math.floor(H * 0.45)}px serif`;
  ctx.textAlign = "right";
  ctx.fillText("OM", W - 24, H * 0.72);

  const fontSize = 32;
  const padding = 52;
  const maxW = W - padding * 2;
  ctx.font = `bold ${fontSize}px "Impact", sans-serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";

  const words = text.toUpperCase().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const test = current ? `${current} ${w}` : w;
    if (ctx.measureText(test).width > maxW && current) {
      lines.push(current);
      current = w;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);

  const lineH = fontSize * 1.3;
  const totalH = lines.length * lineH;
  const startY = (H - totalH) / 2 + fontSize;

  lines.forEach((line, i) => {
    const y = startY + i * lineH;
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 6;
    ctx.lineJoin = "round";
    ctx.strokeText(line, W / 2, y);
    ctx.fillText(line, W / 2, y);
  });

  ctx.font = "bold 13px sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.textAlign = "right";
  ctx.fillText("overhype.me", W - 18, H - 14);

  return canvas.toDataURL("image/jpeg", 0.85);
}

function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex-1 py-2 text-[11px] font-bold uppercase tracking-wider border-b-2 transition-all ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
      }`}
    >
      {children}
    </button>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function VideoBuilder({ factId, factText, onClose }: VideoBuilderProps) {
  const { isAuthenticated, role } = useAuth();
  const isPremium = role === "premium" || role === "admin";

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Source tab
  const [sourceMode, setSourceMode] = useState<SourceMode>("generic");

  // Generic: canvas-rendered image
  const [genericBase64, setGenericBase64] = useState<string>("");

  // Upload state
  const [selectedObjectPath, setSelectedObjectPath] = useState<string | null>(null);
  const [uploadLocalUrl, setUploadLocalUrl] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadErrorMsg, setUploadErrorMsg] = useState<string | null>(null);

  // Upload gallery
  const [uploadGallery, setUploadGallery] = useState<UploadEntry[]>([]);
  const [uploadGalleryCount, setUploadGalleryCount] = useState(0);
  const [uploadGalleryMax, setUploadGalleryMax] = useState(1000);
  const [isLoadingGallery, setIsLoadingGallery] = useState(false);
  const [confirmingDeletePath, setConfirmingDeletePath] = useState<string | null>(null);
  const [deletingUploadPath, setDeletingUploadPath] = useState<string | null>(null);

  // Video state
  const [videoState, setVideoState] = useState<VideoState>({ status: "idle" });

  // Render the generic canvas image on mount
  useEffect(() => {
    setGenericBase64(renderFactImage(factText));
  }, [factText]);

  // Clear stale video state when the source image changes
  useEffect(() => {
    setVideoState({ status: "idle" });
  }, [sourceMode, selectedObjectPath]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      if (uploadLocalUrl) URL.revokeObjectURL(uploadLocalUrl);
    };
  }, [uploadLocalUrl]);

  // Fetch upload gallery when switching to upload tab (premium users only)
  useEffect(() => {
    if (sourceMode !== "upload" || !isPremium) return;
    let cancelled = false;
    setIsLoadingGallery(true);
    fetch("/api/users/me/uploads", { credentials: "include" })
      .then(r => r.json())
      .then((data: { uploads?: UploadEntry[]; uploadCount?: number; maxUploads?: number }) => {
        if (cancelled) return;
        setUploadGallery(data.uploads ?? []);
        setUploadGalleryCount(data.uploadCount ?? 0);
        setUploadGalleryMax(data.maxUploads ?? 1000);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setIsLoadingGallery(false); });
    return () => { cancelled = true; };
  }, [sourceMode, isPremium]);

  // ── Upload helpers ──────────────────────────────────────────────────────────

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

  const handleFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) {
      setUploadErrorMsg("Please select an image file (JPEG, PNG, WebP, HEIC, or similar).");
      return;
    }
    if (file.size > CLIENT_MAX_UPLOAD_MB * 1024 * 1024) {
      setUploadErrorMsg(`File too large. Maximum size is ${CLIENT_MAX_UPLOAD_MB} MB.`);
      return;
    }

    setUploadErrorMsg(null);
    setUploadFile(file);
    setIsUploadingFile(true);
    setSelectedObjectPath(null);

    if (uploadLocalUrl) URL.revokeObjectURL(uploadLocalUrl);
    const localUrl = URL.createObjectURL(file);
    setUploadLocalUrl(localUrl);

    try {
      let uploadBlob: Blob = file;
      try {
        const processed = await preProcessImageFile(file);
        uploadBlob = processed.blob;
      } catch {
        uploadBlob = file;
      }

      const uploadRes = await fetch("/api/storage/upload-meme", {
        method: "POST",
        headers: { "Content-Type": "image/jpeg" },
        body: uploadBlob,
      });
      if (!uploadRes.ok) {
        const body = await uploadRes.json() as { error?: string };
        throw new Error(body.error ?? "Upload failed");
      }
      const result = await uploadRes.json() as { objectPath: string };
      setSelectedObjectPath(result.objectPath);

      // Refresh gallery
      fetch("/api/users/me/uploads", { credentials: "include" })
        .then(r => r.json())
        .then((data: { uploads?: UploadEntry[]; uploadCount?: number; maxUploads?: number }) => {
          setUploadGallery(data.uploads ?? []);
          setUploadGalleryCount(data.uploadCount ?? 0);
          setUploadGalleryMax(data.maxUploads ?? 1000);
        })
        .catch(() => {});
    } catch (e) {
      setUploadErrorMsg(e instanceof Error ? e.message : "Upload failed");
      setUploadFile(null);
      URL.revokeObjectURL(localUrl);
      setUploadLocalUrl(null);
    } finally {
      setIsUploadingFile(false);
    }
  }, [uploadLocalUrl]);

  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const selectExistingUpload = (entry: UploadEntry) => {
    if (uploadLocalUrl) URL.revokeObjectURL(uploadLocalUrl);
    setUploadFile(null);
    setUploadLocalUrl(null);
    setSelectedObjectPath(entry.objectPath);
  };

  const deleteUpload = useCallback(async (objectPath: string) => {
    setDeletingUploadPath(objectPath);
    try {
      const res = await fetch(`/api/users/me/uploads?path=${encodeURIComponent(objectPath)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) return;
      if (selectedObjectPath === objectPath) {
        setSelectedObjectPath(null);
      }
      const data = await fetch("/api/users/me/uploads", { credentials: "include" }).then(r => r.json()) as {
        uploads?: UploadEntry[];
        uploadCount?: number;
        maxUploads?: number;
      };
      setUploadGallery(data.uploads ?? []);
      setUploadGalleryCount(data.uploadCount ?? 0);
      setUploadGalleryMax(data.maxUploads ?? 1000);
    } catch {
      // silent
    } finally {
      setDeletingUploadPath(null);
    }
  }, [selectedObjectPath]);

  // ── Video generation ────────────────────────────────────────────────────────

  const handleGenerateVideo = async () => {
    if (videoState.status === "generating") return;

    let body: Record<string, unknown>;

    if (sourceMode === "generic") {
      if (!genericBase64) return;
      body = { imageBase64: genericBase64, factId };
    } else {
      if (!selectedObjectPath) return;
      body = { imageUrl: `/api/storage${selectedObjectPath}`, factId };
    }

    setVideoState({ status: "generating" });
    try {
      const res = await fetch("/api/videos/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const data = await res.json() as { videoUrl?: string; error?: string };
      if (res.status === 429) {
        setVideoState({ status: "error", message: data.error ?? "Rate limit exceeded. You can generate up to 3 videos per 24 hours." });
        return;
      }
      if (!res.ok || !data.videoUrl) {
        setVideoState({ status: "error", message: data.error ?? "Video generation failed. Please try again." });
        return;
      }
      setVideoState({ status: "done", url: data.videoUrl });
    } catch {
      setVideoState({ status: "error", message: "Network error. Please check your connection and try again." });
    }
  };

  const handleDownloadVideo = () => {
    if (videoState.status !== "done") return;
    const a = document.createElement("a");
    a.href = videoState.url;
    a.download = `overhype-video-${factId}.mp4`;
    a.click();
  };

  // Derived: the preview image URL to show
  const previewSrc =
    sourceMode === "generic"
      ? genericBase64
      : uploadLocalUrl ?? (selectedObjectPath ? `/api/storage${selectedObjectPath}` : null);

  const canGenerate =
    videoState.status !== "generating" &&
    (sourceMode === "generic" ? !!genericBase64 : !!selectedObjectPath && !isUploadingFile);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-3 md:p-6"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-card border-2 border-border w-full max-w-4xl max-h-[96vh] overflow-y-auto shadow-2xl shadow-black/60">

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-5 py-4 border-b-2 border-border sticky top-0 bg-card z-10">
          <h2 className="text-xl font-display uppercase tracking-[0.15em] text-primary flex items-center gap-2">
            <Video className="w-5 h-5" /> Video Generator
          </h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 md:p-5 space-y-5">

          {/* ── Preview image ── */}
          <div className="sticky top-14 z-10 bg-card pb-2">
            {previewSrc ? (
              <img
                src={previewSrc}
                alt="Video source preview"
                className="w-full h-auto border-2 border-border"
              />
            ) : (
              <div className="w-full aspect-video bg-muted border-2 border-border flex items-center justify-center">
                <p className="text-xs text-muted-foreground/60 font-display uppercase tracking-widest">
                  {sourceMode === "upload" ? "Select or upload an image" : "Loading preview…"}
                </p>
              </div>
            )}
          </div>

          {/* ── Source tabs ── */}
          <div>
            <p className="text-[10px] font-display uppercase tracking-[0.2em] text-muted-foreground mb-3">
              Image Source
            </p>
            <div className="flex border-b border-border mb-4">
              <ModeTab active={sourceMode === "generic"} onClick={() => setSourceMode("generic")}>
                Generic
              </ModeTab>
              <ModeTab active={sourceMode === "upload"} onClick={() => setSourceMode("upload")}>
                Upload
              </ModeTab>
            </div>

            {/* Generic tab content */}
            {sourceMode === "generic" && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  The fact text is rendered onto a branded gradient background and animated into a short video.
                </p>
              </div>
            )}

            {/* Upload tab content */}
            {sourceMode === "upload" && (
              <>
                {!isAuthenticated ? (
                  <div className="border-2 border-dashed border-amber-400/30 bg-amber-400/5 p-5 text-center space-y-2">
                    <Lock className="w-6 h-6 text-amber-400 mx-auto" />
                    <p className="text-sm font-bold text-amber-400 uppercase tracking-wider">
                      Login Required
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Log in to upload your own images for video generation.
                    </p>
                  </div>
                ) : !isPremium ? (
                  <div className="border-2 border-dashed border-amber-400/30 bg-amber-400/5 p-5 text-center space-y-2">
                    <Lock className="w-6 h-6 text-amber-400 mx-auto" />
                    <p className="text-sm font-bold text-amber-400 uppercase tracking-wider">
                      Legendary Feature
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Upload your own photos with a Legendary membership.
                    </p>
                    <Link href="/pricing">
                      <Button size="sm" className="mt-2">Go Legendary</Button>
                    </Link>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Drop zone */}
                    <div
                      onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
                      onDragLeave={() => setIsDragOver(false)}
                      onDrop={onDrop}
                      onClick={() => fileInputRef.current?.click()}
                      className={`border-2 border-dashed cursor-pointer transition-all p-5 text-center ${
                        isDragOver
                          ? "border-primary bg-primary/10"
                          : uploadFile
                          ? "border-primary/40 bg-primary/5"
                          : "border-border hover:border-primary/50 hover:bg-muted/30"
                      }`}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={onFileInputChange}
                      />
                      {isUploadingFile ? (
                        <div className="flex flex-col items-center gap-2">
                          <Loader2 className="w-6 h-6 text-primary animate-spin" />
                          <p className="text-xs text-muted-foreground">Uploading…</p>
                        </div>
                      ) : uploadFile ? (
                        <div className="flex items-center gap-3">
                          {uploadLocalUrl && (
                            <img
                              src={uploadLocalUrl}
                              alt="Upload preview"
                              className="w-16 h-10 object-cover border border-border flex-shrink-0"
                            />
                          )}
                          <div className="min-w-0 text-left">
                            <p className="text-xs font-bold text-foreground truncate">{uploadFile.name}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {(uploadFile.size / 1024 / 1024).toFixed(1)} MB
                              {selectedObjectPath ? " · Uploaded ✓" : " · Uploading…"}
                            </p>
                          </div>
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              setUploadFile(null);
                              setSelectedObjectPath(null);
                              if (uploadLocalUrl) URL.revokeObjectURL(uploadLocalUrl);
                              setUploadLocalUrl(null);
                            }}
                            className="ml-auto text-muted-foreground hover:text-foreground"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-2">
                          <Upload className="w-6 h-6 text-muted-foreground" />
                          <p className="text-xs text-muted-foreground">
                            Drop an image here, or click to browse
                          </p>
                          <p className="text-[10px] text-muted-foreground/60">
                            PNG · JPG · WebP · HEIC · max {CLIENT_MAX_UPLOAD_MB} MB
                          </p>
                        </div>
                      )}
                    </div>

                    {uploadErrorMsg && (
                      <p className="text-xs text-destructive">{uploadErrorMsg}</p>
                    )}

                    {/* Existing uploads gallery */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[10px] font-display uppercase tracking-[0.2em] text-muted-foreground">
                          My Uploads
                        </p>
                        {!isLoadingGallery && (
                          <p className="text-[10px] text-muted-foreground tabular-nums">
                            {uploadGalleryCount} / {uploadGalleryMax}
                          </p>
                        )}
                      </div>

                      {isLoadingGallery ? (
                        <div className="flex items-center justify-center py-6">
                          <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
                        </div>
                      ) : uploadGallery.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground/60 text-center py-4">
                          No uploads yet. Drop an image above to get started.
                        </p>
                      ) : (
                        <div className="grid gap-1.5 max-h-52 overflow-y-auto pr-0.5"
                          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))" }}
                        >
                          {uploadGallery.map((entry) => {
                            const isSelected = selectedObjectPath === entry.objectPath && !uploadFile;
                            const isDeleting = deletingUploadPath === entry.objectPath;
                            const isConfirming = confirmingDeletePath === entry.objectPath;
                            return (
                              <div key={entry.objectPath} className="relative">
                                <button
                                  onClick={() => {
                                    if (isDeleting) return;
                                    if (isConfirming) { setConfirmingDeletePath(null); return; }
                                    selectExistingUpload(entry);
                                  }}
                                  disabled={isDeleting}
                                  className={`relative w-full aspect-video overflow-hidden border-2 transition-all ${
                                    isSelected && !isConfirming
                                      ? "border-primary"
                                      : "border-transparent hover:border-primary/50"
                                  } ${isDeleting ? "opacity-40" : ""}`}
                                >
                                  <img
                                    src={`/api/storage${entry.objectPath}`}
                                    alt="Uploaded image"
                                    className="w-full h-full object-cover"
                                    loading="lazy"
                                  />
                                  {isSelected && !isConfirming && (
                                    <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                                      <CheckCircle className="w-4 h-4 text-primary drop-shadow" />
                                    </div>
                                  )}
                                </button>

                                {/* Delete button */}
                                {!isConfirming && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setConfirmingDeletePath(entry.objectPath); }}
                                    disabled={isDeleting}
                                    className="absolute top-0.5 right-0.5 z-10 w-5 h-5 rounded-full bg-black/60 flex items-center justify-center text-white hover:bg-red-600 transition-colors disabled:cursor-not-allowed"
                                    title="Delete image"
                                    aria-label="Delete image"
                                  >
                                    {isDeleting
                                      ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
                                      : <X className="w-2.5 h-2.5" />
                                    }
                                  </button>
                                )}

                                {/* Inline delete confirmation */}
                                {isConfirming && (
                                  <div className="absolute inset-0 z-20 bg-black/75 flex flex-col items-center justify-center gap-1.5 p-1">
                                    <span className="text-[9px] font-bold text-white uppercase tracking-wide">Delete?</span>
                                    <div className="flex gap-1">
                                      <button
                                        onClick={(e) => { e.stopPropagation(); setConfirmingDeletePath(null); }}
                                        className="px-2 py-0.5 text-[9px] font-semibold rounded bg-white/20 text-white hover:bg-white/30 transition-colors"
                                      >
                                        Cancel
                                      </button>
                                      <button
                                        onClick={(e) => { e.stopPropagation(); setConfirmingDeletePath(null); void deleteUpload(entry.objectPath); }}
                                        className="px-2 py-0.5 text-[9px] font-semibold rounded bg-red-600 text-white hover:bg-red-500 transition-colors"
                                      >
                                        Delete
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── Video status ── */}
          {videoState.status === "generating" && (
            <div className="flex items-center gap-3 px-4 py-3 bg-primary/10 border border-primary/30 text-sm text-primary">
              <Loader2 className="w-4 h-4 animate-spin shrink-0" />
              <span>Generating your video… this takes 30–120 seconds</span>
            </div>
          )}

          {videoState.status === "error" && (
            <div className="flex items-start gap-3 px-4 py-3 bg-destructive/10 border border-destructive/30 text-sm text-destructive">
              <X className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p>{videoState.message}</p>
                <button
                  onClick={() => setVideoState({ status: "idle" })}
                  className="mt-1 text-xs underline hover:no-underline"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {videoState.status === "done" && (
            <div className="space-y-3">
              <p className="text-xs font-display uppercase tracking-widest text-primary">Your Video</p>
              <div className="border-2 border-border overflow-hidden">
                <video src={videoState.url} controls autoPlay className="w-full" />
              </div>
              <Button onClick={handleDownloadVideo} variant="secondary" className="gap-2 w-full">
                <Download className="w-4 h-4" /> Download Video
              </Button>
            </div>
          )}

          {/* ── Generate button ── */}
          <Button
            onClick={() => void handleGenerateVideo()}
            disabled={!canGenerate}
            variant="primary"
            size="lg"
            className="gap-2 w-full"
          >
            {videoState.status === "generating" ? (
              <><Loader2 className="w-4 h-4 animate-spin" />Generating Video…</>
            ) : (
              <><Video className="w-4 h-4" />{videoState.status === "done" ? "Regenerate Video" : "Generate Video"}</>
            )}
          </Button>

          <p className="text-xs text-muted-foreground text-center">
            AI video generation typically takes 30–120 seconds. You can generate up to 3 videos per 24 hours.
          </p>
        </div>
      </div>
    </div>
  );
}
