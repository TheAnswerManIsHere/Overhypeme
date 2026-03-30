import { useRef, useEffect, useState, useCallback } from "react";
import { Link } from "wouter";
import {
  useListMemeTemplates,
  useRequestUploadUrl,
  useCreateMeme,
} from "@workspace/api-client-react";
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

function drawMeme(canvas: HTMLCanvasElement, templateId: string, text: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const stops = GRADIENT_DEFS[templateId] ?? GRADIENT_DEFS["action"]!;
  const grad = ctx.createLinearGradient(0, 0, CANVAS_W, CANVAS_H);
  stops.forEach(([color, pos]) => grad.addColorStop(parseFloat(pos) / 100, color));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const sidebarW = 12;
  ctx.fillStyle = templateId === "fire" ? "#ff6d00" : templateId === "gold" ? "#ffd54f" : "#ff6600";
  ctx.fillRect(0, 0, sidebarW, CANVAS_H);

  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.font = `bold ${Math.floor(CANVAS_H * 0.45)}px serif`;
  ctx.textAlign = "right";
  ctx.fillText("CN", CANVAS_W - 24, CANVAS_H * 0.72);

  const padding = 56;
  const maxW = CANVAS_W - padding * 2 - sidebarW;
  const fontSize = text.length > 120 ? 22 : text.length > 70 ? 26 : 32;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.shadowColor = "rgba(0,0,0,0.8)";
  ctx.shadowBlur = 8;

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
  const startY = (CANVAS_H - totalH) / 2 + fontSize;
  lines.forEach((line, i) => {
    ctx.fillText(line, padding + sidebarW + 4, startY + i * lineH);
  });

  ctx.shadowBlur = 0;
  ctx.font = `bold 13px sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.textAlign = "right";
  ctx.fillText("chucknorrisfacts.app", CANVAS_W - 18, CANVAS_H - 14);
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
  const [status, setStatus] = useState<"idle" | "generating" | "done" | "error">("idle");
  const [permalinkSlug, setPermalinkSlug] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { data: tplData } = useListMemeTemplates();
  const requestUploadUrl = useRequestUploadUrl();
  const createMeme = useCreateMeme();

  const redraw = useCallback(() => {
    if (canvasRef.current) drawMeme(canvasRef.current, selectedTemplate, factText);
  }, [selectedTemplate, factText]);

  useEffect(() => { redraw(); }, [redraw]);

  const handleGenerate = async () => {
    if (!isAuthenticated) { login(); return; }
    if (!canvasRef.current) return;

    setStatus("generating");
    setErrorMsg(null);

    try {
      const blob: Blob = await new Promise((res, rej) => {
        canvasRef.current!.toBlob(b => b ? res(b) : rej(new Error("Canvas export failed")), "image/png");
      });

      const uploadResp = await requestUploadUrl.mutateAsync({
        data: {
          name: `fact-${factId}-${selectedTemplate}.png`,
          size: blob.size,
          contentType: "image/png",
        },
      });

      const putResp = await fetch(uploadResp.uploadURL, {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: blob,
      });
      if (!putResp.ok) throw new Error("Upload failed");

      const result = await createMeme.mutateAsync({
        data: {
          factId,
          templateId: selectedTemplate,
          objectPath: uploadResp.objectPath,
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
    link.download = `chuck-norris-fact-${factId}.png`;
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

        <div className="p-5 space-y-6">
          <canvas
            ref={canvasRef}
            width={CANVAS_W}
            height={CANVAS_H}
            className="w-full h-auto rounded-sm border-2 border-border"
          />

          <div>
            <p className="text-xs font-display uppercase tracking-widest text-muted-foreground mb-3">Choose Style</p>
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
                    className={`relative h-16 rounded-sm border-2 overflow-hidden transition-all ${
                      selectedTemplate === tpl.id
                        ? "border-primary ring-2 ring-primary/40 scale-105"
                        : "border-border hover:border-primary/50"
                    }`}
                    style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
                  >
                    <span className="absolute inset-0 flex items-end justify-center pb-1">
                      <span className="text-white text-[10px] font-bold drop-shadow-lg truncate px-1">{tpl.name}</span>
                    </span>
                    {selectedTemplate === tpl.id && (
                      <span className="absolute top-1 right-1 w-3 h-3 bg-primary rounded-full border border-white" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {errorMsg && (
            <p className="text-destructive text-sm font-medium bg-destructive/10 border border-destructive/30 rounded-sm px-4 py-2">{errorMsg}</p>
          )}

          {status === "done" && permalinkSlug ? (
            <div className="bg-primary/10 border-2 border-primary rounded-sm p-5 space-y-3">
              <div className="flex items-center gap-3 text-primary">
                <CheckCircle className="w-6 h-6 shrink-0" />
                <span className="font-display uppercase tracking-wide font-bold">Meme Created!</span>
              </div>
              <div className="flex flex-wrap gap-3">
                <Link href={`/meme/${permalinkSlug}`}>
                  <Button size="sm" variant="outline" className="gap-2">
                    <Share2 className="w-4 h-4" /> View Permalink
                  </Button>
                </Link>
                <Button size="sm" variant="secondary" className="gap-2" onClick={handleDownload}>
                  <Download className="w-4 h-4" /> Download
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
