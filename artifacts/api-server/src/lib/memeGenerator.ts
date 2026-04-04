import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, "assets/meme-templates");

export const CANVAS_W = 800;
export const CANVAS_H = 420;

export interface MemeTemplate {
  id: string;
  name: string;
  description: string;
  previewColors: string[];
  assetPath: string;
}

export const MEME_TEMPLATES: MemeTemplate[] = [
  { id: "action",   name: "Action Hero",  description: "High-contrast dark blue gradient — pure action movie energy",   previewColors: ["#0a0e2e", "#1a237e", "#283593"],   assetPath: "action.png"   },
  { id: "fire",     name: "On Fire",      description: "Blazing orange-red gradient for the most intense facts",         previewColors: ["#bf360c", "#e64a19", "#ff6d00"],   assetPath: "fire.png"     },
  { id: "night",    name: "Night Ops",    description: "Tactical dark background with subtle green accent",              previewColors: ["#0a0a0a", "#1b2420", "#263238"],   assetPath: "night.png"    },
  { id: "gold",     name: "Legendary",    description: "Golden gradient for facts of mythical proportions",              previewColors: ["#4a2c00", "#f57f17", "#ffd54f"],   assetPath: "gold.png"     },
  { id: "cinema",   name: "Cinematic",    description: "Classic sepia-toned cinematic style",                            previewColors: ["#2d1e00", "#5d4037", "#8d6e63"],   assetPath: "cinema.png"   },
  { id: "neon",     name: "Neon",         description: "Cyberpunk hot-pink — electric and unapologetic",                previewColors: ["#0d0221", "#4a0060", "#e91e8c"],   assetPath: "neon.png"     },
  { id: "ocean",    name: "Ocean Deep",   description: "Abyssal blue — calm on the surface, crushing below",            previewColors: ["#000428", "#004e92", "#0288d1"],   assetPath: "ocean.png"    },
  { id: "crimson",  name: "Crimson",      description: "Smouldering deep red with dangerous intent",                    previewColors: ["#1a0000", "#7b0000", "#c62828"],   assetPath: "crimson.png"  },
  { id: "galaxy",   name: "Galaxy",       description: "Deep-space indigo — the universe bows down",                    previewColors: ["#0c0019", "#311b92", "#4527a0"],   assetPath: "galaxy.png"   },
  { id: "storm",    name: "Storm",        description: "Steel-grey tempest for uncompromising authority",               previewColors: ["#0d0d0d", "#263238", "#455a64"],   assetPath: "storm.png"    },
  { id: "emerald",  name: "Emerald",      description: "Rich jewel-green — rare and impossible to ignore",              previewColors: ["#001a08", "#1b5e20", "#2e7d32"],   assetPath: "emerald.png"  },
  { id: "arctic",   name: "Arctic",       description: "Glacial blue — cold, precise, and unstoppable",                 previewColors: ["#0a1929", "#0d47a1", "#1565c0"],   assetPath: "arctic.png"   },
  { id: "copper",   name: "Copper",       description: "Burnished copper tones — aged but never outdated",              previewColors: ["#1a0d00", "#6d3200", "#bf5900"],   assetPath: "copper.png"   },
  { id: "twilight", name: "Twilight",     description: "Violet dusk — the hour when legends emerge",                    previewColors: ["#0d001a", "#6a1b9a", "#ab47bc"],   assetPath: "twilight.png" },
  { id: "toxic",    name: "Toxic",        description: "Radioactive green — dangerously talented",                      previewColors: ["#001400", "#1b5e20", "#33691e"],   assetPath: "toxic.png"    },
  { id: "rose",     name: "Rose",         description: "Deep rose — intense, vivid, unforgettable",                     previewColors: ["#1a0005", "#880e4f", "#ad1457"],   assetPath: "rose.png"     },
  { id: "volcano",  name: "Volcano",      description: "Volcanic crimson — pressure built over a lifetime",             previewColors: ["#100000", "#4e0000", "#b71c1c"],   assetPath: "volcano.png"  },
  { id: "retro",    name: "Retro Wave",   description: "80s synthwave sunset — nostalgic and dangerous",                previewColors: ["#1a0030", "#7b1fa2", "#e64a19"],   assetPath: "retro.png"    },
  { id: "midnight", name: "Midnight",     description: "Ink-black midnight blue — the darkest hour before glory",       previewColors: ["#000814", "#001d3d", "#003566"],   assetPath: "midnight.png" },
  { id: "chrome",   name: "Chrome",       description: "Polished steel grey — sleek, mechanical, unstoppable",          previewColors: ["#0d0d0d", "#37474f", "#546e7a"],   assetPath: "chrome.png"   },
];

