import { createCanvas, type Canvas } from "@napi-rs/canvas";

export const CANVAS_W = 800;
export const CANVAS_H = 420;

export interface MemeTemplate {
  id: string;
  name: string;
  description: string;
  previewColors: string[];
}

const GRADIENT_DEFS: Record<string, [string, string][]> = {
  action: [["#0a0e2e", "0%"], ["#1a237e", "55%"], ["#283593", "100%"]],
  fire:   [["#bf360c", "0%"], ["#e64a19", "50%"], ["#ff6d00", "100%"]],
  night:  [["#0a0a0a", "0%"], ["#1b2420", "55%"], ["#263238", "100%"]],
  gold:   [["#4a2c00", "0%"], ["#f57f17", "60%"], ["#ffd54f", "100%"]],
  cinema: [["#2d1e00", "0%"], ["#5d4037", "55%"], ["#8d6e63", "100%"]],
};

export const MEME_TEMPLATES: MemeTemplate[] = [
  {
    id: "action",
    name: "Action Hero",
    description: "High-contrast dark blue gradient — pure action movie energy",
    previewColors: ["#0a0e2e", "#1a237e", "#283593"],
  },
  {
    id: "fire",
    name: "On Fire",
    description: "Blazing orange-red gradient for the most intense facts",
    previewColors: ["#bf360c", "#e64a19", "#ff6d00"],
  },
  {
    id: "night",
    name: "Night Ops",
    description: "Tactical dark background with subtle green accent",
    previewColors: ["#0a0a0a", "#1b2420", "#263238"],
  },
  {
    id: "gold",
    name: "Legendary",
    description: "Golden gradient for facts of mythical proportions",
    previewColors: ["#4a2c00", "#f57f17", "#ffd54f"],
  },
  {
    id: "cinema",
    name: "Cinematic",
    description: "Classic sepia-toned cinematic style",
    previewColors: ["#2d1e00", "#5d4037", "#8d6e63"],
  },
];

export interface TextOptions {
  fontSize?: number;
  color?: string;
  align?: "left" | "center" | "right";
  verticalPosition?: "top" | "middle" | "bottom";
}

export function generateMemeBuffer(
  templateId: string,
  factText: string,
  options?: TextOptions,
): Buffer {
  const canvas: Canvas = createCanvas(CANVAS_W, CANVAS_H);
  const ctx = canvas.getContext("2d");

  const stops = GRADIENT_DEFS[templateId] ?? GRADIENT_DEFS["action"]!;
  const grad = ctx.createLinearGradient(0, 0, CANVAS_W, CANVAS_H);
  stops.forEach(([color, pos]) => {
    grad.addColorStop(parseFloat(pos) / 100, color);
  });
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const sidebarW = 12;
  const accentColor = templateId === "fire" ? "#ff6d00" : templateId === "gold" ? "#ffd54f" : "#ff6600";
  ctx.fillStyle = accentColor;
  ctx.fillRect(0, 0, sidebarW, CANVAS_H);

  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.font = `bold ${Math.floor(CANVAS_H * 0.45)}px serif`;
  ctx.textAlign = "right";
  ctx.fillText("CN", CANVAS_W - 24, CANVAS_H * 0.72);

  const padding = 56;
  const maxW = CANVAS_W - padding * 2 - sidebarW;
  const autoFontSize = factText.length > 120 ? 22 : factText.length > 70 ? 26 : 32;
  const fontSize = Math.min(Math.max(options?.fontSize ?? autoFontSize, 14), 48);
  const textColor = options?.color ?? "#ffffff";
  const textAlign = options?.align ?? "left";
  const vertPos = options?.verticalPosition ?? "middle";

  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.fillStyle = textColor;
  ctx.textAlign = textAlign;
  ctx.shadowColor = "rgba(0,0,0,0.85)";
  ctx.shadowBlur = 10;

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
  if (vertPos === "top") {
    startY = padding + fontSize;
  } else if (vertPos === "bottom") {
    startY = CANVAS_H - padding - totalH + fontSize;
  } else {
    startY = (CANVAS_H - totalH) / 2 + fontSize;
  }

  const textX = textAlign === "right"
    ? CANVAS_W - padding
    : textAlign === "center"
    ? padding + sidebarW + maxW / 2
    : padding + sidebarW + 4;

  lines.forEach((line, i) => {
    ctx.fillText(line, textX, startY + i * lineH);
  });

  ctx.shadowBlur = 0;
  ctx.font = `bold 13px sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.textAlign = "right";
  ctx.fillText("chucknorrisfacts.app", CANVAS_W - 18, CANVAS_H - 14);

  return canvas.toBuffer("image/png");
}
