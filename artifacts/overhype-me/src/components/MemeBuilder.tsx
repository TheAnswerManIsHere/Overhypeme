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
import { IMAGE_STYLES } from "@/config/imageStyles";
import { ImageCard } from "@/components/ui/ImageCard";
import { usePersonName } from "@/hooks/use-person-name";
import { useListMemeTemplates } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
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
  Globe,
  ImageIcon,
  Layers,
  Sparkles,
  Flame,
  Trash2,
  Clapperboard,
} from "lucide-react";

// ─── Canvas constants ──────────────────────────────────────────────────────────

const CANVAS_W = 800;
const CANVAS_H = 420;

const GRADIENT_DEFS: Record<string, [string, string][]> = {
  action:   [["#0a0e2e", "0%"], ["#1a237e", "55%"], ["#283593", "100%"]],
  fire:     [["#bf360c", "0%"], ["#e64a19", "50%"], ["#ff6d00", "100%"]],
  night:    [["#0a0a0a", "0%"], ["#1b2420", "55%"], ["#263238", "100%"]],
  gold:     [["#4a2c00", "0%"], ["#f57f17", "60%"], ["#ffd54f", "100%"]],
  cinema:   [["#2d1e00", "0%"], ["#5d4037", "55%"], ["#8d6e63", "100%"]],
  neon:     [["#0d0221", "0%"], ["#4a0060", "55%"], ["#e91e8c", "100%"]],
  ocean:    [["#000428", "0%"], ["#004e92", "55%"], ["#0288d1", "100%"]],
  crimson:  [["#1a0000", "0%"], ["#7b0000", "55%"], ["#c62828", "100%"]],
  galaxy:   [["#0c0019", "0%"], ["#311b92", "55%"], ["#4527a0", "100%"]],
  storm:    [["#0d0d0d", "0%"], ["#263238", "55%"], ["#455a64", "100%"]],
  emerald:  [["#001a08", "0%"], ["#1b5e20", "55%"], ["#2e7d32", "100%"]],
  arctic:   [["#0a1929", "0%"], ["#0d47a1", "55%"], ["#1565c0", "100%"]],
  copper:   [["#1a0d00", "0%"], ["#6d3200", "55%"], ["#bf5900", "100%"]],
  twilight: [["#0d001a", "0%"], ["#6a1b9a", "55%"], ["#ab47bc", "100%"]],
  toxic:    [["#001400", "0%"], ["#1b5e20", "55%"], ["#33691e", "100%"]],
  rose:     [["#1a0005", "0%"], ["#880e4f", "55%"], ["#ad1457", "100%"]],
  volcano:  [["#100000", "0%"], ["#4e0000", "55%"], ["#b71c1c", "100%"]],
  retro:    [["#1a0030", "0%"], ["#7b1fa2", "50%"], ["#e64a19", "100%"]],
  midnight: [["#000814", "0%"], ["#001d3d", "55%"], ["#003566", "100%"]],
  chrome:   [["#0d0d0d", "0%"], ["#37474f", "55%"], ["#546e7a", "100%"]],
};

const ACCENT_COLORS: Record<string, string> = {
  action:   "#ff6600",
  fire:     "#ff6d00",
  night:    "#546e7a",
  gold:     "#ffd54f",
  cinema:   "#8d6e63",
  neon:     "#e91e8c",
  ocean:    "#0288d1",
  crimson:  "#ef5350",
  galaxy:   "#7c4dff",
  storm:    "#78909c",
  emerald:  "#43a047",
  arctic:   "#42a5f5",
  copper:   "#ff8f00",
  twilight: "#ce93d8",
  toxic:    "#69f0ae",
  rose:     "#f06292",
  volcano:  "#ef5350",
  retro:    "#ff6f00",
  midnight: "#1976d2",
  chrome:   "#90a4ae",
};

type TextAlign = "left" | "center" | "right";
type ImageMode = "gradient" | "stock" | "upload" | "ai";
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

type VideoState =
  | { status: "idle" }
  | { status: "generating" }
  | { status: "done"; url: string }
  | { status: "error"; message: string };

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

export interface AiMemeImages {
  male:    string[];
  female:  string[];
  neutral: string[];
}

interface MemeBuilderProps {
  factId: number;
  factText: string;
  /** Raw un-expanded template text (with tokens like {NAME}, {SUBJ}), used for scope detection */
  rawFactText?: string;
  pexelsImages?: FactPexelsImages | null;
  aiMemeImages?: AiMemeImages | null;
  onClose: () => void;
  /** When true, the Public/Private toggle is initialised to Private */
  defaultPrivate?: boolean;
  /** When true, renders without the outer modal wrapper (for use inside MemeStudio) */
  embedded?: boolean;
  /** Called when the user clicks "Turn This Into a Video". Receives the meme image as a data URL. */
  onMakeVideo?: (sourceImageDataUrl: string) => void;
}

