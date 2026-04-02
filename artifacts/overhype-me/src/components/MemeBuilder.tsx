import {
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { Link } from "wouter";
import { usePersonName } from "@/hooks/use-person-name";
import { useListMemeTemplates } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
  Sparkles,
  AlertCircle,
  Copy,
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
type ImageMode = "gradient" | "stock" | "upload";
type StockGender = "man" | "woman" | "person";
type TextEffect = "shadow" | "outline" | "none";

interface StockPhoto {
  id: number;
  photographerName: string;
  photographerUrl: string;
  photoUrl: string;
}

interface MemeTextOpts {
  topYPct: number;
  bottomYPct: number;
  fontFamily: string;
  fontSize: number;
  textColor: string;
  outlineColor: string;
  textEffect: TextEffect;
  outlineWidth: number;
  allCaps: boolean;
  bold: boolean;
  italic: boolean;
  textAlign: TextAlign;
  opacity: number;
}

const FONT_LIST = [
  "Impact", "Arial", "Comic Sans MS", "Helvetica", "Times New Roman",
  "Times", "Courier New", "Courier", "Verdana", "Georgia",
  "Palatino", "Garamond", "Trebuchet MS", "Arial Black",
];

function intelligentSplit(text: string): number {
  const words = text.split(/\s+/).filter(w => w);
  if (words.length <= 2) return words.length;
  const mid = Math.ceil(words.length / 2);
  for (const delta of [0, -1, 1, -2, 2, -3, 3]) {
    const idx = mid + delta;
    if (idx > 0 && idx < words.length) {
      const word = words[idx - 1];
      if (/[,.\-!?;:—–]$/.test(word ?? "")) return idx;
    }
  }
  return mid;
}

// ─── Canvas drawing ────────────────────────────────────────────────────────────

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
  topText: string,
  bottomText: string,
  opts: MemeTextOpts,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

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

  const sidebarW = 12;
  const accent = bgImage ? "#FF3C00" : (ACCENT_COLORS[templateId] ?? "#ff6600");
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, sidebarW, CANVAS_H);

  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.font = `bold ${Math.floor(CANVAS_H * 0.45)}px serif`;
  ctx.textAlign = "right";
  ctx.fillText("OM", CANVAS_W - 24, CANVAS_H * 0.72);

  const padding = 40;
  const maxW = CANVAS_W - padding * 2 - sidebarW;
  const fontStyle = `${opts.italic ? "italic " : ""}${opts.bold ? "bold " : ""}`;
  const fontStr = `${fontStyle}${opts.fontSize}px "${opts.fontFamily}", sans-serif`;
  ctx.font = fontStr;

  const textAreaLeft = padding + sidebarW;
  const textAreaRight = CANVAS_W - padding;
  const textX =
    opts.textAlign === "right" ? textAreaRight
    : opts.textAlign === "center" ? (textAreaLeft + textAreaRight) / 2
    : textAreaLeft + 4;

  function wrapText(text: string): string[] {
    const display = opts.allCaps ? text.toUpperCase() : text;
    ctx.font = fontStr;
    const words = display.split(" ");
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
    return lines;
  }

  function renderBlock(lines: string[], yPct: number) {
    if (lines.length === 0) return;
    const lineH = opts.fontSize * 1.25;
    const startY = (yPct / 100) * CANVAS_H;

    ctx.save();
    ctx.globalAlpha = opts.opacity;
    ctx.font = fontStr;
    ctx.textAlign = opts.textAlign;

    lines.forEach((line, i) => {
      const y = startY + i * lineH;
      if (opts.textEffect === "outline") {
        ctx.strokeStyle = opts.outlineColor;
        ctx.lineWidth = opts.outlineWidth * 2;
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        ctx.strokeText(line, textX, y);
      }
      if (opts.textEffect === "shadow") {
        ctx.shadowColor = "rgba(0,0,0,0.85)";
        ctx.shadowBlur = 8;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;
      }
      ctx.fillStyle = opts.textColor;
      ctx.fillText(line, textX, y);
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    });
    ctx.restore();
  }

  if (topText.trim()) renderBlock(wrapText(topText), opts.topYPct);
  if (bottomText.trim()) renderBlock(wrapText(bottomText), opts.bottomYPct);

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

interface PexelsPhotoSrc {
  original: string;
  large2x: string;
  large: string;
  medium: string;
  small: string;
  portrait: string;
  landscape: string;
  tiny: string;
}

