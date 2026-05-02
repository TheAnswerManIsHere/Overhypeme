import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Layout } from "@/components/layout/Layout";
import { GarmentPreview, PRODUCTS, LAYOUTS } from "@/components/merch/GarmentPreview";
import { cn } from "@/components/ui/Button";
import { ArrowLeft, ExternalLink } from "lucide-react";

type MemeData = {
  id: number;
  factId: number;
  imageUrl: string;
  permalinkSlug: string;
  factText: string;
};

function ExtLinkIcon({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" /><path d="M10 14 21 3" />
    </svg>
  );
}

export default function WearIt() {
  const [, params] = useRoute("/wear/:slug");
  const [, setLocation] = useLocation();
  const slug = params?.slug ?? "";

  const [selectedProduct, setSelectedProduct] = useState(0);
  const [selectedLayout, setSelectedLayout] = useState(0);

  const { data: memeData } = useQuery<MemeData>({
    queryKey: ["meme-wear", slug],
    queryFn: async () => {
      const res = await fetch(`/api/memes/${slug}`, { credentials: "include" });
      if (!res.ok) throw new Error("Not found");
      return res.json() as Promise<MemeData>;
    },
    enabled: !!slug,
    retry: false,
  });

  const product = PRODUCTS[selectedProduct];
  const layout = LAYOUTS[selectedLayout];

  const handleZazzle = () => {
    // Zazzle handoff — in production this would open a deep link with the meme image
    window.open("https://www.zazzle.com", "_blank", "noopener");
  };

  return (
    <Layout>
      {/* Mobile layout */}
      <div className="md:hidden px-4 pt-4 pb-8">
        <button
          onClick={() => slug ? setLocation(`/meme/${slug}`) : setLocation("/")}
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground text-sm mb-5 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>

        <h1 className="font-display font-bold text-2xl uppercase tracking-tight leading-tight mb-1">
          Wear <span className="text-primary">your</span> meme.
        </h1>
        <p className="text-[13px] text-muted-foreground mb-5">Pick a thing. Pick a layout. Done.</p>

        {/* Garment preview */}
        <div className="rounded-[20px] bg-card border border-border overflow-hidden mb-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          <div className="aspect-square relative">
            <GarmentPreview type={product.type} accentColor={product.color} />
          </div>
          <div className="px-4 py-3 border-t border-border flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">Bella+Canvas 3001 · Unisex</span>
            <span className="font-display font-bold text-sm">{product.price}+</span>
          </div>
        </div>

        {/* Product picker */}
        <p className="text-[11px] font-bold tracking-[0.16em] text-muted-foreground uppercase font-display mb-3">Product</p>
        <div className="flex gap-2 overflow-x-auto pb-2 mb-5 no-scrollbar">
          {PRODUCTS.map((p, i) => (
            <button
              key={p.type}
              onClick={() => setSelectedProduct(i)}
              className={cn(
                "flex-shrink-0 w-[78px] rounded-[12px] overflow-hidden border transition-all",
                i === selectedProduct ? "border-primary border-2 bg-background" : "border-border bg-card"
              )}
            >
              <div className="h-[60px] relative">
                <GarmentPreview type={p.type} accentColor={i === selectedProduct ? "#0F0F11" : "#1a1a22"} />
              </div>
              <div className="py-2 px-1 text-center">
                <div className={cn("font-display font-bold text-[11px] uppercase tracking-wider", i === selectedProduct ? "text-foreground" : "text-muted-foreground")}>{p.label}</div>
                <div className="text-[10px] text-muted-foreground">{p.price}</div>
              </div>
            </button>
          ))}
        </div>

        {/* Layout picker */}
        <p className="text-[11px] font-bold tracking-[0.16em] text-muted-foreground uppercase font-display mb-3">Layout</p>
        <div className="grid grid-cols-3 gap-2 mb-6">
          {LAYOUTS.map((l, i) => (
            <button
              key={l.id}
              onClick={() => setSelectedLayout(i)}
              className={cn(
                "p-3 rounded-[12px] text-left border transition-all",
                i === selectedLayout ? "border-primary border-2 bg-background" : "border-border bg-card"
              )}
            >
              <div className={cn("font-display font-bold text-[12px] uppercase tracking-wider", i === selectedLayout ? "text-foreground" : "text-muted-foreground")}>{l.label}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">{l.sub}</div>
            </button>
          ))}
        </div>

        {/* CTA */}
        <button
          onClick={handleZazzle}
          className="w-full h-[52px] bg-primary text-white rounded-[14px] font-display font-bold text-[14px] uppercase tracking-[0.1em] flex items-center justify-center gap-2.5 hover:bg-primary/90 transition-colors"
        >
          Order on Zazzle <ExtLinkIcon size={16} />
        </button>
        <p className="text-center text-[11px] text-muted-foreground mt-3 leading-relaxed">
          Color &amp; size on Zazzle · Ships in 5–7 days<br />
          <span className="opacity-70">You'll continue checkout there.</span>
        </p>
      </div>

      {/* Desktop: two-pane */}
      <div className="hidden md:grid" style={{ gridTemplateColumns: "1.1fr 1fr", height: "calc(100vh - 64px)" }}>
        {/* Preview pane */}
        <div className="bg-secondary border-r border-border flex flex-col items-center justify-center p-12 overflow-auto">
          <p className="text-[11px] font-bold tracking-[0.18em] text-muted-foreground uppercase font-display mb-4 self-start">Preview</p>
          <div className="w-full max-w-[480px] aspect-square rounded-[24px] overflow-hidden shadow-[0_30px_80px_rgba(0,0,0,0.5)]">
            <GarmentPreview type={product.type} accentColor={product.color} />
          </div>
          <p className="text-[13px] text-muted-foreground mt-4 flex gap-2.5">
            <span>Bella+Canvas 3001</span><span className="opacity-40">·</span>
            <span>Unisex</span><span className="opacity-40">·</span>
            <span>100% cotton</span>
          </p>
        </div>

        {/* Controls pane */}
        <div className="p-14 overflow-auto">
          <button
            onClick={() => slug ? setLocation(`/meme/${slug}`) : setLocation("/")}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground text-sm mb-8 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </button>

          <h1 className="font-display font-bold text-[42px] uppercase tracking-tight leading-[0.96] mb-2">
            Wear <span className="text-primary">your</span> meme.
          </h1>
          <p className="text-[15px] text-muted-foreground mb-8 leading-relaxed">
            Pick a thing. Pick a layout. Continue checkout on Zazzle.
          </p>

          {/* Product picker */}
          <p className="text-[11px] font-bold tracking-[0.18em] text-muted-foreground uppercase font-display mb-3">1. Product</p>
          <div className="grid grid-cols-3 gap-2.5 mb-7">
            {PRODUCTS.map((p, i) => (
              <button
                key={p.type}
                onClick={() => setSelectedProduct(i)}
                className={cn(
                  "rounded-[14px] overflow-hidden border transition-all",
                  i === selectedProduct ? "border-primary border-2 bg-background" : "border-border bg-card"
                )}
              >
                <div className="aspect-square relative">
                  <GarmentPreview type={p.type} accentColor={i === selectedProduct ? "#0F0F11" : "#1a1a22"} />
                </div>
                <div className="px-3 py-2.5 border-t border-border flex items-center justify-between">
                  <span className={cn("font-display font-bold text-[13px] uppercase tracking-wider", i === selectedProduct ? "text-foreground" : "text-muted-foreground")}>{p.label}</span>
                  <span className="text-[12px] text-muted-foreground font-medium">{p.price}+</span>
                </div>
              </button>
            ))}
          </div>

          {/* Layout picker */}
          <p className="text-[11px] font-bold tracking-[0.18em] text-muted-foreground uppercase font-display mb-3">2. Layout</p>
          <div className="grid grid-cols-3 gap-2.5 mb-8">
            {LAYOUTS.map((l, i) => (
              <button
                key={l.id}
                onClick={() => setSelectedLayout(i)}
                className={cn(
                  "p-3.5 rounded-[14px] text-left border transition-all",
                  i === selectedLayout ? "border-primary border-2 bg-background" : "border-border bg-card"
                )}
              >
                <div className={cn("font-display font-bold text-[14px] uppercase tracking-wider", i === selectedLayout ? "text-foreground" : "text-muted-foreground")}>{l.label}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">{l.sub}</div>
              </button>
            ))}
          </div>

          {/* CTA */}
          <button
            onClick={handleZazzle}
            className="w-full h-[60px] bg-primary text-white rounded-[14px] font-display font-bold text-[15px] uppercase tracking-[0.12em] flex items-center justify-center gap-3 hover:bg-primary/90 transition-colors"
          >
            Order on Zazzle <ExtLinkIcon size={18} />
          </button>
          <p className="text-center text-[12px] text-muted-foreground mt-3.5 leading-relaxed">
            Color &amp; size on Zazzle · Ships in 5–7 days · You'll continue checkout there.
          </p>
        </div>
      </div>
    </Layout>
  );
}