export interface TextOptions {
  fontSize?: number;
  color?: string;
  align?: "left" | "center" | "right";
  verticalPosition?: "top" | "middle" | "bottom";
  topText?: string;
  bottomText?: string;
  fontFamily?: string;
  outlineColor?: string;
  textEffect?: "shadow" | "outline" | "none";
  outlineWidth?: number;
  allCaps?: boolean;
  bold?: boolean;
  italic?: boolean;
  opacity?: number;
}

/**
 * Where the background image comes from.
 * - template: one of the 5 built-in gradient PNGs
 * - image:    a URL string (stock photo from Pexels) or a Buffer (user upload)
 */
export type BackgroundSource =
  | { type: "template"; templateId: string }
  | { type: "image"; imageData: string | Buffer };

const templateImageCache = new Map<
  string,
  Awaited<ReturnType<typeof loadImage>>
>();

async function getTemplateImage(assetPath: string) {
  if (!templateImageCache.has(assetPath)) {
    const img = await loadImage(path.join(TEMPLATES_DIR, assetPath));
    templateImageCache.set(assetPath, img);
  }
  return templateImageCache.get(assetPath)!;
}

/** Accent sidebar colour per gradient template. */
function templateAccentColor(templateId: string): string {
  const map: Record<string, string> = {
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
  return map[templateId] ?? "#ff6600";
}

/**
 * Center-crops src dimensions to match the target aspect ratio,
 * returning {sx, sy, sw, sh} for ctx.drawImage.
 */
function centerCropParams(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  let sx = 0, sy = 0, sw = srcW, sh = srcH;
  if (srcAspect > dstAspect) {
    sw = srcH * dstAspect;
    sx = (srcW - sw) / 2;
  } else {
    sh = srcW / dstAspect;
    sy = (srcH - sh) / 2;
  }
  return { sx, sy, sw, sh };
}

export async function generateMemeBuffer(
  background: BackgroundSource,
  factText: string,
  options?: TextOptions,
): Promise<Buffer> {
  const canvas: Canvas = createCanvas(CANVAS_W, CANVAS_H);
  const ctx = canvas.getContext("2d");

  // ── Background ────────────────────────────────────────────────────
  let accentColor: string;

  if (background.type === "template") {
    const template = MEME_TEMPLATES.find(t => t.id === background.templateId);
    if (!template) throw new Error(`Unknown template: ${background.templateId}`);

    const bgImage = await getTemplateImage(template.assetPath);
    ctx.drawImage(bgImage, 0, 0, CANVAS_W, CANVAS_H);
    accentColor = templateAccentColor(background.templateId);
  } else {
    // Photo background (stock URL or uploaded buffer)
    const img = await loadImage(background.imageData);
    const { sx, sy, sw, sh } = centerCropParams(
      img.width,
      img.height,
      CANVAS_W,
      CANVAS_H,
    );
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, CANVAS_W, CANVAS_H);

    // Semi-transparent dark overlay so text stays readable over any photo
    ctx.fillStyle = "rgba(0,0,0,0.48)";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    accentColor = "#FF3C00";
  }

  // ── Left accent bar ───────────────────────────────────────────────
  const sidebarW = 12;
  ctx.fillStyle = accentColor;
  ctx.fillRect(0, 0, sidebarW, CANVAS_H);

  // ── Ghost watermark letters ───────────────────────────────────────
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.font = `bold ${Math.floor(CANVAS_H * 0.45)}px serif`;
  ctx.textAlign = "right";
  ctx.fillText("OM", CANVAS_W - 24, CANVAS_H * 0.72);

  // ── Text ──────────────────────────────────────────────────────────
  const hasNewFormat = !!(options?.topText !== undefined || options?.bottomText !== undefined);
  const autoLegacySize = factText.length > 120 ? 22 : factText.length > 70 ? 26 : 32;
  const defaultSize = hasNewFormat ? 30 : autoLegacySize;
  const fontSize = Math.min(Math.max(options?.fontSize ?? defaultSize, 14), 100);
  const textColor = options?.color ?? "#ffffff";
  const textAlign = options?.align ?? (hasNewFormat ? "center" : "left");
  const fontFamily = options?.fontFamily ?? (hasNewFormat ? "Impact" : "sans-serif");
  const textEffect = options?.textEffect ?? (hasNewFormat ? "outline" : "shadow");
  const outlineColor = options?.outlineColor ?? "#000000";
  const outlineWidthVal = options?.outlineWidth ?? 5;
  const allCaps = options?.allCaps ?? hasNewFormat;
  const isBold = options?.bold ?? true;
  const isItalic = options?.italic ?? false;
  const textOpacity = options?.opacity ?? 1;

  const padding = 40;
  const maxW = CANVAS_W - padding * 2 - sidebarW;
  const fontStyle = `${isItalic ? "italic " : ""}${isBold ? "bold " : ""}`;
  const fontStr = `${fontStyle}${fontSize}px "${fontFamily}", sans-serif`;

  const textAreaLeft = padding + sidebarW;
  const textAreaRight = CANVAS_W - padding;
  const textX =
    textAlign === "right" ? textAreaRight
    : textAlign === "center" ? (textAreaLeft + textAreaRight) / 2
    : textAreaLeft + 4;

  function wrapText(text: string): string[] {
    const display = allCaps ? text.toUpperCase() : text;
    ctx.font = fontStr;
    const words = display.split(" ");
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const test = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(test).width > maxW && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function renderBlock(lines: string[], position: "top" | "middle" | "bottom") {
    if (lines.length === 0) return;
    const lineH = fontSize * 1.25;
    const totalH = lines.length * lineH;
    let startY: number;
    if (position === "top") startY = padding + fontSize;
    else if (position === "bottom") startY = CANVAS_H - padding - totalH + fontSize;
    else startY = (CANVAS_H - totalH) / 2 + fontSize;

    ctx.save();
    ctx.globalAlpha = textOpacity;
    ctx.font = fontStr;
    ctx.textAlign = textAlign;

    lines.forEach((line, i) => {
      const y = startY + i * lineH;
      if (textEffect === "outline") {
        ctx.strokeStyle = outlineColor;
        ctx.lineWidth = outlineWidthVal * 2;
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        ctx.strokeText(line, textX, y);
      }
      if (textEffect === "shadow") {
        ctx.shadowColor = "rgba(0,0,0,0.9)";
        ctx.shadowBlur = 12;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
      }
      ctx.fillStyle = textColor;
      ctx.fillText(line, textX, y);
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    });
    ctx.restore();
  }

  if (hasNewFormat) {
    if ((options?.topText ?? "").trim()) renderBlock(wrapText(options!.topText!), "top");
    if ((options?.bottomText ?? "").trim()) renderBlock(wrapText(options!.bottomText!), "bottom");
  } else {
    renderBlock(wrapText(factText), options?.verticalPosition ?? "middle");
  }

  // ── Watermark ─────────────────────────────────────────────────────
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.font = "bold 13px sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.textAlign = "right";
  ctx.fillText("overhype.me", CANVAS_W - 18, CANVAS_H - 14);

  return canvas.toBuffer("image/png");
}
