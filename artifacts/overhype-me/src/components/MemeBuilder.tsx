import {
  useRef,
  useEffect,
  useState,
  useCallback,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { Link } from "wouter";
import { useListMemeTemplates, useRequestUploadUrl } from "@workspace/api-client-react";
import { useAuth } from "@workspace/replit-auth-web";
import { Button } from "@/components/ui/Button";
import {
  X,
  Download,
  Share2,
  CheckCircle,
  Loader2,
  RefreshCw,
  Upload,
  Lock,
  ImageIcon,
  Layers,
} from "lucide-react";

// ─── Canvas constants ──────────────────────────────────────────────────────────

const CANVAS_W = 800;
const CANVAS_H = 420;

const GRADIENT_DEFS: Record<string, [string, string][]> = {
  action: [["#0a0e2e", "0%"], ["#1a237e", "55%"], ["#283593", "100%"]],
  fire:   [["#bf360c", "0%"], ["#e64a19", "50%"], ["#ff6d00", "100%"]],
  night:  [["#0a0a0a", "0%"], ["#1b2420", "55%"], ["#263238", "100%"]],
  gold:   [["#4a2c00", "0%"], ["#f57f17", "60%"], ["#ffd54f", "100%"]],
  cinema: [["#2d1e00", "0%"], ["#5d4037", "55%"], ["#8d6e63", "100%"]],
};

const ACCENT_COLORS: Record<string, string> = {
  action: "#ff6600",
  fire:   "#ff6d00",
  night:  "#546e7a",
  gold:   "#ffd54f",
  cinema: "#8d6e63",
};

type TextAlign = "left" | "center" | "right";
type VertPos   = "top" | "middle" | "bottom";
type ImageMode = "gradient" | "stock" | "upload";
type StockGender = "man" | "woman" | "person";

interface StockPhoto {
  id: number;
  photographerName: string;
  photographerUrl: string;
  photoUrl: string;
}

// ─── Canvas drawing ────────────────────────────────────────────────────────────

/** Center-crop an image onto the canvas, preserving aspect ratio. */
function drawCroppedImage(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
) {
  const srcAspect = img.naturalWidth / img.naturalHeight;
  const dstAspect = CANVAS_W / CANVAS_H;
  let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
  if (srcAspect > dstAspect) {
    sw = img.naturalHeight * dstAspect;
    sx = (img.naturalWidth - sw) / 2;
  } else {
    sh = img.naturalWidth / dstAspect;
    sy = (img.naturalHeight - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, CANVAS_W, CANVAS_H);
}

function drawMeme(
  canvas: HTMLCanvasElement,
  bgImage: HTMLImageElement | null,
  templateId: string,
  text: string,
  fontSize: number,
  color: string,
  align: TextAlign,
  vertPos: VertPos,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Background
  if (bgImage) {
    drawCroppedImage(ctx, bgImage);
    ctx.fillStyle = "rgba(0,0,0,0.48)";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  } else {
    const stops = GRADIENT_DEFS[templateId] ?? GRADIENT_DEFS["action"]!;
    const grad = ctx.createLinearGradient(0, 0, CANVAS_W, CANVAS_H);
    stops.forEach(([c, pos]) => grad.addColorStop(parseFloat(pos) / 100, c));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }

  // Left accent bar
  const sidebarW = 12;
  const accent = bgImage
    ? "#FF3C00"
    : (ACCENT_COLORS[templateId] ?? "#ff6600");
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, sidebarW, CANVAS_H);

  // Ghost watermark
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.font = `bold ${Math.floor(CANVAS_H * 0.45)}px serif`;
  ctx.textAlign = "right";
  ctx.fillText("OM", CANVAS_W - 24, CANVAS_H * 0.72);

  // Text
  const padding = 56;
  const maxW = CANVAS_W - padding * 2 - sidebarW;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = 10;

  const words = text.split(" ");
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

  const lineH = fontSize * 1.45;
  const totalH = lines.length * lineH;
  let startY: number;
  if (vertPos === "top")         startY = padding + fontSize;
  else if (vertPos === "bottom") startY = CANVAS_H - padding - totalH + fontSize;
  else                           startY = (CANVAS_H - totalH) / 2 + fontSize;

  const textX =
    align === "right"
      ? CANVAS_W - padding
      : align === "center"
      ? padding + sidebarW + maxW / 2
      : padding + sidebarW + 4;

  lines.forEach((line, i) => ctx.fillText(line, textX, startY + i * lineH));

  ctx.shadowBlur = 0;
  ctx.font = "bold 13px sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.textAlign = "right";
  ctx.fillText("overhype.me", CANVAS_W - 18, CANVAS_H - 14);
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-display uppercase tracking-[0.2em] text-muted-foreground mb-3 flex items-center gap-2">
      {children}
    </p>
  );
}