interface PexelsPhotoEntry {
  id: number;
  url: string;
  photographer?: string;
  photographer_url?: string;
  src?: PexelsPhotoSrc;
}

interface FactPexelsImages {
  fact_type: "action" | "abstract";
  male:    (number | PexelsPhotoEntry)[];
  female:  (number | PexelsPhotoEntry)[];
  neutral: (number | PexelsPhotoEntry)[];
  keywords?: {
    male:    string;
    female:  string;
    neutral: string;
  };
}

interface MemeBuilderProps {
  factId: number;
  factText: string;
  pexelsImages?: FactPexelsImages | null;
  onClose: () => void;
}

export function MemeBuilder({ factId, factText, pexelsImages, onClose }: MemeBuilderProps) {
  const { isAuthenticated, login, user } = useAuth() as {
    isAuthenticated: boolean;
    login: () => void;
    user?: { id?: string; membershipTier?: string; isAdmin?: boolean; isRealAdmin?: boolean };
  };
  const isPremium = user?.membershipTier === "premium";
  const isAdmin = !!(user?.isAdmin && user?.isRealAdmin);
  const { pronouns } = usePersonName();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const GENDER_TO_VARIANT: Record<StockGender, "male" | "female" | "neutral"> = {
    man: "male", woman: "female", person: "neutral",
  };

  const pexelsCdnUrl = (photoId: number, w = 940, h = 500) =>
    `https://images.pexels.com/photos/${photoId}/pexels-photo-${photoId}.jpeg?auto=compress&cs=tinysrgb&w=${w}&h=${h}&fit=crop&dpr=1`;

  const inferredGender = useMemo<StockGender>(() => {
    const p = (pronouns ?? "").toLowerCase();
    if (p.startsWith("he")) return "man";
    if (p.startsWith("she")) return "woman";
    return "person";
  }, [pronouns]);

  // Image source state
  const [imageMode, setImageMode] = useState<ImageMode>("gradient");
  const [selectedTemplate, setSelectedTemplate] = useState("action");
  const [stockGender, setStockGender] = useState<StockGender | null>(null);
  const [stockPhoto, setStockPhoto] = useState<StockPhoto | null>(null);
  const [isLoadingStock, setIsLoadingStock] = useState(false);
  const [stockError, setStockError] = useState<string | null>(null);
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<{ triggered?: number; error?: string } | null>(null);
  const [prefetchedIndex, setPrefetchedIndex] = useState<number | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadObjectPath, setUploadObjectPath] = useState<string | null>(null);
  const [uploadLocalUrl, setUploadLocalUrl] = useState<string | null>(null);
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  // Canvas background image (loaded from stock/upload for preview)
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const [isBgLoading, setIsBgLoading] = useState(false);

  // Text split + content
  const factWords = useMemo(() => factText.split(/\s+/).filter(w => w), [factText]);
  const defaultSplit = useMemo(() => intelligentSplit(factText), [factText]);
  const [splitPos, setSplitPos] = useState(defaultSplit);
  const [topText, setTopText] = useState(() => {
    const w = factText.split(/\s+/).filter(v => v);
    return w.slice(0, intelligentSplit(factText)).join(" ");
  });
  const [bottomText, setBottomText] = useState(() => {
    const w = factText.split(/\s+/).filter(v => v);
    return w.slice(intelligentSplit(factText)).join(" ");
  });
  const [textManuallyEdited, setTextManuallyEdited] = useState(false);

  useEffect(() => {
    const sp = intelligentSplit(factText);
    const words = factText.split(/\s+/).filter(w => w);
    setSplitPos(sp);
    setTopText(words.slice(0, sp).join(" "));
    setBottomText(words.slice(sp).join(" "));
    setTextManuallyEdited(false);
  }, [factText]);

  // Text styling
  const [fontFamily, setFontFamily] = useState("Impact");
  const [fontSize, setFontSize] = useState(30);
  const [textColor, setTextColor] = useState("#ffffff");
  const [outlineColor, setOutlineColor] = useState("#000000");
  const [textEffect, setTextEffect] = useState<TextEffect>("outline");
  const [outlineWidth, setOutlineWidth] = useState(5);
  const [allCaps, setAllCaps] = useState(true);
  const [bold, setBold] = useState(true);
  const [italic, setItalic] = useState(false);
  const [textAlign, setTextAlign] = useState<TextAlign>("center");
  const [opacity, setOpacity] = useState(1);
  const [topY, setTopY] = useState(17);
  const [bottomY, setBottomY] = useState(88);

  // Generation state
  const [status, setStatus] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [permalinkSlug, setPermalinkSlug] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Top-level mode: "classic" | "ai"
  const [builderMode, setBuilderMode] = useState<"classic" | "ai">("classic");

  // AI Meme state
  const aiGender = useMemo<"male" | "female" | "neutral">(() => {
    const p = (pronouns ?? "").toLowerCase();
    if (p.startsWith("he")) return "male";
    if (p.startsWith("she")) return "female";
    return "neutral";
  }, [pronouns]);
  const [aiMemeImageIndex, setAiMemeImageIndex] = useState(0);
  const [aiMemeHasImages, setAiMemeHasImages] = useState(false);
  const [aiMemeLoading, setAiMemeLoading] = useState(false);
  const [aiMemeCopied, setAiMemeCopied] = useState(false);

  // Load AI meme preference and check if images exist
  useEffect(() => {
    if (!factId) return;
    // Check if AI meme image is available by fetching the endpoint (HEAD-like check)
    fetch(`/api/memes/ai/${factId}/image?gender=${aiGender}&imageIndex=0`)
      .then(r => { setAiMemeHasImages(r.ok); })
      .catch(() => { setAiMemeHasImages(false); });
    // Load saved preference
    fetch(`/api/facts/${factId}/ai-meme-preference`, { credentials: "include" })
      .then(r => r.ok ? r.json() as Promise<{ aiMemeImageIndex: number }> : null)
      .then(data => { if (data) setAiMemeImageIndex(Math.min(2, Math.max(0, data.aiMemeImageIndex))); })
      .catch(() => {});
  }, [factId, aiGender]);

  const aiMemeImageUrl = useMemo(() => {
    if (!factId) return null;
    const uid = user?.id ?? "";
    return `/api/memes/ai/${factId}/image?gender=${aiGender}&imageIndex=${aiMemeImageIndex}${uid ? `&userId=${uid}` : ""}`;
  }, [factId, aiGender, aiMemeImageIndex, user]);

  const handleAiTryAnother = async () => {
    const next = (aiMemeImageIndex + 1) % 3;
    setAiMemeImageIndex(next);
    setAiMemeLoading(true);
    if (user) {
      await fetch(`/api/facts/${factId}/ai-meme-preference`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aiMemeImageIndex: next }),
      }).catch(() => {});
    }
  };

  const handleAiDownload = () => {
    if (!aiMemeImageUrl) return;
    fetch(aiMemeImageUrl, { credentials: "include" })
      .then(r => r.blob())
      .then(blob => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `overhype-ai-meme-${factId}.jpg`;
        a.click();
      })
      .catch(console.error);
  };

  const handleAiCopyLink = () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setAiMemeCopied(true);
      setTimeout(() => setAiMemeCopied(false), 2000);
    });
  };

  const queryClient = useQueryClient();
  const { data: tplData } = useListMemeTemplates();

  const handleSplitChange = useCallback((newPos: number) => {
    setSplitPos(newPos);
    setTopText(factWords.slice(0, newPos).join(" "));
    setBottomText(factWords.slice(newPos).join(" "));
    setTextManuallyEdited(false);
  }, [factWords]);

  // ── Canvas redraw ────────────────────────────────────────────────
  const memeOpts: MemeTextOpts = useMemo(() => ({
    fontFamily, fontSize, textColor, outlineColor, textEffect,
    outlineWidth, allCaps, bold, italic, textAlign, opacity,
    topYPct: topY, bottomYPct: bottomY,
  }), [fontFamily, fontSize, textColor, outlineColor, textEffect, outlineWidth, allCaps, bold, italic, textAlign, opacity, topY, bottomY]);

  const redraw = useCallback(() => {
    if (canvasRef.current) {
      drawMeme(canvasRef.current, bgImage, selectedTemplate, topText, bottomText, memeOpts);
    }
  }, [bgImage, selectedTemplate, topText, bottomText, memeOpts]);

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

  const [prefetchedPhotos, setPrefetchedPhotos] = useState<PexelsPhotoEntry[]>(() => {
    if (!pexelsImages || !stockGender) return [];
    const variant = GENDER_TO_VARIANT[stockGender];
    const raw = pexelsImages[variant] ?? [];
    return raw.map(entry =>
      typeof entry === "number"
        ? { id: entry, url: pexelsCdnUrl(entry) }
        : entry
    );
  });

  useEffect(() => {
    setStockError(null);
    if (!pexelsImages || !stockGender) { setPrefetchedPhotos([]); return; }
    const variant = GENDER_TO_VARIANT[stockGender];
    const raw = pexelsImages[variant] ?? [];
    setPrefetchedPhotos(raw.map(entry =>
      typeof entry === "number"
        ? { id: entry, url: pexelsCdnUrl(entry) }
        : entry
    ));
  }, [pexelsImages, stockGender]);

  const selectPrefetchedPhoto = useCallback((photo: PexelsPhotoEntry, index: number) => {
    setPrefetchedIndex(index);
    setStockPhoto({
      id: photo.id,
      photographerName: photo.photographer ?? "Pexels",
      photographerUrl: photo.photographer_url ?? "https://www.pexels.com",
      photoUrl: photo.src?.large ?? photo.url,
    });
  }, []);

  const fetchStockPhoto = useCallback(async (gender: StockGender) => {
    if (!isAuthenticated) return;

    const variant = GENDER_TO_VARIANT[gender];
    const raw = pexelsImages?.[variant] ?? [];
    if (raw.length > 0) {
      const first = typeof raw[0] === "number"
        ? { id: raw[0], url: pexelsCdnUrl(raw[0]) }
        : raw[0]!;
      selectPrefetchedPhoto(first, 0);
      return;
    }

    setIsLoadingStock(true);
    setStockError(null);
    setPrefetchedIndex(null);
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
  }, [isAuthenticated, pexelsImages, selectPrefetchedPhoto]);

  const handleBackfillAllImages = useCallback(async () => {
    if (isBackfilling) return;
    setIsBackfilling(true);
    setBackfillResult(null);
    try {
      const res = await fetch(`/api/admin/facts/${factId}/refresh-images`, { method: "POST", credentials: "include" });
      const data = await res.json() as { success?: boolean; message?: string; error?: string };
      if (!res.ok) setBackfillResult({ error: data.error ?? "Regeneration failed" });
      else setBackfillResult({ triggered: 1 });
    } catch {
      setBackfillResult({ error: "Network error" });
    } finally {
      setIsBackfilling(false);
    }
  }, [isBackfilling, factId]);



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

    if (uploadLocalUrl) URL.revokeObjectURL(uploadLocalUrl);
    const localUrl = URL.createObjectURL(file);
    setUploadLocalUrl(localUrl);

    try {
      // POST binary directly to the API server — server uploads to GCS
      // (much faster than browser→GCS presigned PUT through Replit proxy)
      const uploadRes = await fetch("/api/storage/upload-meme", {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!uploadRes.ok) {
        const body = await uploadRes.json() as { error?: string };
        throw new Error(body.error ?? "Upload failed");
      }
      const { objectPath } = await uploadRes.json() as { objectPath: string };
      setUploadObjectPath(objectPath);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Upload failed");
      setUploadFile(null);
      setUploadLocalUrl(null);
      URL.revokeObjectURL(localUrl);
    } finally {
      setIsUploadingFile(false);
    }
  }, []);

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
        imageMode === "gradient"
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
            topText,
            bottomText,
            fontFamily,
            fontSize,
            color: textColor,
            outlineColor,
            textEffect,
            outlineWidth,
            allCaps,
            bold,
            italic,
            align: textAlign,
            opacity,
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
      queryClient.invalidateQueries({ queryKey: ["listFactMemes", factId] });
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

        {/* ── Top-level tabs: Classic / AI Meme ── */}
        <div className="flex border-b-2 border-border px-5">
          <button
            onClick={() => setBuilderMode("classic")}
            className={`px-4 py-3 text-sm font-display uppercase tracking-wider border-b-2 -mb-[2px] transition-all flex items-center gap-2 ${
              builderMode === "classic"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Classic Meme
          </button>
          <button
            onClick={() => setBuilderMode("ai")}
            className={`px-4 py-3 text-sm font-display uppercase tracking-wider border-b-2 -mb-[2px] transition-all flex items-center gap-2 ${
              builderMode === "ai"
                ? "border-violet-400 text-violet-400"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            AI Meme
          </button>
        </div>

        {/* ── AI Meme Panel ── */}
        {builderMode === "ai" && (
          <div className="p-4 md:p-5 space-y-5">
            {!aiMemeHasImages ? (
              <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
                <Sparkles className="w-12 h-12 text-violet-400/50" />
                <p className="text-muted-foreground text-sm max-w-xs">
                  AI-generated backgrounds haven't been created for this fact yet.
                  Ask an admin to generate them from the admin panel.
                </p>
              </div>
            ) : (
              <>
                {/* AI Meme Image Display */}
                <div className="relative bg-black/20 border-2 border-violet-500/30 overflow-hidden">
                  <img
                    key={aiMemeImageUrl ?? ""}
                    src={aiMemeImageUrl ?? ""}
                    alt="AI generated meme"
                    className="w-full h-auto"
                    onLoad={() => setAiMemeLoading(false)}
                    onError={() => setAiMemeLoading(false)}
                  />
                  {aiMemeLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                      <Loader2 className="w-8 h-8 text-violet-400 animate-spin" />
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex flex-wrap gap-3">
                  <Button
                    onClick={() => { setAiMemeLoading(true); void handleAiTryAnother(); }}
                    variant="outline"
                    className="gap-2 border-violet-500/50 text-violet-400 hover:border-violet-400"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Try Another <span className="text-xs opacity-60">({aiMemeImageIndex + 1}/3)</span>
                  </Button>
                  <Button onClick={handleAiDownload} variant="secondary" className="gap-2">
                    <Download className="w-4 h-4" /> Download
                  </Button>
                  <Button onClick={handleAiCopyLink} variant="outline" className="gap-2">
                    {aiMemeCopied ? <CheckCircle className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                    {aiMemeCopied ? "Copied!" : "Copy Link"}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground/60">
                  AI-generated scene • Powered by OpenAI gpt-image-1
                </p>
              </>
            )}
          </div>
        )}

        <div className={`p-4 md:p-5 space-y-5 ${builderMode === "ai" ? "hidden" : ""}`}>

          {/* ── Canvas preview ── */}
          <div className="relative sticky top-14 z-10 bg-card pb-2">
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
                    onClick={() => {
                      setImageMode("stock");
                      if (!stockGender) {
                        setStockGender(inferredGender);
                        fetchStockPhoto(inferredGender);
                      }
                    }}
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
                    {stockGender && (
                      <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                        Showing: <span className="text-primary">{stockGender}</span> (from {pronouns || "they/them"} pronouns)
                      </p>
                    )}

                    {/* Pre-fetched thumbnail gallery */}
                    {prefetchedPhotos.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                          Matched photos for this fact
                        </p>
                        <div className="grid grid-cols-5 gap-1.5">
                          {prefetchedPhotos.map((photo, i) => (
                            <button
                              key={photo.id}
                              onClick={() => selectPrefetchedPhoto(photo, i)}
                              className={`relative aspect-video border-2 overflow-hidden transition-all ${
                                prefetchedIndex === i
                                  ? "border-primary ring-2 ring-primary/30 scale-105"
                                  : "border-border hover:border-primary/50"
                              }`}
                            >
                              <img
                                src={photo.src?.small ?? photo.url}
                                alt={`Option ${i + 1}`}
                                className="w-full h-full object-cover"
                                loading="lazy"
                                onError={() => {
                                  setPrefetchedPhotos(prev => {
                                    const next = prev.filter((_, idx) => idx !== i);
                                    if (prefetchedIndex === i) {
                                      const adjacent = next[Math.min(i, next.length - 1)];
                                      if (adjacent) {
                                        const newIdx = Math.min(i, next.length - 1);
                                        setPrefetchedIndex(newIdx);
                                        setStockPhoto({ id: adjacent.id, photographerName: adjacent.photographer ?? "Pexels", photographerUrl: adjacent.photographer_url ?? "https://www.pexels.com", photoUrl: adjacent.src?.large ?? adjacent.url });
                                      } else {
                                        setPrefetchedIndex(null);
                                      }
                                    } else if (prefetchedIndex !== null && prefetchedIndex > i) {
                                      setPrefetchedIndex(prefetchedIndex - 1);
                                    }
                                    return next;
                                  });
                                }}
                              />
                              {prefetchedIndex === i && (
                                <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-primary rounded-full border border-white" />
                              )}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Debug: show search keywords */}
                    {pexelsImages?.keywords && stockGender && (
                      <p className="text-[10px] text-muted-foreground/60 italic border border-dashed border-border/50 px-2 py-1 rounded-sm">
                        Search: "{pexelsImages.keywords[GENDER_TO_VARIANT[stockGender]]}"
                      </p>
                    )}

                    {/* Admin: regenerate all facts' images */}
                    {isAdmin && (
                      <div className="border border-dashed border-amber-500/40 bg-amber-500/5 rounded-sm px-2 py-1.5 flex flex-col gap-1">
                        <p className="text-[10px] font-semibold text-amber-600 uppercase tracking-wider">Admin</p>
                        <button
                          onClick={handleBackfillAllImages}
                          disabled={isBackfilling}
                          className="flex items-center gap-1.5 text-[11px] font-medium text-amber-700 hover:text-amber-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          <RefreshCw className={`w-3 h-3 ${isBackfilling ? "animate-spin" : ""}`} />
                          {isBackfilling ? "Regenerating…" : "Regenerate Images"}
                        </button>
                        {backfillResult && (
                          <p className={`text-[10px] ${backfillResult.error ? "text-destructive" : "text-green-600"}`}>
                            {backfillResult.error
                              ? `Error: ${backfillResult.error}`
                              : "Regeneration started — new photos will appear shortly."}
                          </p>
                        )}
                      </div>
                    )}

                    {stockPhoto && (
                      <p className="text-[10px] text-muted-foreground truncate">
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
                      <p className="text-[10px] text-destructive">{stockError}</p>
                    )}
                    {isLoadingStock && (
                      <div className="flex items-center justify-center py-2">
                        <Loader2 className="w-4 h-4 text-primary animate-spin" />
                      </div>
                    )}
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
                  {/* Split slider */}
                  <div>
                    <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground block mb-2">
                      Split Position: {splitPos} / {factWords.length} words
                      {textManuallyEdited && <span className="text-yellow-500 ml-2">(resets custom edits)</span>}
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={factWords.length}
                      value={splitPos}
                      onChange={e => handleSplitChange(parseInt(e.target.value))}
                      className="w-full accent-primary"
                    />
                  </div>

                  {/* Top text */}
                  <div>
                    <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground block mb-1">
                      Top Text
                    </label>
                    <textarea
                      value={topText}
                      onChange={e => { setTopText(e.target.value); setTextManuallyEdited(true); }}
                      rows={2}
                      className="w-full bg-background border-2 border-border text-foreground text-sm px-3 py-2 resize-none focus:border-primary focus:outline-none"
                      placeholder="Top text…"
                    />
                    <div className="mt-1.5">
                      <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground flex justify-between mb-1">
                        <span>Vertical Position</span>
                        <span className="tabular-nums">{topY}%</span>
                      </label>
                      <input
                        type="range"
                        min={0}
                        max={bottomY}
                        value={topY}
                        onChange={e => setTopY(parseInt(e.target.value))}
                        className="w-full accent-primary"
                      />
                    </div>
                  </div>

                  {/* Bottom text */}
                  <div>
                    <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground block mb-1">
                      Bottom Text
                    </label>
                    <textarea
                      value={bottomText}
                      onChange={e => { setBottomText(e.target.value); setTextManuallyEdited(true); }}
                      rows={2}
                      className="w-full bg-background border-2 border-border text-foreground text-sm px-3 py-2 resize-none focus:border-primary focus:outline-none"
                      placeholder="Bottom text…"
                    />
                    <div className="mt-1.5">
                      <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground flex justify-between mb-1">
                        <span>Vertical Position</span>
                        <span className="tabular-nums">{bottomY}%</span>
                      </label>
                      <input
                        type="range"
                        min={topY}
                        max={100}
                        value={bottomY}
                        onChange={e => setBottomY(parseInt(e.target.value))}
                        className="w-full accent-primary"
                      />
                    </div>
                  </div>

                  {/* Font family */}
                  <div>
                    <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground block mb-1">
                      Font
                    </label>
                    <select
                      value={fontFamily}
                      onChange={e => setFontFamily(e.target.value)}
                      className="w-full bg-background border-2 border-border text-foreground text-sm px-3 py-2 focus:border-primary focus:outline-none"
                    >
                      {FONT_LIST.map(f => (
                        <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
                      ))}
                    </select>
                  </div>

                  {/* ALL CAPS / Bold / Italic */}
                  <div className="flex gap-3">
                    {([
                      ["ALL CAPS", allCaps, setAllCaps],
                      ["Bold", bold, setBold],
                      ["Italic", italic, setItalic],
                    ] as [string, boolean, (v: boolean) => void][]).map(([label, val, setter]) => (
                      <label key={label} className="flex items-center gap-1.5 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={val}
                          onChange={e => setter(e.target.checked)}
                          className="accent-primary w-3.5 h-3.5"
                        />
                        <span className={`text-[11px] font-bold uppercase tracking-wider ${val ? "text-primary" : "text-muted-foreground"}`}>
                          {label}
                        </span>
                      </label>
                    ))}
                  </div>

                  {/* Text Effect: Shadow / Outline / None */}
                  <div>
                    <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
                      Text Effect
                    </p>
                    <div className="flex gap-2">
                      {(["shadow", "outline", "none"] as TextEffect[]).map(e => (
                        <button
                          key={e}
                          onClick={() => setTextEffect(e)}
                          className={`flex-1 py-1.5 text-[11px] font-bold uppercase tracking-wider border-2 transition-all ${
                            textEffect === e
                              ? "border-primary bg-primary/15 text-primary"
                              : "border-border text-muted-foreground hover:border-primary/40"
                          }`}
                        >
                          {e}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Outline width (visible when outline selected) */}
                  {textEffect === "outline" && (
                    <div>
                      <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground block mb-2">
                        Outline Width: {outlineWidth}
                      </label>
                      <input
                        type="range"
                        min={1}
                        max={10}
                        value={outlineWidth}
                        onChange={e => setOutlineWidth(parseInt(e.target.value))}
                        className="w-full accent-primary"
                      />
                    </div>
                  )}

                  {/* Font size */}
                  <div>
                    <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground block mb-2">
                      Font Size: {fontSize}px
                    </label>
                    <input
                      type="range"
                      min={30}
                      max={100}
                      value={fontSize}
                      onChange={e => setFontSize(parseInt(e.target.value))}
                      className="w-full accent-primary"
                    />
                  </div>

                  {/* Colors row */}
                  <div className="flex gap-4">
                    <div className="flex-1">
                      <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground block mb-1">
                        Text Color
                      </label>
                      <div className="flex gap-1.5 items-center flex-wrap">
                        {["#ffffff", "#ffcc00", "#FF3C00", "#00ff88", "#000000"].map(c => (
                          <button
                            key={c}
                            onClick={() => setTextColor(c)}
                            className={`w-6 h-6 rounded-full border-2 transition-all ${
                              textColor === c ? "border-white scale-110 ring-2 ring-white/30" : "border-transparent hover:scale-105"
                            }`}
                            style={{ background: c }}
                          />
                        ))}
                        <input
                          type="color"
                          value={textColor}
                          onChange={e => setTextColor(e.target.value)}
                          className="w-6 h-6 rounded-full border-2 border-border cursor-pointer bg-transparent"
                        />
                      </div>
                    </div>
                    {textEffect === "outline" && (
                      <div className="flex-1">
                        <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground block mb-1">
                          Outline Color
                        </label>
                        <div className="flex gap-1.5 items-center flex-wrap">
                          {["#000000", "#333333", "#1a237e", "#bf360c", "#ffffff"].map(c => (
                            <button
                              key={c}
                              onClick={() => setOutlineColor(c)}
                              className={`w-6 h-6 rounded-full border-2 transition-all ${
                                outlineColor === c ? "border-primary scale-110 ring-2 ring-primary/30" : "border-transparent hover:scale-105"
                              }`}
                              style={{ background: c }}
                            />
                          ))}
                          <input
                            type="color"
                            value={outlineColor}
                            onChange={e => setOutlineColor(e.target.value)}
                            className="w-6 h-6 rounded-full border-2 border-border cursor-pointer bg-transparent"
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Text align */}
                  <div>
                    <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground mb-2">
                      Text Align
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

                  {/* Opacity */}
                  <div>
                    <label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground block mb-2">
                      Opacity: {opacity.toFixed(1)}
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.1}
                      value={opacity}
                      onChange={e => setOpacity(parseFloat(e.target.value))}
                      className="w-full accent-primary"
                    />
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
