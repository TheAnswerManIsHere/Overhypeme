/**
 * Regenerate the 20 gradient meme-template PNGs in 3 aspect-ratio variants
 * (60 files total) under `src/assets/meme-templates/{landscape,square,portrait}/`.
 *
 * Run with: pnpm --filter @workspace/api-server exec tsx scripts/generate-meme-templates.ts
 *
 * The gradient definitions live alongside the client copy in
 * `MemeBuilder.tsx`. They must stay in sync — both surfaces consume the same
 * definitions (the client renders previews, the server renders the final).
 */
// Install stdio guard so EIO/EPIPE on stdout/stderr (e.g. piped to `head`,
// terminal disconnect, container log-pipe overrun) cannot crash the script.
// CLI scripts intentionally keep using console.* for human-readable output.
import { installStdioGuard } from "../src/lib/stdioGuard.js";
installStdioGuard();

import { createCanvas } from "@napi-rs/canvas";
import { mkdir, writeFile, rm } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  MEME_ASPECT_RATIOS,
  TEMPLATE_RENDER_SCALE,
  type MemeAspectRatio,
} from "@workspace/api-zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "..", "src", "assets", "meme-templates");

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

async function generateOne(name: string, aspect: MemeAspectRatio) {
  const { w: logicalW, h: logicalH } = MEME_ASPECT_RATIOS[aspect];
  const W = Math.round(logicalW * TEMPLATE_RENDER_SCALE);
  const H = Math.round(logicalH * TEMPLATE_RENDER_SCALE);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const stops = GRADIENT_DEFS[name];
  if (!stops) throw new Error(`Unknown gradient: ${name}`);

  // Diagonal top-left → bottom-right gradient, matching the client preview.
  const grad = ctx.createLinearGradient(0, 0, W, H);
  for (const [color, posStr] of stops) {
    grad.addColorStop(parseFloat(posStr) / 100, color);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Subtle dark wash so accent colours stay readable on light gradients.
  ctx.fillStyle = "rgba(0,0,0,0.05)";
  ctx.fillRect(0, 0, W, H);

  const aspectDir = path.join(OUT_DIR, aspect);
  await mkdir(aspectDir, { recursive: true });
  const outPath = path.join(aspectDir, `${name}.png`);
  const buf = await canvas.encode("png");
  await writeFile(outPath, buf);
  return { outPath, W, H, bytes: buf.length };
}

async function main() {
  // Remove any stale flat-layout PNGs from a previous (pre-aspect) version.
  // We only delete *.png files at the root of OUT_DIR, never the subfolders.
  const { readdir } = await import("fs/promises");
  let entries: string[] = [];
  try {
    entries = await readdir(OUT_DIR);
  } catch { /* OUT_DIR may not exist yet */ }
  for (const entry of entries) {
    if (entry.endsWith(".png")) {
      await rm(path.join(OUT_DIR, entry), { force: true });
    }
  }

  const aspects: MemeAspectRatio[] = ["landscape", "square", "portrait"];
  let total = 0;
  for (const name of Object.keys(GRADIENT_DEFS)) {
    for (const aspect of aspects) {
      const { outPath, W, H, bytes } = await generateOne(name, aspect);
      total++;
      console.log(`✓ ${path.relative(OUT_DIR, outPath).padEnd(28)} ${W}×${H} (${(bytes / 1024).toFixed(0)} KB)`);
    }
  }
  console.log(`\nWrote ${total} template PNGs to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
