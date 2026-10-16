/**
 * Brand colour tokens as the app's stylesheet defines them, for checks on a
 * computed colour. Read from `src/index.css` rather than written into a test,
 * so a check follows the token.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** An HSL triple (`24 100% 50%`, the form `:root` uses) as the `rgb()` string a computed style reports. */
export function hslTripleToRgb(triple: string): string {
  const m = /^\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*$/.exec(triple);
  if (!m) throw new Error(`not an HSL triple: ${triple}`);
  const [h, s, l] = [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return `rgb(${f(0)}, ${f(8)}, ${f(4)})`;
}

/** The value of a custom property in the `:root` block of `src/index.css`. */
export function rootToken(name: string): string {
  const css = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/index.css"),
    "utf8",
  );
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const m = new RegExp(`${name.replace(/[-]/g, "\\-")}:\\s*([^;]+);`).exec(root);
  if (!m) throw new Error(`${name} not found in the :root block of src/index.css`);
  return m[1]!.trim();
}

/** The brand orange: `--primary`, the colour `text-primary` and `bg-primary` resolve to. */
export function brandOrangeRgb(): string {
  return hslTripleToRgb(rootToken("--primary"));
}
