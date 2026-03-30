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

const templateImageCache = new Map<string, Awaited<ReturnType<typeof loadImage>>>();

async function getTemplateImage(assetPath: string) {
  if (!templateImageCache.has(assetPath)) {
    const img = await loadImage(path.join(TEMPLATES_DIR, assetPath));
    templateImageCache.set(assetPath, img);
  }
  return templateImageCache.get(assetPath)!;
}

export async function generateMemeBuffer(
  templateId: string,
  factText: string,
  options?: TextOptions,
): Promise<Buffer> {
  const template = MEME_TEMPLATES.find(t => t.id === templateId);
  if (!template) throw new Error(`Unknown template: ${templateId}`);

  const canvas: Canvas = createCanvas(CANVAS_W, CANVAS_H);
  const ctx = canvas.getContext("2d");

  const bgImage = await getTemplateImage(template.assetPath);
  ctx.drawImage(bgImage, 0, 0, CANVAS_W, CANVAS_H);

  const autoFontSize = factText.length > 120 ? 22 : factText.length > 70 ? 26 : 32;
  const fontSize = Math.min(Math.max(options?.fontSize ?? autoFontSize, 14), 48);
  const textColor = options?.color ?? "#ffffff";
  const textAlign = options?.align ?? "left";
  const vertPos = options?.verticalPosition ?? "middle";

  const sidebarW = 12;
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

  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.font = "bold 13px sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.textAlign = "right";
  ctx.fillText("chucknorrisfacts.app", CANVAS_W - 18, CANVAS_H - 14);

  return canvas.toBuffer("image/png");
}