export function MemeBuilder({ factId, factText, rawFactText, pexelsImages, aiMemeImages, onClose, defaultPrivate, embedded, onMakeVideo }: MemeBuilderProps) {
  const { isAuthenticated, login, role, user } = useAuth();
  const isPremium = role === "premium" || role === "admin";
  const isAdmin = role === "admin";
  const { pronouns } = usePersonName();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const refFileInputRef = useRef<HTMLInputElement>(null);

  // AI gallery display limit — fetched once from the admin-managed public config endpoint
  const [aiGalleryDisplayLimit, setAiGalleryDisplayLimit] = useState(50);
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((cfg: Record<string, number | string | boolean>) => {
        const val = cfg["ai_gallery_display_limit"];
        if (typeof val === "number" && val > 0) setAiGalleryDisplayLimit(val);
      })
      .catch(() => {});
  }, []);

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
  const [imageMode, setImageMode] = useState<ImageMode>("stock");
  const [thumbSize, setThumbSize] = useState(40); // 0–100 slider value
  const thumbPx = Math.round(70 + (thumbSize / 100) * (290 - 70)); // 70px–290px
  const [selectedTemplate, setSelectedTemplate] = useState("action");
  const [stockGender, setStockGender] = useState<StockGender | null>(null);
  const [stockPhoto, setStockPhoto] = useState<StockPhoto | null>(null);
  const [isLoadingStock, setIsLoadingStock] = useState(false);
  const [stockError, setStockError] = useState<string | null>(null);
  const [isBackfilling, setIsBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<{ triggered?: number; error?: string } | null>(null);
  const [prefetchedIndex, setPrefetchedIndex] = useState<number | null>(null);
  const [selectedStyleId, setSelectedStyleId] = useState("none");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadObjectPath, setUploadObjectPath] = useState<string | null>(null);
  const [uploadLocalUrl, setUploadLocalUrl] = useState<string | null>(null);
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [uploadIsLowRes, setUploadIsLowRes] = useState(false);
  const [uploadWidth, setUploadWidth] = useState<number | null>(null);
  const [uploadHeight, setUploadHeight] = useState<number | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Upload gallery — existing uploads for premium users
  interface UploadEntry {
    objectPath: string;
    width: number;
    height: number;
    isLowRes: boolean;
    fileSizeBytes: number;
    createdAt: string;
  }
  const [uploadGallery, setUploadGallery] = useState<UploadEntry[]>([]);
  const [uploadGalleryCount, setUploadGalleryCount] = useState(0);
  const [uploadGalleryMax, setUploadGalleryMax] = useState(1000);
  const [uploadGalleryDisplayLimit, setUploadGalleryDisplayLimit] = useState(50);
  const [isLoadingGallery, setIsLoadingGallery] = useState(false);
  // The URL to use for canvas preview — local blob URL for new uploads, storage URL for gallery picks
  const [uploadDisplayUrl, setUploadDisplayUrl] = useState<string | null>(null);

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
  const [topLines, setTopLines]       = useState(1);
  const [bottomLines, setBottomLines] = useState(1);

  // Visibility (premium-only private memes)
  const [isPublic, setIsPublic] = useState(!defaultPrivate);

  // Measure wrapped line counts whenever text or font options change.
  // Uses a hidden canvas for pixel-accurate measurement (same logic as drawMeme).
  useEffect(() => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const fontStyle = `${bold ? "bold " : ""}${italic ? "italic " : ""}`;
    ctx.font = `${fontStyle}${fontSize}px "${fontFamily}", sans-serif`;
    const maxW = 800 - 40 * 2 - 12; // CANVAS_W - padding*2 - sidebarW

    function countLines(text: string): number {
      const display = allCaps ? text.toUpperCase() : text;
      const words = display.split(" ");
      let lines = 1;
      let current = "";
      for (const w of words) {
        const test = current ? `${current} ${w}` : w;
        if (ctx.measureText(test).width > maxW && current) { lines++; current = w; }
        else { current = test; }
      }
      return lines;
    }

    setTopLines(topText.trim()    ? countLines(topText)    : 0);
    setBottomLines(bottomText.trim() ? countLines(bottomText) : 0);
  }, [topText, bottomText, fontSize, fontFamily, bold, italic, allCaps]);

  // Collision constraints — keep the two text blocks from overlapping.
  // lineH, cap-height (0.85×fontSize) and descender (0.25×fontSize) match drawMeme.
  const GAP_PX = 12;
  const textCollisionConstraints = useMemo(() => {
    const lineH = fontSize * 1.25;
    const blockHeightPx = (lines: number) =>
      (Math.max(1, lines) - 1) * lineH   // extra lines below first baseline
      + fontSize * 0.85                   // cap height above first baseline
      + fontSize * 0.25                   // descenders below last baseline
      + GAP_PX;                           // visual breathing room
    const topBlockPx = blockHeightPx(topLines);
    // maxTopY: top block's bottom must clear the bottom block's visual top
    const maxTopY   = Math.max(0,   Math.floor(bottomY - (topBlockPx / 420) * 100));
    // minBottomY: bottom block's visual top must clear the top block's bottom
    const minBottomY = Math.min(100, Math.ceil(topY    + (topBlockPx / 420) * 100));
    return { maxTopY, minBottomY };
  }, [topLines, fontSize, topY, bottomY]);

  // Clamp Y positions when constraints tighten (e.g. font size increase, text added).
  useEffect(() => {
    if (topY > textCollisionConstraints.maxTopY)
      setTopY(textCollisionConstraints.maxTopY);
  }, [topY, textCollisionConstraints.maxTopY]);
  useEffect(() => {
    if (bottomY < textCollisionConstraints.minBottomY)
      setBottomY(textCollisionConstraints.minBottomY);
  }, [bottomY, textCollisionConstraints.minBottomY]);

  // Generation state
  const [status, setStatus] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [permalinkSlug, setPermalinkSlug] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // First-time nudge: shown once per MemeBuilder session after first successful static meme
  const nudgeShownRef = useRef(false);
  const [showNudge, setShowNudge] = useState(false);

  // Whether this fact has gender tokens (for determining generation scope)
  // Must use rawFactText (unexpanded template) since factText is already personalized
  const factIsGendered = useMemo(() => {
    const textToCheck = rawFactText ?? factText;
    return /\{(NAME|SUBJ|OBJ|POSS|POSS_PRO|REFL|Subj|Obj|Poss|Poss_Pro|Refl|[^|{}]+\|[^|{}]+)\}/.test(textToCheck);
  }, [rawFactText, factText]);

  // AI image mode gender mapping
  // Abstract facts always use neutral (only neutral images are generated for them)
  const aiGender = useMemo<"male" | "female" | "neutral">(() => {
    if (!factIsGendered) return "neutral";
    const p = (pronouns ?? "").toLowerCase();
    if (p.startsWith("he")) return "male";
    if (p.startsWith("she")) return "female";
    return "neutral";
  }, [pronouns, factIsGendered]);

  // AI image panel state
  const [selectedAiIndex, setSelectedAiIndex] = useState<number | null>(null);
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [aiGenerateError, setAiGenerateError] = useState<string | null>(null);
  const [aiScenePromptsDebug, setAiScenePromptsDebug] = useState<Record<string, string> | null>(null);
  const [showPromptDebug, setShowPromptDebug] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [generationElapsed, setGenerationElapsed] = useState(0);
  const generationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [localAiMemeImages, setLocalAiMemeImages] = useState<AiMemeImages | null>(aiMemeImages ?? null);
  // Cache-buster timestamp: bumped after every successful regen so browser re-fetches the new image
  const [aiCacheBuster, setAiCacheBuster] = useState<number>(0);

  // AI sub-mode: generic (text-prompted) or reference (photo-based)
  const [aiSubMode, setAiSubMode] = useState<"generic" | "reference">("generic");
  // Reference photo picker state
  const [selectedRefUpload, setSelectedRefUpload] = useState<UploadEntry | null>(null);
  const [refUploads, setRefUploads] = useState<UploadEntry[]>([]);
  const [isLoadingRefUploads, setIsLoadingRefUploads] = useState(false);
  const [isUploadingRefPhoto, setIsUploadingRefPhoto] = useState(false);

  // Reference-generated AI images (only images generated via the reference photo flow)
  interface RefGenImage { id: number; storagePath: string; gender: string; createdAt: string; }
  const [refGenImages, setRefGenImages] = useState<RefGenImage[]>([]);
  const [isLoadingRefGenImages, setIsLoadingRefGenImages] = useState(false);
  // The storage path of the selected reference-generated image (for meme creation)
  const [selectedRefGenPath, setSelectedRefGenPath] = useState<string | null>(null);

  // Video generation state
  const [videoState, setVideoState] = useState<VideoState>({ status: "idle" });

  // Sync localAiMemeImages when prop changes
  useEffect(() => {
    setLocalAiMemeImages(aiMemeImages ?? null);
  }, [aiMemeImages]);

  const { toast } = useToast();

  useEffect(() => {
    return () => {
      if (generationTimerRef.current) {
        clearInterval(generationTimerRef.current);
        generationTimerRef.current = null;
      }
    };
  }, []);

  // Load most recent completed video on open
  useEffect(() => {
    setVideoState({ status: "idle" });
    fetch(`/api/videos/${factId}`, { credentials: "include" })
      .then(r => r.json())
      .then((data: { videos?: Array<{ id: number; videoUrl: string | null }> }) => {
        const latest = data.videos?.[0];
        if (latest?.videoUrl) {
          setVideoState({ status: "done", url: latest.videoUrl });
        }
      })
      .catch(() => {});
  }, [factId]);

  // The AI image slots for the current gender variant — newest-first, up to the admin-configured limit shown in gallery.
  // Each slot tracks path + original array index so the API imageIndex param remains correct
  // even for legacy data with empty-string placeholders at some positions.
  const aiImageSlots = useMemo<Array<{ path: string; origIdx: number }>>(() => {
    if (!localAiMemeImages) return [];
    const arr = localAiMemeImages[aiGender] ?? [];
    const slots: Array<{ path: string; origIdx: number }> = [];
    for (let i = 0; i < arr.length && slots.length < aiGalleryDisplayLimit; i++) {
      if (arr[i]) slots.push({ path: arr[i], origIdx: i });
    }
    return slots;
  }, [localAiMemeImages, aiGender]);

  // Whether any AI images exist for the current gender (used for conditional UI)
  const aiImagePaths = useMemo(() => aiImageSlots.map(s => s.path), [aiImageSlots]);

  // Auto-select first valid AI image when entering AI mode, images load, or selection is cleared
  useEffect(() => {
    if (imageMode === "ai" && aiImageSlots.length > 0 && selectedAiIndex === null) {
      setSelectedAiIndex(aiImageSlots[0].origIdx);
    }
  }, [imageMode, aiImageSlots, selectedAiIndex]);

  // Thumbnail URL for generic AI images — serve via the meme endpoint with raw=true
  // Cache-buster is appended after regen so the browser skips the cached old image
  const getAiThumbnailUrl = useCallback((index: number) => {
    if (!localAiMemeImages) return "";
    const storagePath = localAiMemeImages[aiGender]?.[index] ?? "";
    if (!storagePath) return "";
    const cb = aiCacheBuster ? `&cb=${aiCacheBuster}` : "";
    return `/api/memes/ai/${factId}/image?gender=${aiGender}&imageIndex=${index}&raw=true${cb}`;
  }, [localAiMemeImages, aiGender, factId, aiCacheBuster]);

  // Thumbnail URL for reference-generated images — served via user-specific authenticated endpoint
  const getRefAiThumbnailUrl = useCallback((storagePath: string) => {
    const cb = aiCacheBuster ? `&cb=${aiCacheBuster}` : "";
    return `/api/memes/ai-user/image?storagePath=${encodeURIComponent(storagePath)}${cb}`;
  }, [aiCacheBuster]);

  const handleGenerateNewAi = async () => {
    if (isGeneratingAi) return;
    // In reference sub-mode, require a photo to be selected
    if (aiSubMode === "reference" && !selectedRefUpload) {
      setAiGenerateError("Select a reference photo below before generating.");
      return;
    }
    setIsGeneratingAi(true);
    setAiGenerateError(null);
    setGenerationProgress(0);
    setGenerationElapsed(0);

    const startTime = Date.now();
    if (generationTimerRef.current) clearInterval(generationTimerRef.current);
    generationTimerRef.current = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000;
      setGenerationElapsed(Math.floor(elapsed));
      // Phase 1: 0→80% over 30s (linear)
      // Phase 2: 80→99% decaying (never reaches 100 on its own)
      let progress: number;
      if (elapsed <= 30) {
        progress = (elapsed / 30) * 80;
      } else {
        const extra = elapsed - 30;
        progress = 80 + 19 * (1 - Math.exp(-extra / 60));
      }
      setGenerationProgress(Math.min(progress, 99));
    }, 250);

    try {
      const POLL_INTERVAL = 4_000;
      const MAX_POLLS = 22; // ~88s

      const res = await fetch(`/api/memes/ai/${factId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(
          aiSubMode === "reference" && selectedRefUpload
            ? { referenceImagePath: selectedRefUpload.objectPath, targetGender: aiGender, styleId: selectedStyleId }
            : { scope: factIsGendered ? "gendered" : "abstract", styleId: selectedStyleId },
        ),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string; limitExceeded?: boolean };
        throw new Error(body.error ?? "Generation failed");
      }

      if (aiSubMode === "reference") {
        // Reference mode: poll user_ai_images until a new image appears for this fact+gender
        const baselineImages = await fetchRefGenImages().catch(() => null) ?? [];
        const baselineCount = baselineImages.filter(img => img.gender === aiGender).length;
        let polls = 0;

        const pollRef = async () => {
          polls++;
          try {
            const images = await fetchRefGenImages();
            if (images) {
              const newCount = images.filter(img => img.gender === aiGender).length;
              if (newCount > baselineCount) {
                if (generationTimerRef.current) { clearInterval(generationTimerRef.current); generationTimerRef.current = null; }
                setRefGenImages(images);
                // Auto-select the first (newest) image for this gender
                const newest = images.find(img => img.gender === aiGender);
                if (newest) setSelectedRefGenPath(newest.storagePath);
                setAiCacheBuster(Date.now());
                setTimeout(() => { setIsGeneratingAi(false); setGenerationProgress(0); setGenerationElapsed(0); }, 400);
                setGenerationProgress(100);
                fetch(`/api/memes/ai/${factId}/prompts`, { credentials: "include" })
                  .then(r => r.ok ? r.json() : null)
                  .then((d: { prompts: Record<string, string> | null } | null) => { if (d?.prompts) setAiScenePromptsDebug(d.prompts); })
                  .catch(() => {});
                return;
              }
            }
          } catch { /* keep polling */ }

          if (polls >= MAX_POLLS) {
            if (generationTimerRef.current) { clearInterval(generationTimerRef.current); generationTimerRef.current = null; }
            setGenerationProgress(0);
            setGenerationElapsed(0);
            setAiGenerateError("Generation is taking longer than expected. Click 'Generate New' again or refresh the page.");
            setIsGeneratingAi(false);
            return;
          }
          setTimeout(() => void pollRef(), POLL_INTERVAL);
        };
        setTimeout(() => void pollRef(), POLL_INTERVAL);
      } else {
        // Generic mode: poll aiMemeImages on the fact
        let baselineSlotPath: string | null = null;
        let baselineUpdatedAt: string | null = null;
        try {
          const initRes = await fetch(`/api/facts/${factId}`, { credentials: "include", cache: "no-store" });
          if (initRes.ok) {
            const init = await initRes.json() as { updatedAt?: string; aiMemeImages?: AiMemeImages | null };
            baselineSlotPath = init.aiMemeImages?.[aiGender]?.[0] ?? null;
            baselineUpdatedAt = init.updatedAt ?? null;
          }
        } catch { /* proceed without baseline */ }

        let polls = 0;
        const poll = async () => {
          polls++;
          try {
            const factRes = await fetch(`/api/facts/${factId}`, { credentials: "include", cache: "no-store" });
            if (factRes.ok) {
              const data = await factRes.json() as { updatedAt?: string; aiMemeImages?: AiMemeImages | null };
              const newSlotPath = data.aiMemeImages?.[aiGender]?.[0] ?? null;
              const newUpdatedAt = data.updatedAt ?? null;
              let done: boolean;
              if (baselineSlotPath === null) {
                done = newSlotPath !== null;
              } else {
                done = newUpdatedAt !== baselineUpdatedAt && newSlotPath !== null;
              }
              if (done) {
                if (generationTimerRef.current) { clearInterval(generationTimerRef.current); generationTimerRef.current = null; }
                setGenerationProgress(100);
                setLocalAiMemeImages(data.aiMemeImages ?? null);
                setSelectedAiIndex(0);
                setAiCacheBuster(Date.now());
                setTimeout(() => { setIsGeneratingAi(false); setGenerationProgress(0); setGenerationElapsed(0); }, 400);
                fetch(`/api/memes/ai/${factId}/prompts`, { credentials: "include" })
                  .then(r => r.ok ? r.json() : null)
                  .then((d: { prompts: Record<string, string> | null } | null) => { if (d?.prompts) setAiScenePromptsDebug(d.prompts); })
                  .catch(() => {});
                return;
              }
            }
          } catch { /* keep polling */ }

          if (polls >= MAX_POLLS) {
            if (generationTimerRef.current) { clearInterval(generationTimerRef.current); generationTimerRef.current = null; }
            setGenerationProgress(0);
            setGenerationElapsed(0);
            setAiGenerateError("Generation is taking longer than expected. Click 'Generate New' again or refresh the page.");
            setIsGeneratingAi(false);
            return;
          }
          setTimeout(() => void poll(), POLL_INTERVAL);
        };
        setTimeout(() => void poll(), POLL_INTERVAL);
      }
    } catch (e) {
      if (generationTimerRef.current) {
        clearInterval(generationTimerRef.current);
        generationTimerRef.current = null;
      }
      setGenerationProgress(0);
      setGenerationElapsed(0);
      setAiGenerateError(e instanceof Error ? e.message : "Generation failed");
      setIsGeneratingAi(false);
    }
  };



  const handleDeleteAiImage = async (origIdx: number) => {
    const res = await fetch(
      `/api/memes/ai/${factId}/image?gender=${aiGender}&imageIndex=${origIdx}`,
      { method: "DELETE", credentials: "include" }
    );
    if (!res.ok) {
      const body = await res.json() as { error?: string };
      throw new Error(body.error ?? "Delete failed");
    }
    setLocalAiMemeImages(prev => {
      if (!prev) return prev;
      const arr = [...(prev[aiGender] ?? [])];
      arr[origIdx] = "";
      return { ...prev, [aiGender]: arr };
    });
    if (selectedAiIndex === origIdx) setSelectedAiIndex(null);
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

  // ── Load stock/AI/upload image into canvas ───────────────────────
  const aiSelectedUrl = useMemo(() => {
    if (imageMode !== "ai") return null;
    if (aiSubMode === "reference") {
      return selectedRefGenPath ? getRefAiThumbnailUrl(selectedRefGenPath) : null;
    }
    if (selectedAiIndex === null) return null;
    return getAiThumbnailUrl(selectedAiIndex);
  }, [imageMode, aiSubMode, selectedAiIndex, selectedRefGenPath, getAiThumbnailUrl, getRefAiThumbnailUrl]);

  useEffect(() => {
    const photoUrl =
      imageMode === "stock" ? stockPhoto?.photoUrl ?? null :
      imageMode === "upload" ? uploadDisplayUrl :
      imageMode === "ai" ? aiSelectedUrl :
      null;

    if (!photoUrl) {
      setBgImage(null);
      return;
    }

    setIsBgLoading(true);
    let blobUrl: string | null = null;

    if (photoUrl.includes("/api/memes/ai-user/image")) {
      // Auth-protected route — must fetch via the auth interceptor, then load as blob URL
      fetch(photoUrl, { credentials: "include" })
        .then(r => r.ok ? r.blob() : null)
        .then(blob => {
          if (!blob) { setBgImage(null); setIsBgLoading(false); return; }
          blobUrl = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => { setBgImage(img); setIsBgLoading(false); };
          img.onerror = () => { setBgImage(null); setIsBgLoading(false); };
          img.src = blobUrl;
        })
        .catch(() => { setBgImage(null); setIsBgLoading(false); });
    } else {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => { setBgImage(img); setIsBgLoading(false); };
      img.onerror = () => { setBgImage(null); setIsBgLoading(false); };
      img.src = photoUrl;
    }

    return () => { if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [imageMode, stockPhoto, uploadDisplayUrl, aiSelectedUrl]);

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
    const variant = GENDER_TO_VARIANT[gender];
    const raw = pexelsImages?.[variant] ?? [];
    if (raw.length > 0) {
      const first = typeof raw[0] === "number"
        ? { id: raw[0], url: pexelsCdnUrl(raw[0]) }
        : raw[0]!;
      selectPrefetchedPhoto(first, 0);
      return;
    }

    if (!isAuthenticated) return;

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

  useEffect(() => {
    if (!stockGender) {
      setStockGender(inferredGender);
      fetchStockPhoto(inferredGender);
    }
  }, [stockGender, inferredGender, fetchStockPhoto]);

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

  const CLIENT_MAX_DIMENSION = 3600;
  const CLIENT_JPEG_QUALITY = 0.9;
  const LOW_RES_WARNING_PX = 1500;
  const CLIENT_MAX_UPLOAD_MB = 15;

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
      setErrorMsg("Please select an image file (JPEG, PNG, WebP, HEIC, or similar).");
      return;
    }

    setErrorMsg(null);
    setUploadFile(file);
    setIsUploadingFile(true);
    setUploadIsLowRes(false);
    setUploadWidth(null);
    setUploadHeight(null);

    if (uploadLocalUrl) URL.revokeObjectURL(uploadLocalUrl);
    const localUrl = URL.createObjectURL(file);
    setUploadLocalUrl(localUrl);
    setUploadDisplayUrl(localUrl);

    try {
      let uploadBlob: Blob = file;
      let imgWidth: number | null = null;
      let imgHeight: number | null = null;

      try {
        const processed = await preProcessImageFile(file);
        uploadBlob = processed.blob;
        imgWidth = processed.width;
        imgHeight = processed.height;

        const longestEdge = Math.max(processed.width, processed.height);
        if (longestEdge < LOW_RES_WARNING_PX) {
          setErrorMsg(
            `This image is ${processed.width}×${processed.height}px, which may appear blurry on printed merchandise.`
          );
        }
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
      const result = await uploadRes.json() as {
        objectPath: string;
        width?: number;
        height?: number;
        isLowRes?: boolean;
      };
      setUploadObjectPath(result.objectPath);
      setUploadIsLowRes(result.isLowRes ?? false);
      setUploadWidth(result.width ?? imgWidth);
      setUploadHeight(result.height ?? imgHeight);
      // Refresh gallery so the newly uploaded image appears in the grid
      fetch("/api/users/me/uploads", { credentials: "include" })
        .then(r => r.json())
        .then((data: { uploads?: UploadEntry[]; uploadCount?: number; maxUploads?: number; displayLimit?: number }) => {
          setUploadGallery(data.uploads ?? []);
          setUploadGalleryCount(data.uploadCount ?? 0);
          setUploadGalleryMax(data.maxUploads ?? 1000);
          if (data.displayLimit) setUploadGalleryDisplayLimit(data.displayLimit);
        })
        .catch(() => {});
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Upload failed");
      setUploadFile(null);
      setUploadLocalUrl(null);
      setUploadDisplayUrl(null);
      URL.revokeObjectURL(localUrl);
    } finally {
      setIsUploadingFile(false);
    }
  }, [uploadLocalUrl]);

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

  // Fetch the existing upload gallery when premium user is in upload mode
  useEffect(() => {
    if (!isPremium || imageMode !== "upload") return;
    let cancelled = false;
    setIsLoadingGallery(true);
    fetch("/api/users/me/uploads", { credentials: "include" })
      .then(r => r.json())
      .then((data: { uploads?: UploadEntry[]; uploadCount?: number; maxUploads?: number; displayLimit?: number }) => {
        if (cancelled) return;
        setUploadGallery(data.uploads ?? []);
        setUploadGalleryCount(data.uploadCount ?? 0);
        setUploadGalleryMax(data.maxUploads ?? 1000);
        if (data.displayLimit) setUploadGalleryDisplayLimit(data.displayLimit);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setIsLoadingGallery(false); });
    return () => { cancelled = true; };
  }, [isPremium, imageMode]);

  // Fetch reference photo uploads when in AI reference sub-mode
  useEffect(() => {
    if (!isPremium || imageMode !== "ai" || aiSubMode !== "reference") return;
    let cancelled = false;
    setIsLoadingRefUploads(true);
    fetch("/api/users/me/uploads", { credentials: "include" })
      .then(r => r.json())
      .then((data: { uploads?: UploadEntry[] }) => {
        if (cancelled) return;
        setRefUploads(data.uploads ?? []);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setIsLoadingRefUploads(false); });
    return () => { cancelled = true; };
  }, [isPremium, imageMode, aiSubMode]);

  // Fetch reference-generated AI images for this fact when in AI reference sub-mode
  const fetchRefGenImages = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch(`/api/users/me/ai-images?factId=${factId}&imageType=reference`, {
      credentials: "include",
      signal,
    });
    if (!res.ok) return null;
    const data = await res.json() as { images: Array<{ id: number; storagePath: string; gender: string; createdAt: string }> };
    return data.images;
  }, [factId]);

  useEffect(() => {
    if (!isPremium || imageMode !== "ai" || aiSubMode !== "reference") return;
    const controller = new AbortController();
    setIsLoadingRefGenImages(true);
    fetchRefGenImages(controller.signal)
      .then(images => { if (images) setRefGenImages(images); })
      .catch(() => {})
      .finally(() => setIsLoadingRefGenImages(false));
    return () => { controller.abort(); };
  }, [isPremium, imageMode, aiSubMode, fetchRefGenImages]);

  // Fetch scene prompts for debug panel when in AI mode (admin only)
  useEffect(() => {
    if (!isAdmin || imageMode !== "ai" || !factId) return;
    let cancelled = false;
    fetch(`/api/memes/ai/${factId}/prompts`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then((data: { prompts: Record<string, string> | null } | null) => {
        if (cancelled) return;
        setAiScenePromptsDebug(data?.prompts ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isAdmin, imageMode, factId]);

  // Upload a new reference photo (inline in AI reference sub-mode picker)
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
      const result = await uploadRes.json() as {
        objectPath: string;
        width?: number;
        height?: number;
        isLowRes?: boolean;
      };
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

  // Select an existing uploaded image as the meme background (no re-upload)
  const selectExistingUpload = useCallback((entry: UploadEntry) => {
    if (uploadLocalUrl) URL.revokeObjectURL(uploadLocalUrl);
    setUploadFile(null);
    setUploadLocalUrl(null);
    setUploadObjectPath(entry.objectPath);
    setUploadIsLowRes(entry.isLowRes);
    setUploadWidth(entry.width);
    setUploadHeight(entry.height);
    // Set the display URL — the canvas background effect will pick it up automatically
    setUploadDisplayUrl(`/api/storage${entry.objectPath}`);
  }, [uploadLocalUrl]);

  const deleteUpload = useCallback(async (objectPath: string) => {
    const res = await fetch(`/api/users/me/uploads?path=${encodeURIComponent(objectPath)}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok) throw new Error("Delete failed");
    if (uploadObjectPath === objectPath) {
      setUploadObjectPath(null);
      setUploadDisplayUrl(null);
      setUploadIsLowRes(false);
      setUploadWidth(null);
      setUploadHeight(null);
    }
    const data = await fetch("/api/users/me/uploads", { credentials: "include" }).then(r => r.json()) as {
      uploads?: UploadEntry[];
      uploadCount?: number;
      maxUploads?: number;
      displayLimit?: number;
    };
    setUploadGallery(data.uploads ?? []);
    setUploadGalleryCount(data.uploadCount ?? 0);
    setUploadGalleryMax(data.maxUploads ?? 1000);
    if (data.displayLimit) setUploadGalleryDisplayLimit(data.displayLimit);
  }, [uploadObjectPath]);

  // ── Generate ─────────────────────────────────────────────────────
  const handleGenerate = async () => {
    if (!isAuthenticated) { login(); return; }

    // Validate we have a valid source
    if (imageMode === "stock" && !stockPhoto) {
      setErrorMsg("Please wait for a stock photo to load, or shuffle to try again.");
      return;
    }
    if ((imageMode === "upload" || imageMode === "ai") && !isPremium) {
      setErrorMsg("This image source requires a Legendary membership.");
      return;
    }
    if (imageMode === "upload" && !uploadObjectPath) {
      setErrorMsg(isUploadingFile ? "Please wait for the upload to finish." : "Please select an image to upload.");
      return;
    }
    if (imageMode === "ai" && aiSubMode === "reference" && !selectedRefGenPath) {
      setErrorMsg("Please select a reference-generated AI background first.");
      return;
    }
    if (imageMode === "ai" && aiSubMode === "generic" && selectedAiIndex === null) {
      setErrorMsg("Please select an AI background image first.");
      return;
    }

    // Get the AI image object storage path
    const aiStoragePath = imageMode === "ai"
      ? aiSubMode === "reference"
        ? selectedRefGenPath
        : (selectedAiIndex !== null && localAiMemeImages
          ? (localAiMemeImages[aiGender]?.[selectedAiIndex] ?? null)
          : null)
      : null;
    if (imageMode === "ai" && !aiStoragePath) {
      setErrorMsg("Selected AI image is not available. Please try Generate New.");
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
          : imageMode === "ai"
          ? {
              type: "upload" as const,
              uploadKey: aiStoragePath!,
            }
          : {
              type: "upload" as const,
              uploadKey: uploadObjectPath!,
            };

      const canvasEl = canvasRef.current;
      const previewImageBase64 = canvasEl
        ? canvasEl.toDataURL("image/jpeg", 0.82).split(",")[1] ?? null
        : null;

      const res = await fetch("/api/memes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          factId,
          imageSource,
          previewImageBase64,
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
          isPublic,
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
      queryClient.invalidateQueries({ queryKey: ["profile-my-memes"] });
      if (onMakeVideo && !nudgeShownRef.current) {
        nudgeShownRef.current = true;
        setShowNudge(true);
      }
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

  const handleGenerateVideo = async () => {
    if (videoState.status === "generating") return;

    if (!canvasRef.current) {
      setVideoState({ status: "error", message: "No meme preview available for video generation." });
      return;
    }

    setVideoState({ status: "generating" });

    const imageBase64 = canvasRef.current.toDataURL("image/jpeg", 0.85);

    try {
      const res = await fetch("/api/videos/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ imageBase64, factId }),
      });
      const body = await res.json() as { videoUrl?: string; error?: string };
      if (res.status === 429) {
        setVideoState({ status: "error", message: body.error ?? "Rate limit exceeded. You have generated too many videos in the past 24 hours." });
        return;
      }
      if (!res.ok || !body.videoUrl) {
        setVideoState({ status: "error", message: body.error ?? "Video generation failed. Please try again." });
        return;
      }
      setVideoState({ status: "done", url: body.videoUrl });
    } catch {
      setVideoState({ status: "error", message: "Network error. Please check your connection and try again." });
    }
  };


  const templates = tplData?.templates ?? [];

  // ── Render ───────────────────────────────────────────────────────
  const innerContent = (
    <div className="p-4 md:p-5 space-y-5">

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
            {!isBgLoading && imageMode === "ai" && aiSubMode === "reference" && !selectedRefGenPath && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 border-2 border-border gap-3 px-6 text-center">
                <ImageIcon className="w-8 h-8 text-muted-foreground opacity-50" />
                <p className="text-sm font-semibold text-foreground">No background generated yet</p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Pick a reference photo below (or upload your own), then click{" "}
                  <span className="text-violet-400 font-semibold">Generate New</span> to create a personalised AI background from it.
                </p>
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
                    active={imageMode === "gradient"}
                    onClick={() => setImageMode("gradient")}
                  >
                    Gradient
                  </ModeTab>
                  <ModeTab
                    active={imageMode === "ai"}
                    onClick={() => {
                      setImageMode("ai");
                    }}
                    badge={!isPremium ? "PRO" : undefined}
                  >
                    AI Generated
                  </ModeTab>
                  <ModeTab
                    active={imageMode === "upload"}
                    onClick={() => {
                      if (!isPremium && isAuthenticated) return; // handled below
                      setImageMode("upload");
                    }}
                    badge={!isPremium ? "PRO" : undefined}
                  >
                    Upload
                  </ModeTab>
                </div>

                {/* Thumbnail size slider — shown for all image modes */}
                <div className="flex items-center gap-2 py-1">
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/></svg>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={thumbSize}
                    onChange={e => setThumbSize(Number(e.target.value))}
                    className="flex-1 h-1 accent-primary cursor-pointer"
                    aria-label="Thumbnail size"
                  />
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
                </div>

                {/* Gradient mode: template picker */}
                {imageMode === "gradient" && (
                  <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbPx}px, 1fr))` }}>
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
                        <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbPx}px, 1fr))` }}>
                          {prefetchedPhotos.map((photo, i) => (
                            <ImageCard
                              key={photo.id}
                              src={photo.src?.large ?? photo.src?.small ?? photo.url}
                              alt={`Option ${i + 1}`}
                              aspectRatio="aspect-video"
                              selected={prefetchedIndex === i}
                              onSelect={() => selectPrefetchedPhoto(photo, i)}
                              compact
                              actions={["openFull"]}
                            />
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

                {/* AI Generated mode */}
                {imageMode === "ai" && (
                  <>
                    {!isPremium ? (
                      <div className="border-2 border-dashed border-amber-400/30 bg-amber-400/5 p-5 text-center space-y-2">
                        <Lock className="w-6 h-6 text-amber-400 mx-auto" />
                        <p className="text-sm font-bold text-amber-400 uppercase tracking-wider">
                          Legendary Feature
                        </p>
                        <p className="text-xs text-muted-foreground">
                          AI-generated backgrounds require a Legendary membership.
                        </p>
                        <Link href="/pricing">
                          <Button size="sm" className="mt-2">Go Legendary</Button>
                        </Link>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {/* Sub-mode toggle: Generic / With Reference Photo */}
                        <div className="flex gap-1 p-0.5 bg-muted/40 rounded-sm">
                          <button
                            onClick={() => { setAiSubMode("generic"); setAiGenerateError(null); }}
                            className={`flex-1 text-[10px] font-display uppercase tracking-widest py-1 rounded-sm transition-colors ${
                              aiSubMode === "generic"
                                ? "bg-violet-500 text-white"
                                : "text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            Generic
                          </button>
                          <button
                            onClick={() => { setAiSubMode("reference"); setAiGenerateError(null); }}
                            className={`flex-1 text-[10px] font-display uppercase tracking-widest py-1 rounded-sm transition-colors ${
                              aiSubMode === "reference"
                                ? "bg-violet-500 text-white"
                                : "text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            Reference Photo
                          </button>
                        </div>

                        {/* Generic sub-mode: show shared fact-level AI backgrounds */}
                        {aiSubMode === "generic" && (
                          aiImagePaths.length > 0 ? (
                            <>
                              <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                                AI backgrounds for this fact
                                <span className="ml-1 text-primary">({aiGender})</span>
                                {(localAiMemeImages?.[aiGender]?.filter(Boolean).length ?? 0) > aiGalleryDisplayLimit && (
                                  <span className="ml-1 text-muted-foreground/60">
                                    — showing {aiGalleryDisplayLimit} of {localAiMemeImages![aiGender]!.filter(Boolean).length}
                                  </span>
                                )}
                              </p>
                              <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbPx}px, 1fr))` }}>
                                {aiImageSlots.map((slot, displayIdx) => (
                                  <ImageCard
                                    key={slot.path}
                                    src={getAiThumbnailUrl(slot.origIdx)}
                                    alt={`AI option ${displayIdx + 1}`}
                                    aspectRatio="aspect-video"
                                    selected={selectedAiIndex === slot.origIdx}
                                    onSelect={() => setSelectedAiIndex(slot.origIdx)}
                                    compact
                                    actions={["delete", "openFull"]}
                                    onDelete={() => handleDeleteAiImage(slot.origIdx)}
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

                        {/* Reference sub-mode: show only images generated by this user via reference photo */}
                        {aiSubMode === "reference" && (
                          isLoadingRefGenImages ? (
                            <div className="flex items-center justify-center py-4">
                              <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
                            </div>
                          ) : (() => {
                            const myRefImages = refGenImages.filter(img => img.gender === aiGender);
                            return myRefImages.length > 0 ? (
                              <>
                                <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                                  Your reference-generated backgrounds
                                  <span className="ml-1 text-primary">({aiGender})</span>
                                </p>
                                <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbPx}px, 1fr))` }}>
                                  {myRefImages.map((img, displayIdx) => (
                                    <ImageCard
                                      key={img.storagePath}
                                      src={getRefAiThumbnailUrl(img.storagePath)}
                                      alt={`Reference AI option ${displayIdx + 1}`}
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
                            );
                          })()
                        )}

                        {/* Reference photo picker — shown in reference sub-mode */}
                        {aiSubMode === "reference" && (
                          <div className="space-y-2">
                            <p className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                              Pick a reference photo
                            </p>
                            {/* Hidden file input for Upload New tile */}
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
                                {/* Upload New tile */}
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

                        {/* Style selector */}
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

                        {/* Generate New button */}
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handleGenerateNewAi()}
                            disabled={isGeneratingAi || (aiSubMode === "reference" && !selectedRefUpload)}
                            className="gap-2 border-violet-500/50 text-violet-400 hover:border-violet-400 disabled:opacity-50"
                          >
                            {isGeneratingAi ? (
                              <><Loader2 className="w-3.5 h-3.5 animate-spin" />Generating…</>
                            ) : (
                              <><Sparkles className="w-3.5 h-3.5" />Generate New</>
                            )}
                          </Button>
                          <span className="text-[10px] text-muted-foreground">
                            {aiSubMode === "reference"
                              ? "1 image from your photo"
                              : factIsGendered ? "3 images (gendered)" : "1 image (abstract)"}
                          </span>
                        </div>

                        {/* Debug: full prompt preview (admin only) */}
                        {isAdmin && (() => {
                          const styleDef = IMAGE_STYLES.find(s => s.id === selectedStyleId);
                          const suffix = aiSubMode === "reference"
                            ? (styleDef?.promptSuffixReference ?? "")
                            : (styleDef?.promptSuffix ?? "");
                          const genderKey = aiGender as string;
                          const sceneBase = aiScenePromptsDebug?.[genderKey] ?? null;
                          const referenceFrame = "Generate an image using the provided reference photo. The person's face, facial structure, skin tone, eye shape, hair, and all distinguishing features must be preserved with photorealistic accuracy and remain visually identical to the reference — this is the highest priority. Do not alter, stylize, or idealize the person's facial features in any way. The person should be placed into the scene as described. The scene and environment should be stylized as described, but the person's face and likeness must remain untouched by any stylization. No text, words, or letters anywhere in the image.";
                          const includeReferenceFrame = aiSubMode === "reference";
                          const finalPrompt = `${includeReferenceFrame ? referenceFrame + " " : ""}${sceneBase ?? "(scene prompt will be generated)"}${suffix ? ` ${suffix}` : ""}`;
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
                                  {sceneBase ? (
                                    <>
                                      <div>
                                        <span className="text-muted-foreground font-semibold uppercase tracking-wide">Scene prompt ({genderKey})</span>
                                        <p className="mt-0.5 text-foreground/80 font-mono leading-relaxed">{sceneBase}</p>
                                      </div>
                                      {suffix && (
                                        <div>
                                          <span className="text-muted-foreground font-semibold uppercase tracking-wide">Style suffix ({styleDef?.label})</span>
                                          <p className="mt-0.5 text-foreground/80 font-mono leading-relaxed">{suffix}</p>
                                        </div>
                                      )}
                                      {includeReferenceFrame && (
                                        <div>
                                          <span className="text-muted-foreground font-semibold uppercase tracking-wide">Reference frame (prepended)</span>
                                          <p className="mt-0.5 text-foreground/80 font-mono leading-relaxed">{referenceFrame.trim()}</p>
                                        </div>
                                      )}
                                      <div className="border-t border-border pt-2">
                                        <span className="text-violet-400 font-semibold uppercase tracking-wide">Full prompt sent to AI</span>
                                        <p className="mt-0.5 text-foreground font-mono leading-relaxed break-words">{finalPrompt}</p>
                                      </div>
                                    </>
                                  ) : (
                                    <>
                                      <p className="text-muted-foreground italic">No scene prompt stored yet — it will be generated by GPT on first run, then cached.</p>
                                      {suffix && (
                                        <div>
                                          <span className="text-muted-foreground font-semibold uppercase tracking-wide">Style suffix that will be appended ({styleDef?.label})</span>
                                          <p className="mt-0.5 text-foreground/80 font-mono leading-relaxed">{suffix}</p>
                                        </div>
                                      )}
                                      {includeReferenceFrame && (
                                        <div>
                                          <span className="text-muted-foreground font-semibold uppercase tracking-wide">Reference frame (prepended)</span>
                                          <p className="mt-0.5 text-foreground/80 font-mono leading-relaxed">{referenceFrame.trim()}</p>
                                        </div>
                                      )}
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {aiGenerateError && (
                          <p className="text-[10px] text-destructive">{aiGenerateError}</p>
                        )}
                        {isGeneratingAi && (
                          <div className="space-y-1.5">
                            <div className="w-full h-1.5 rounded-full bg-violet-500/15 overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-300 ${
                                  generationProgress >= 100
                                    ? "bg-green-500"
                                    : "bg-violet-500"
                                }`}
                                style={{ width: `${generationProgress}%` }}
                              />
                            </div>
                            <p className="text-[10px] text-muted-foreground/60">
                              Generating… {generationElapsed}s — thumbnails will refresh automatically.
                            </p>
                          </div>
                        )}

                        <p className="text-[10px] text-muted-foreground/50">
                          AI-generated scene • Powered by OpenAI gpt-image-1
                        </p>
                      </div>
                    )}
                  </>
                )}

                {/* Upload mode */}
                {imageMode === "upload" && (
                  <>
                    {!isPremium ? (
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
                        {/* Drop zone / new upload */}
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
                                  {uploadObjectPath ? " · Uploaded ✓" : " · Uploading…"}
                                  {uploadObjectPath && uploadIsLowRes && (
                                    <span className="ml-1 text-amber-400"> · Low res</span>
                                  )}
                                </p>
                              </div>
                              <button
                                onClick={e => {
                                  e.stopPropagation();
                                  setUploadFile(null);
                                  setUploadObjectPath(null);
                                  if (uploadLocalUrl) URL.revokeObjectURL(uploadLocalUrl);
                                  setUploadLocalUrl(null);
                                  setUploadDisplayUrl(null);
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

                        {/* Existing uploads gallery */}
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-[10px] font-display uppercase tracking-[0.2em] text-muted-foreground">
                              My Uploads
                            </p>
                            {!isLoadingGallery && (
                              <p className="text-[10px] text-muted-foreground tabular-nums">
                                {uploadGalleryCount > uploadGalleryDisplayLimit
                                  ? `showing ${uploadGalleryDisplayLimit} of ${uploadGalleryCount} · `
                                  : ""}
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
                            <div className="grid gap-1.5 max-h-52 overflow-y-auto pr-0.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbPx}px, 1fr))` }}>
                              {uploadGallery.map((entry) => {
                                const isSelected = uploadObjectPath === entry.objectPath && !uploadFile;
                                return (
                                  <ImageCard
                                    key={entry.objectPath}
                                    src={`/api/storage${entry.objectPath}`}
                                    alt={`${entry.width}×${entry.height}px${entry.isLowRes ? " · Low res" : ""}`}
                                    aspectRatio="aspect-video"
                                    isAuthProtected
                                    selected={isSelected}
                                    onSelect={() => selectExistingUpload(entry)}
                                    compact
                                    actions={["delete", "openFull"]}
                                    onDelete={() => deleteUpload(entry.objectPath)}
                                    deleteConfirmMessage="Remove this upload? This cannot be undone."
                                    imageOverlay={entry.isLowRes ? (
                                      <div className="absolute bottom-0 left-0 right-0 bg-amber-400/80 text-[8px] font-bold text-black text-center leading-tight py-0.5">
                                        LOW RES
                                      </div>
                                    ) : undefined}
                                  />
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
                        max={textCollisionConstraints.maxTopY}
                        value={Math.min(topY, textCollisionConstraints.maxTopY)}
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
                        min={textCollisionConstraints.minBottomY}
                        max={100}
                        value={Math.max(bottomY, textCollisionConstraints.minBottomY)}
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

          {/* ── Visibility toggle (premium) ── */}
          {isPremium && status !== "done" && (
            <div className="flex items-center justify-between px-4 py-2 bg-muted/30 border border-border/50">
              <div className="flex items-center gap-2">
                {isPublic ? (
                  <Globe className="w-4 h-4 text-primary" />
                ) : (
                  <Lock className="w-4 h-4 text-muted-foreground" />
                )}
                <span className="text-sm font-medium">
                  {isPublic ? "Public" : "Private"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {isPublic ? "Visible in the gallery" : "Only visible to you"}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={isPublic}
                onClick={() => setIsPublic(p => !p)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${isPublic ? "bg-primary" : "bg-muted-foreground/40"}`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${isPublic ? "translate-x-6" : "translate-x-1"}`}
                />
              </button>
            </div>
          )}

          {/* ── Error ── */}
          {errorMsg && (
            <p className="text-destructive text-sm font-medium bg-destructive/10 border border-destructive/30 px-4 py-2">
              {errorMsg}
            </p>
          )}

          {/* ── Success / Actions ── */}
          {status === "done" && permalinkSlug ? (
            <div className="space-y-3">
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
                    onClick={() => { setStatus("idle"); setPermalinkSlug(null); setShowNudge(false); }}
                  >
                    Make Another
                  </Button>
                </div>
              </div>
              {onMakeVideo && (
                <div className="relative">
                  <button
                    onClick={() => {
                      setShowNudge(false);
                      const dataUrl = canvasRef.current?.toDataURL("image/jpeg", 0.85) ?? "";
                      onMakeVideo(dataUrl);
                    }}
                    className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 text-sm font-bold uppercase tracking-wider transition-colors"
                    style={{ borderColor: "#f97316", color: "#f97316" }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = "rgba(249,115,22,0.08)"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = ""; }}
                  >
                    <Clapperboard className="w-4 h-4" />
                    Turn This Into a Video →
                  </button>
                  {showNudge && (
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 bg-foreground text-background rounded-sm px-3 py-2 shadow-xl z-20 text-center">
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <span className="text-[11px] font-bold uppercase tracking-wider animate-pulse" style={{ color: "#f97316" }}>
                          New!
                        </span>
                        <button
                          onClick={() => setShowNudge(false)}
                          className="text-background/60 hover:text-background transition-colors"
                          aria-label="Dismiss"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                      <p className="text-[11px] leading-snug">See your meme come to life</p>
                      <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0" style={{ borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: "6px solid var(--foreground)" }} />
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex gap-3">
              <Button
                onClick={handleGenerate}
                disabled={status === "generating" || isUploadingFile}
                variant="primary"
                size="lg"
                className="flex-1 gap-2"
              >
                {status === "generating" ? (
                  <><Loader2 className="w-5 h-5 animate-spin" />Generating…</>
                ) : !isAuthenticated ? (
                  <><Lock className="w-5 h-5" />Login to Generate</>
                ) : (
                  <><Flame className="w-5 h-5" />Make My Meme</>
                )}
              </Button>
              <Button variant="secondary" size="lg" className="gap-2 shrink-0" onClick={handleDownload}>
                <Download className="w-5 h-5" />
                <span className="hidden sm:inline">Download</span>
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
  );

  if (embedded) {
    return innerContent;
  }

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
        {innerContent}
      </div>
    </div>
  );
}