function ModeTab({
  active,
  onClick,
  children,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  badge?: string;
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
      {badge && (
        <span className="ml-1.5 inline-flex items-center gap-0.5 text-[9px] font-bold text-amber-400 bg-amber-400/10 border border-amber-400/30 px-1 py-0.5 rounded-sm">
          <Lock className="w-2 h-2" />
          {badge}
        </span>
      )}
    </button>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

interface MemeBuilderProps {
  factId: number;
  factText: string;
  onClose: () => void;
}

export function MemeBuilder({ factId, factText, onClose }: MemeBuilderProps) {
  const { isAuthenticated, login, user } = useAuth() as {
    isAuthenticated: boolean;
    login: () => void;
    user?: { membershipTier?: string };
  };
  const isPremium = user?.membershipTier === "premium";

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Image source state
  const [imageMode, setImageMode] = useState<ImageMode>("gradient");
  const [selectedTemplate, setSelectedTemplate] = useState("action");
  const [stockGender, setStockGender] = useState<StockGender | null>(null);
  const [stockPhoto, setStockPhoto] = useState<StockPhoto | null>(null);
  const [isLoadingStock, setIsLoadingStock] = useState(false);
  const [stockError, setStockError] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadObjectPath, setUploadObjectPath] = useState<string | null>(null);
  const [uploadLocalUrl, setUploadLocalUrl] = useState<string | null>(null);
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  // Canvas background image (loaded from stock/upload for preview)
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const [isBgLoading, setIsBgLoading] = useState(false);

  // Text options
  const [fontSize, setFontSize] = useState(28);
  const [textColor, setTextColor] = useState("#ffffff");
  const [textAlign, setTextAlign] = useState<TextAlign>("left");
  const [vertPos, setVertPos] = useState<VertPos>("middle");

  // Generation state
  const [status, setStatus] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [permalinkSlug, setPermalinkSlug] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { data: tplData } = useListMemeTemplates();
  const requestUploadUrl = useRequestUploadUrl();

  // ── Canvas redraw ────────────────────────────────────────────────
  const redraw = useCallback(() => {
    if (canvasRef.current) {
      drawMeme(
        canvasRef.current,
        bgImage,
        selectedTemplate,
        factText,
        fontSize,
        textColor,
        textAlign,
        vertPos,
      );
    }
  }, [bgImage, selectedTemplate, factText, fontSize, textColor, textAlign, vertPos]);

  useEffect(() => { redraw(); }, [redraw]);

  // ── Load stock photo into canvas ─────────────────────────────────
  useEffect(() => {
    const photoUrl =
      imageMode === "stock" ? stockPhoto?.photoUrl ?? null :
      imageMode === "upload" ? uploadLocalUrl :
      null;

    if (!photoUrl) {
      setBgImage(null);
      return;
    }

    setIsBgLoading(true);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { setBgImage(img); setIsBgLoading(false); };
    img.onerror = () => { setBgImage(null); setIsBgLoading(false); };
    img.src = photoUrl;
  }, [imageMode, stockPhoto, uploadLocalUrl]);

  // ── Fetch a stock photo ──────────────────────────────────────────
  const fetchStockPhoto = useCallback(async (gender: StockGender) => {
    if (!isAuthenticated) return;
    setIsLoadingStock(true);
    setStockError(null);
    try {
      const res = await fetch(`/api/memes/stock-photo?gender=${gender}`);
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? "Failed to fetch photo");
      }
      const photo = await res.json() as StockPhoto;
      setStockPhoto(photo);
    } catch (e) {
      setStockError(e instanceof Error ? e.message : "Could not load photo");
    } finally {
      setIsLoadingStock(false);
    }
  }, [isAuthenticated]);


  // ── Upload flow ──────────────────────────────────────────────────
  const handleFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) {
      setErrorMsg("Please select an image file (PNG, JPG, or WebP).");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setErrorMsg("Image must be under 10 MB.");
      return;
    }

    setErrorMsg(null);
    setUploadFile(file);
    setIsUploadingFile(true);

    // Local preview immediately
    const localUrl = URL.createObjectURL(file);
    setUploadLocalUrl(localUrl);

    try {
      // 1. Get presigned upload URL
      const { uploadURL, objectPath } = await requestUploadUrl.mutateAsync({
        data: { name: file.name, size: file.size, contentType: file.type },
      });

      // 2. PUT file directly to GCS
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error("Upload failed");

      setUploadObjectPath(objectPath);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Upload failed");
      setUploadFile(null);
      setUploadLocalUrl(null);
      URL.revokeObjectURL(localUrl);
    } finally {
      setIsUploadingFile(false);
    }
  }, [requestUploadUrl]);

  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      if (uploadLocalUrl) URL.revokeObjectURL(uploadLocalUrl);
    };
  }, [uploadLocalUrl]);

  // ── Generate ─────────────────────────────────────────────────────
  const handleGenerate = async () => {
    if (!isAuthenticated) { login(); return; }

    // Validate we have a valid source
    if (imageMode === "stock" && !stockPhoto) {
      setErrorMsg("Please wait for a stock photo to load, or shuffle to try again.");
      return;
    }
    if (imageMode === "upload" && !uploadObjectPath) {
      setErrorMsg(isUploadingFile ? "Please wait for the upload to finish." : "Please select an image to upload.");
      return;
    }

    setStatus("generating");
    setErrorMsg(null);

    try {
      const imageSource =
        imageMode === "template"
          ? { type: "template" as const, templateId: selectedTemplate }
          : imageMode === "stock"
          ? {
              type: "stock" as const,
              photoUrl: stockPhoto!.photoUrl,
              pexelsPhotoId: stockPhoto!.id,
              photographerName: stockPhoto!.photographerName,
            }
          : {
              type: "upload" as const,
              uploadKey: uploadObjectPath!,
            };

      const res = await fetch("/api/memes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          factId,
          imageSource,
          textOptions: {
            fontSize,
            color: textColor,
            align: textAlign,
            verticalPosition: vertPos,
          },
        }),
      });

      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? "Generation failed");
      }

      const result = await res.json() as { permalinkSlug: string };
      setPermalinkSlug(result.permalinkSlug);
      setStatus("done");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Something went wrong");
      setStatus("error");
    }
  };

  const handleDownload = () => {
    if (!canvasRef.current) return;
    const link = document.createElement("a");
    link.download = `overhype-fact-${factId}.png`;
    link.href = canvasRef.current.toDataURL("image/png");
    link.click();
  };

  const templates = tplData?.templates ?? [];

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-3 md:p-6"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-card border-2 border-border w-full max-w-4xl max-h-[96vh] overflow-y-auto shadow-2xl shadow-black/60">

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-5 py-4 border-b-2 border-border sticky top-0 bg-card z-10">
          <h2 className="text-xl font-display uppercase tracking-[0.15em] text-primary">
            Meme Generator
          </h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 md:p-5 space-y-5">

          {/* ── Canvas preview ── */}
          <div className="relative">
            <canvas
              ref={canvasRef}
              width={CANVAS_W}
              height={CANVAS_H}
              className="w-full h-auto border-2 border-border"
            />
            {isBgLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60 border-2 border-border">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
              </div>
            )}
          </div>

          {/* ── Controls (two columns on md+) ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

            {/* ── Left column: Image Source + Style ── */}
            <div className="space-y-5">

              {/* Image Source */}
              <div>
                <SectionLabel>
                  <ImageIcon className="w-3 h-3" /> Image Source
                </SectionLabel>

                {/* Mode tabs */}
                <div className="flex border-b border-border mb-4">
                  <ModeTab
                    active={imageMode === "gradient"}
                    onClick={() => setImageMode("gradient")}
                  >
                    Gradient
                  </ModeTab>
                  <ModeTab
                    active={imageMode === "stock"}
                    onClick={() => setImageMode("stock")}
                  >
                    Stock Photo
                  </ModeTab>
                  <ModeTab
                    active={imageMode === "upload"}
                    onClick={() => {
                      if (!isPremium && isAuthenticated) return; // handled below
                      setImageMode("upload");
                    }}
                    badge="PRO"
                  >
                    Upload
                  </ModeTab>
                </div>

                {/* Gradient mode: template picker */}
                {imageMode === "gradient" && (
                  <div className="grid grid-cols-5 gap-2">
                    {templates.map(tpl => {
                      const stops = GRADIENT_DEFS[tpl.id];
                      const from = stops?.[0]?.[0] ?? "#000";
                      const to = stops?.[stops.length - 1]?.[0] ?? "#333";
                      return (
                        <button
                          key={tpl.id}
                          onClick={() => setSelectedTemplate(tpl.id)}
                          title={tpl.description}
                          className={`relative h-14 border-2 overflow-hidden transition-all ${
                            selectedTemplate === tpl.id
                              ? "border-primary ring-2 ring-primary/30 scale-105"
                              : "border-border hover:border-primary/50"
                          }`}
                          style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
                        >
                          <span className="absolute inset-0 flex items-end justify-center pb-1">
                            <span className="text-white text-[9px] font-bold drop-shadow-lg truncate px-1">
                              {tpl.name}
                            </span>
                          </span>
                          {selectedTemplate === tpl.id && (
                            <span className="absolute top-1 right-1 w-2 h-2 bg-primary rounded-full border border-white" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Stock photo mode */}
                {imageMode === "stock" && (
                  <div className="space-y-3">
                    {/* Gender tabs */}
                    <div className="flex gap-2">
                      {(["man", "woman", "person"] as StockGender[]).map(g => (
                        <button
                          key={g}
                          onClick={() => {
                            setStockGender(g);
                            fetchStockPhoto(g);
                          }}
                          className={`flex-1 py-1.5 text-xs font-bold uppercase tracking-wider border-2 transition-all ${
                            stockGender === g
                              ? "border-primary bg-primary/15 text-primary"
                              : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                          }`}
                        >
                          {g}
                        </button>
                      ))}
                    </div>

                    {/* Photo preview + shuffle */}
                    <div className="flex gap-3 items-start">
                      <div className="w-24 h-16 flex-shrink-0 border-2 border-border overflow-hidden bg-muted relative">
                        {isLoadingStock ? (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <Loader2 className="w-4 h-4 text-primary animate-spin" />
                          </div>
                        ) : stockPhoto ? (
                          <img
                            src={stockPhoto.photoUrl}
                            alt="Stock photo preview"
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <ImageIcon className="w-5 h-5 text-muted-foreground/40" />
                          </div>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <button
                          onClick={() => stockGender && fetchStockPhoto(stockGender)}
                          disabled={isLoadingStock || !stockGender}
                          className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-primary border-2 border-border hover:border-primary/50 px-3 py-1.5 transition-all disabled:opacity-50 w-full justify-center"
                        >
                          <RefreshCw className={`w-3 h-3 ${isLoadingStock ? "animate-spin" : ""}`} />
                          Shuffle
                        </button>
                        {stockPhoto && (
                          <p className="text-[10px] text-muted-foreground mt-2 truncate">
                            Photo by{" "}
                            <a
                              href={stockPhoto.photographerUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary/70 hover:text-primary"
                            >
                              {stockPhoto.photographerName}
                            </a>
                            {" "}on Pexels
                          </p>
                        )}
                        {stockError && (
                          <p className="text-[10px] text-destructive mt-2">{stockError}</p>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Upload mode */}
                {imageMode === "upload" && (
                  <>
                    {!isPremium ? (
                      <div className="border-2 border-dashed border-amber-400/30 bg-amber-400/5 p-5 text-center space-y-2">
                        <Lock className="w-6 h-6 text-amber-400 mx-auto" />
                        <p className="text-sm font-bold text-amber-400 uppercase tracking-wider">
                          Premium Feature
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Upload your own photos with a Premium membership.
                        </p>
                        <Link href="/membership">
                          <Button size="sm" className="mt-2">Upgrade to Premium</Button>
                        </Link>
                      </div>
                    ) : (
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
                          accept="image/png,image/jpeg,image/webp"
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
                                {uploadObjectPath ? " · Uploaded ✓" : " · Uploading…"}
                              </p>
                            </div>
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                setUploadFile(null);
                                setUploadObjectPath(null);
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
                              PNG · JPG · WebP · max 10 MB
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* ── Right column: Text options ── */}
            <div className="space-y-5">
              <div>
                <SectionLabel>
                  <Layers className="w-3 h-3" /> Text
                </SectionLabel>

                <div className="space-y-4">
                  {/* Font size */}
                  <div>
                    <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground block mb-2">
                      Font Size: {fontSize}px
                    </label>
                    <input
                      type="range"
                      min={14}
                      max={48}
                      value={fontSize}
                      onChange={e => setFontSize(parseInt(e.target.value))}
                      className="w-full accent-primary"
                    />
                  </div>

                  {/* Color */}
                  <div>
                    <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground block mb-2">
                      Text Color
                    </label>
                    <div className="flex gap-2 flex-wrap items-center">
                      {["#ffffff", "#ffcc00", "#FF3C00", "#00ff88", "#ff4466"].map(c => (
                        <button
                          key={c}
                          onClick={() => setTextColor(c)}
                          className={`w-7 h-7 rounded-full border-2 transition-all ${
                            textColor === c
                              ? "border-white scale-110 ring-2 ring-white/30"
                              : "border-transparent hover:scale-105 hover:border-white/30"
                          }`}
                          style={{ background: c }}
                          title={c}
                        />
                      ))}
                      <input
                        type="color"
                        value={textColor}
                        onChange={e => setTextColor(e.target.value)}
                        className="w-7 h-7 rounded-full border-2 border-border cursor-pointer bg-transparent"
                        title="Custom color"
                      />
                    </div>
                  </div>

                  {/* Alignment */}
                  <div>
                    <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
                      Alignment
                    </p>
                    <div className="flex gap-2">
                      {(["left", "center", "right"] as TextAlign[]).map(a => (
                        <button
                          key={a}
                          onClick={() => setTextAlign(a)}
                          className={`flex-1 py-1.5 text-[11px] font-bold uppercase tracking-wider border-2 transition-all ${
                            textAlign === a
                              ? "border-primary bg-primary/15 text-primary"
                              : "border-border text-muted-foreground hover:border-primary/40"
                          }`}
                        >
                          {a}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Vertical position */}
                  <div>
                    <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
                      Position
                    </p>
                    <div className="flex gap-2">
                      {(["top", "middle", "bottom"] as VertPos[]).map(p => (
                        <button
                          key={p}
                          onClick={() => setVertPos(p)}
                          className={`flex-1 py-1.5 text-[11px] font-bold uppercase tracking-wider border-2 transition-all ${
                            vertPos === p
                              ? "border-primary bg-primary/15 text-primary"
                              : "border-border text-muted-foreground hover:border-primary/40"
                          }`}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ── Error ── */}
          {errorMsg && (
            <p className="text-destructive text-sm font-medium bg-destructive/10 border border-destructive/30 px-4 py-2">
              {errorMsg}
            </p>
          )}

          {/* ── Success / Actions ── */}
          {status === "done" && permalinkSlug ? (
            <div className="bg-primary/10 border-2 border-primary p-4 space-y-3">
              <div className="flex items-center gap-3 text-primary">
                <CheckCircle className="w-5 h-5 shrink-0" />
                <span className="font-display uppercase tracking-wide font-bold text-sm">
                  Meme Created!
                </span>
              </div>
              <div className="flex flex-wrap gap-3">
                <Link href={`/meme/${permalinkSlug}`}>
                  <Button size="sm" variant="outline" className="gap-2">
                    <Share2 className="w-4 h-4" /> View Permalink
                  </Button>
                </Link>
                <Button size="sm" variant="secondary" className="gap-2" onClick={handleDownload}>
                  <Download className="w-4 h-4" /> Download Preview
                </Button>
                <Button
                  size="sm"
                  onClick={() => { setStatus("idle"); setPermalinkSlug(null); }}
                >
                  Make Another
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-3">
              <Button
                onClick={handleGenerate}
                disabled={status === "generating" || isUploadingFile}
                className="flex-1"
              >
                {status === "generating" ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Generating…</>
                ) : !isAuthenticated ? (
                  "Login to Generate"
                ) : (
                  "Generate Meme"
                )}
              </Button>
              <Button variant="secondary" className="gap-2 shrink-0" onClick={handleDownload}>
                <Download className="w-4 h-4" />
                <span className="hidden sm:inline">Download Preview</span>
              </Button>
            </div>
          )}

          {/* Pexels attribution (shown when stock photo is used) */}
          {imageMode === "stock" && stockPhoto && (
            <p className="text-[10px] text-muted-foreground/50 text-center">
              Photos provided by{" "}
              <a
                href="https://www.pexels.com"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-muted-foreground"
              >
                Pexels
              </a>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
