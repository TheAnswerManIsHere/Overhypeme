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
  {
    id: "action",
    name: "Action Hero",
    description: "High-contrast dark blue gradient — pure action movie energy",
    previewColors: ["#0a0e2e", "#1a237e", "#283593"],
    assetPath: "action.png",
  },
  {
    id: "fire",
    name: "On Fire",
    description: "Blazing orange-red gradient for the most intense facts",
    previewColors: ["#bf360c", "#e64a19", "#ff6d00"],
    assetPath: "fire.png",
  },
  {
    id: "night",
    name: "Night Ops",
    description: "Tactical dark background with subtle green accent",
    previewColors: ["#0a0a0a", "#1b2420", "#263238"],
    assetPath: "night.png",
  },
  {
    id: "gold",
    name: "Legendary",
    description: "Golden gradient for facts of mythical proportions",
    previewColors: ["#4a2c00", "#f57f17", "#ffd54f"],
    assetPath: "gold.png",
  },
  {
    id: "cinema",
    name: "Cinematic",
    description: "Classic sepia-toned cinematic style",
    previewColors: ["#2d1e00", "#5d4037", "#8d6e63"],
    assetPath: "cinema.png",
  },
];

export interface TextOptions {
  fontSize?: number;
  color?: string;
  align?: "left" | "center" | "right";
  verticalPosition?: "top" | "middle" | "bottom";
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
  switch (templateId) {
    case "fire":   return "#ff6d00";
    case "gold":   return "#ffd54f";
    case "night":  return "#546e7a";
    case "cinema": return "#8d6e63";
    default:       return "#ff6600"; // action + fallback
  }
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
  ctx.fillText("CN", CANVAS_W - 24, CANVAS_H * 0.72);

  // ── Text ──────────────────────────────────────────────────────────
  const autoFontSize =
    factText.length > 120 ? 22 : factText.length > 70 ? 26 : 32;
  const fontSize = Math.min(Math.max(options?.fontSize ?? autoFontSize, 14), 48);
  const textColor = options?.color ?? "#ffffff";
  const textAlign = options?.align ?? "left";
  const vertPos = options?.verticalPosition ?? "middle";

  const padding = 56;
  const maxW = CANVAS_W - padding * 2 - sidebarW;

  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.fillStyle = textColor;
  ctx.textAlign = textAlign;
  ctx.shadowColor = "rgba(0,0,0,0.9)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;

  const words = factText.split(" ");
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
  if (vertPos === "top") startY = padding + fontSize;
  else if (vertPos === "bottom") startY = CANVAS_H - padding - totalH + fontSize;
  else startY = (CANVAS_H - totalH) / 2 + fontSize;

  const textX =
    textAlign === "right"
      ? CANVAS_W - padding
      : textAlign === "center"
      ? padding + sidebarW + maxW / 2
      : padding + sidebarW + 4;

  lines.forEach((line, i) => {
    ctx.fillText(line, textX, startY + i * lineH);
  });

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
