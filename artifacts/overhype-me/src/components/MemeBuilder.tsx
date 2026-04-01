import { useRef, useEffect, useState, useCallback } from "react";
import { Link } from "wouter";
import { useListMemeTemplates, useCreateMeme } from "@workspace/api-client-react";
import { useAuth } from "@workspace/replit-auth-web";
import { Button } from "@/components/ui/Button";
import { X, Download, Share2, CheckCircle, Loader2 } from "lucide-react";

const CANVAS_W = 800;
const CANVAS_H = 420;

const GRADIENT_DEFS: Record<string, [string, string][]> = {
  action: [["#0a0e2e", "0%"], ["#1a237e", "55%"], ["#283593", "100%"]],
  fire:   [["#bf360c", "0%"], ["#e64a19", "50%"], ["#ff6d00", "100%"]],
  night:  [["#0a0a0a", "0%"], ["#1b2420", "55%"], ["#263238", "100%"]],
  gold:   [["#4a2c00", "0%"], ["#f57f17", "60%"], ["#ffd54f", "100%"]],
  cinema: [["#2d1e00", "0%"], ["#5d4037", "55%"], ["#8d6e63", "100%"]],
};

type TextAlign = "left" | "center" | "right";
type VertPos = "top" | "middle" | "bottom";

function drawMeme(
  canvas: HTMLCanvasElement,
  templateId: string,
  text: string,
  fontSize: number,
  color: string,
  align: TextAlign,
  vertPos: VertPos,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const stops = GRADIENT_DEFS[templateId] ?? GRADIENT_DEFS["action"]!;
  const grad = ctx.createLinearGradient(0, 0, CANVAS_W, CANVAS_H);
  stops.forEach(([c, pos]) => grad.addColorStop(parseFloat(pos) / 100, c));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const sidebarW = 12;
  const accent = templateId === "fire" ? "#ff6d00" : templateId === "gold" ? "#ffd54f" : "#ff6600";
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, sidebarW, CANVAS_H);

  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.font = `bold ${Math.floor(CANVAS_H * 0.45)}px serif`;
  ctx.textAlign = "right";
  ctx.fillText("CN", CANVAS_W - 24, CANVAS_H * 0.72);

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
  if (vertPos === "top") startY = padding + fontSize;
  else if (vertPos === "bottom") startY = CANVAS_H - padding - totalH + fontSize;
  else startY = (CANVAS_H - totalH) / 2 + fontSize;

  const textX = align === "right"
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

interface MemeBuilderProps {
  factId: number;
  factText: string;
  onClose: () => void;
}

export function MemeBuilder({ factId, factText, onClose }: MemeBuilderProps) {
  const { isAuthenticated, login } = useAuth();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selectedTemplate, setSelectedTemplate] = useState("action");
  const [fontSize, setFontSize] = useState(28);
  const [textColor, setTextColor] = useState("#ffffff");
  const [textAlign, setTextAlign] = useState<TextAlign>("left");
  const [vertPos, setVertPos] = useState<VertPos>("middle");
  const [status, setStatus] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [permalinkSlug, setPermalinkSlug] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { data: tplData } = useListMemeTemplates();
  const createMeme = useCreateMeme();

  const redraw = useCallback(() => {
    if (canvasRef.current) drawMeme(canvasRef.current, selectedTemplate, factText, fontSize, textColor, textAlign, vertPos);
  }, [selectedTemplate, factText, fontSize, textColor, textAlign, vertPos]);

  useEffect(() => { redraw(); }, [redraw]);

  const handleGenerate = async () => {
    if (!isAuthenticated) { login(); return; }

    setStatus("generating");
    setErrorMsg(null);

    try {
      const result = await createMeme.mutateAsync({
        data: {
          factId,
          templateId: selectedTemplate,
          textOptions: { fontSize, color: textColor, align: textAlign, verticalPosition: vertPos },
        },
      });

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

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-card border-2 border-border w-full max-w-3xl max-h-[95vh] overflow-y-auto rounded-sm shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b-2 border-border">
          <h2 className="text-2xl font-display uppercase tracking-widest text-primary">Meme Generator</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <canvas
            ref={canvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            className="w-full h-auto rounded-sm border-2 border-border"
          />

          <div>
            <p className="text-xs font-display uppercase tracking-widest text-muted-foreground mb-3">Style</p>
            <div className="grid grid-cols-5 gap-2">
              {templates.map(tpl => {
                const stops = GRADIENT_DEFS[tpl.id];
                const from = stops?.[0]?.[0] ?? "#000";
                const to = stops?.[stops.length - 1]?.[0] ?? "#333";
                const previewImg = tpl.previewImageUrl;
                return (
                  <button
                    key={tpl.id}
                    onClick={() => setSelectedTemplate(tpl.id)}
                    title={tpl.description}
                    className={`relative h-14 rounded-sm border-2 overflow-hidden transition-all ${
                      selectedTemplate === tpl.id
                        ? "border-primary ring-2 ring-primary/40 scale-105"
                        : "border-border hover:border-primary/50"
                    }`}
                    style={previewImg ? undefined : { background: `linear-gradient(135deg, ${from}, ${to})` }}
                  >
                    {previewImg && (
                      <img
                        src={previewImg}
                        alt={tpl.name}
                        className="absolute inset-0 w-full h-full object-cover"
                        loading="lazy"
                      />
                    )}
                    <span className="absolute inset-0 flex items-end justify-center pb-1">
                      <span className="text-white text-[9px] font-bold drop-shadow-lg truncate px-1">{tpl.name}</span>
                    </span>
                    {selectedTemplate === tpl.id && (
                      <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-primary rounded-full border border-white" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-display uppercase tracking-widest text-muted-foreground block mb-2">
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
            <div>
              <label className="text-xs font-display uppercase tracking-widest text-muted-foreground block mb-2">Text Color</label>
              <div className="flex gap-2 flex-wrap">
                {["#ffffff", "#ffcc00", "#ff6600", "#00ff88", "#ff4466"].map(c => (
                  <button
                    key={c}
                    onClick={() => setTextColor(c)}
                    className={`w-7 h-7 rounded-full border-2 transition-all ${textColor === c ? "border-white scale-110 ring-2 ring-white/40" : "border-transparent hover:scale-105"}`}
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
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-display uppercase tracking-widest text-muted-foreground mb-2">Alignment</p>
              <div className="flex gap-2">
                {(["left", "center", "right"] as TextAlign[]).map(a => (
                  <button
                    key={a}
                    onClick={() => setTextAlign(a)}
                    className={`flex-1 py-1.5 text-xs font-bold uppercase border-2 rounded-sm transition-all ${textAlign === a ? "border-primary bg-primary/20 text-primary" : "border-border hover:border-primary/50"}`}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-display uppercase tracking-widest text-muted-foreground mb-2">Position</p>
              <div className="flex gap-2">
                {(["top", "middle", "bottom"] as VertPos[]).map(p => (
                  <button
                    key={p}
                    onClick={() => setVertPos(p)}
                    className={`flex-1 py-1.5 text-xs font-bold uppercase border-2 rounded-sm transition-all ${vertPos === p ? "border-primary bg-primary/20 text-primary" : "border-border hover:border-primary/50"}`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {errorMsg && (
            <p className="text-destructive text-sm font-medium bg-destructive/10 border border-destructive/30 rounded-sm px-4 py-2">{errorMsg}</p>
          )}

          {status === "done" && permalinkSlug ? (
            <div className="bg-primary/10 border-2 border-primary rounded-sm p-4 space-y-3">
              <div className="flex items-center gap-3 text-primary">
                <CheckCircle className="w-5 h-5 shrink-0" />
                <span className="font-display uppercase tracking-wide font-bold text-sm">Meme Created!</span>
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
                <Button size="sm" onClick={() => { setStatus("idle"); setPermalinkSlug(null); }}>
                  Make Another
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-3">
              <Button
                onClick={handleGenerate}
                disabled={status === "generating"}
                isLoading={status === "generating"}
                className="flex-1"
              >
                {status === "generating" ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Generating...</>
                ) : (
                  isAuthenticated ? "GENERATE MEME" : "LOGIN TO GENERATE"
                )}
              </Button>
              <Button variant="secondary" className="gap-2" onClick={handleDownload}>
                <Download className="w-4 h-4" /> Download Preview
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
