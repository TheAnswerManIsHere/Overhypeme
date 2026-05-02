import { useRoute, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useGetFact, getGetFactQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@workspace/replit-auth-web";
import { Layout } from "@/components/layout/Layout";
import { GarmentPreview, PRODUCTS } from "@/components/merch/GarmentPreview";
import { AlertCircle, Ban, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Link } from "wouter";
import { AdminMediaInfo, getFileNameFromUrl, getMimeTypeFromUrl } from "@/components/ui/AdminMediaInfo";

type MemeData = {
  id: number;
  factId: number;
  templateId: string;
  imageUrl: string;
  permalinkSlug: string;
  isPublic: boolean;
  factText: string;
  createdAt: string;
  createdByName: string | null;
  originalWidth: number | null;
  originalHeight: number | null;
  uploadFileSizeBytes: number | null;
};

function ExtLinkIcon({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" /><path d="M10 14 21 3" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
      <line x1="8.6" y1="13.5" x2="15.4" y2="17.5" /><line x1="15.4" y1="6.5" x2="8.6" y2="10.5" />
    </svg>
  );
}

function TeeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m4 6 6-3 4 4 4-4 6 3-3 6h-3v9H7v-9H4Z" />
    </svg>
  );
}

export default function MemePage() {
  const [, params] = useRoute("/meme/:slug");
  const [location, setLocation] = useLocation();
  const { user, role } = useAuth();
  const isLegendary = role === "legendary" || role === "admin";
  const slug = params?.slug ?? "";

  // Deterministic "just created a photo meme" signal — set by MemeBuilder when
  // it navigates here on success (`?just_created=1&source=photo`). This is far
  // more reliable than matching on display name (which can collide or change).
  const searchParams = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : ""
  );
  const justCreated = searchParams.get("just_created") === "1";
  const createdSource = searchParams.get("source");
  const justCreatedPhotoMeme = justCreated && createdSource === "photo";
  void location;

  const { data: memeResult, isLoading, error } = useQuery<
    { meme: MemeData; deleted: false } | { meme: null; deleted: true }
  >({
    queryKey: ["meme-page", slug],
    queryFn: async () => {
      const res = await fetch(`/api/memes/${slug}`, { credentials: "include" });
      if (res.status === 410) return { meme: null, deleted: true as const };
      if (!res.ok) throw new Error("Meme not found");
      const data = await res.json() as MemeData;
      return { meme: data, deleted: false as const };
    },
    enabled: !!slug,
    retry: false,
  });

  const meme = memeResult?.meme ?? null;
  const isDeleted = memeResult?.deleted === true;
  const factId = meme?.factId;
  const { data: fact } = useGetFact(factId ?? 0, {
    query: { queryKey: getGetFactQueryKey(factId ?? 0), enabled: !!factId }
  });

  const handleShare = () => {
    if (navigator.share) {
      navigator.share({
        title: "Overhype.me Meme",
        text: meme?.factText ?? "Check out this fact!",
        url: window.location.href,
      }).catch(console.error);
    } else {
      navigator.clipboard.writeText(window.location.href).then(() => alert("Link copied!"));
    }
  };

  const handleDownload = () => {
    if (!meme?.imageUrl) return;
    fetch(meme.imageUrl)
      .then(r => r.blob())
      .then(blob => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `overhype-${slug}.jpg`;
        a.click();
      })
      .catch(console.error);
  };

  if (isLoading) {
    return (
      <Layout>
        <div className="flex h-[50vh] items-center justify-center">
          <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      </Layout>
    );
  }

  if (isDeleted) {
    return (
      <Layout>
        <div className="max-w-xl mx-auto mt-20 p-8 bg-card border border-border rounded-[20px] text-center">
          <Ban className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-3xl font-display uppercase mb-2">Meme Removed</h2>
          <p className="text-muted-foreground mb-6">This meme has been removed by its creator.</p>
          <Link href="/"><Button variant="outline" className="gap-2"><ArrowLeft className="w-4 h-4" /> Return to Base</Button></Link>
        </div>
      </Layout>
    );
  }

  if (error || !meme) {
    return (
      <Layout>
        <div className="max-w-xl mx-auto mt-20 p-8 bg-destructive/10 border border-destructive rounded-[20px] text-center">
          <AlertCircle className="w-16 h-16 text-destructive mx-auto mb-4" />
          <h2 className="text-3xl font-display text-destructive uppercase mb-2">Meme Not Found</h2>
          <p className="text-muted-foreground mb-6">This classified image has been redacted.</p>
          <Link href="/"><Button variant="outline" className="gap-2"><ArrowLeft className="w-4 h-4" /> Return to Base</Button></Link>
        </div>
      </Layout>
    );
  }

  // The dopamine-afterglow "What's next?" panel is shown to every
  // non-Legendary viewer — both the creator (immediately after building, the
  // moment of peak satisfaction) and visitors who land here via a share link
  // (where the upsell becomes "this could be you"). Legendary users already
  // have access and fall back to the simpler 3-track layout.
  //
  // When `showAfterglowUpgrade` is true, the page presents two co-equal
  // "What's next?" answers — Wear (physical artifact) and AI (more / wilder
  // generation). Wear and AI are not competing; they're two different replies
  // to "I loved that, what now?". Copy diverges based on whether this is the
  // creator's post-success transition (deterministic via
  // ?just_created=1&source=photo) so visitors aren't told they made the meme.
  const showAfterglowUpgrade = !isLegendary;
  const isCreatorAfterglow = justCreatedPhotoMeme;
  const showLegendaryTile = !showAfterglowUpgrade;
  // Personalize the creator-variant teaser with the creator's name when we
  // have it; fall back to the signed-in user's name, then "you".
  const teaserName = meme.createdByName ?? user?.displayName ?? "you";

  // Pass `?source=meme-page` through to /wear/:slug so when the user
  // ultimately taps "Open in Zazzle" on the WearIt page, the affiliate click
  // is attributed to where the journey actually started.
  const wearHref = `/wear/${slug}?source=meme-page`;

  // Copy that diverges between the creator (post-success afterglow) and a
  // visitor (landed via a share link). Anything that would imply ownership
  // of the meme — the mobile eyebrow and the desktop subheader — flips to a
  // "this could be you" framing for visitors. The Wear / AI cards
  // themselves and the universal "What's next?" header stay the same.
  const afterglowCopy = isCreatorAfterglow
    ? {
        mobileEyebrow: "Nice. That's a good one.",
        desktopSubheader:
          "Your meme is yours. Share it free, wear it, or turn it into something nobody's ever seen.",
      }
    : {
        mobileEyebrow: "Like this one? Take it further.",
        desktopSubheader:
          "Like this one? Share it, wear it — or make a Legendary one with you as the literal subject.",
      };

  const tracks = [
    {
      label: "Share",
      sub: "Free",
      icon: <ShareIcon />,
      primary: false,
      onClick: handleShare,
    },
    {
      label: "Wear it",
      sub: `From $5`,
      icon: <TeeIcon />,
      primary: true,
      onClick: () => setLocation(wearHref),
    },
    ...(showLegendaryTile
      ? [{
          label: "Legendary",
          sub: "AI",
          icon: <span className="text-xl">👑</span>,
          primary: false,
          onClick: () => setLocation("/pricing"),
        }]
      : []),
  ];

  return (
    <Layout>
      {/* ── Mobile layout ─────────────────────────────────── */}
      <div className="md:hidden px-4 pt-4 pb-10">
        {/* Status bar */}
        <div className="flex items-center gap-3 mb-4">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-500/16 text-green-400 text-[11px] font-bold tracking-[0.12em] font-display uppercase border border-green-500/30">
            ✓ Saved
          </span>
          <span className="text-[11px] text-muted-foreground">
            {meme.originalWidth && meme.originalHeight ? `${meme.originalWidth}×${meme.originalHeight}` : "1080×1080"} · ready
          </span>
        </div>

        {/* Meme hero */}
        <div className="rounded-[20px] overflow-hidden mb-5 shadow-[0_12px_32px_rgba(0,0,0,0.4)]">
          <img src={meme.imageUrl} alt="Meme" className="w-full object-cover" loading="eager" />
        </div>

        {/* "What's next?" header (only shown when we present co-equal answers,
            not when we're falling back to the older 3-track layout). */}
        {showAfterglowUpgrade && (
          <div className="mb-3">
            <p className="text-[10px] font-bold tracking-[0.18em] text-primary uppercase font-display mb-0.5">
              {afterglowCopy.mobileEyebrow}
            </p>
            <h2 className="font-display font-bold text-[18px] uppercase tracking-tight leading-tight">
              What&apos;s next?
            </h2>
          </div>
        )}

        {/* Two co-equal answers (afterglow path) — wear (physical artifact)
            on the left, AI (more / wilder generation) on the right. Each has
            a thumbnail/preview and a single primary CTA — neither hides
            inside a small button or dropdown. */}
        {showAfterglowUpgrade ? (
          <div className="grid grid-cols-2 gap-3 mb-4">
            {/* Wear card */}
            <button
              onClick={() => setLocation(wearHref)}
              className="flex flex-col rounded-[16px] bg-card border border-border overflow-hidden text-left hover:border-primary/40 transition-colors"
            >
              <div className="aspect-square relative bg-secondary">
                <GarmentPreview type="tee" accentColor="#0F0F11" />
              </div>
              <div className="p-3">
                <p className="text-[9px] font-display font-bold tracking-[0.18em] text-muted-foreground uppercase mb-0.5">
                  Make it physical
                </p>
                <h3 className="font-display font-bold text-[14px] uppercase tracking-tight leading-tight mb-1.5">
                  Wear this meme
                </h3>
                <p className="text-[11px] text-muted-foreground leading-snug mb-2.5">
                  Tee · hoodie · mug · sticker. From $5.
                </p>
                <span className="inline-flex items-center justify-center gap-1.5 w-full h-[40px] rounded-[10px] bg-primary text-white font-display font-bold text-[11px] uppercase tracking-wider">
                  Pick a thing →
                </span>
              </div>
            </button>

            {/* AI card */}
            <button
              onClick={() => setLocation(factId ? `/facts/${factId}?mode=ai` : "/pricing")}
              className="flex flex-col rounded-[16px] overflow-hidden text-left bg-gradient-to-br from-primary/15 via-card to-card border border-primary/40 transition-colors"
            >
              <div className="aspect-square relative flex items-center justify-center" style={{ background: "radial-gradient(circle at 30% 30%, rgba(249,115,22,0.35), transparent 60%), linear-gradient(180deg, #1a1a1d 0%, #0f0f11 100%)" }}>
                <span className="text-5xl">👑</span>
              </div>
              <div className="p-3">
                <p className="text-[9px] font-display font-bold tracking-[0.18em] text-primary uppercase mb-0.5">
                  Make more, wilder
                </p>
                <h3 className="font-display font-bold text-[14px] uppercase tracking-tight leading-tight mb-1.5">
                  Try AI mode
                </h3>
                <p className="text-[11px] text-muted-foreground leading-snug mb-2.5">
                  AI casts {teaserName} as the literal subject.
                </p>
                <span className="inline-flex items-center justify-center gap-1.5 w-full h-[40px] rounded-[10px] bg-primary text-white font-display font-bold text-[11px] uppercase tracking-wider">
                  Try AI mode →
                </span>
              </div>
            </button>
          </div>
        ) : (
          <>
            {/* Fallback (no afterglow): 3 action tracks. */}
            <div className="grid grid-cols-3 gap-2 mb-5">
              {tracks.map(t => (
                <button
                  key={t.label}
                  onClick={t.onClick}
                  className={`flex flex-col items-center gap-1.5 py-3.5 px-2 rounded-[14px] border transition-colors ${
                    t.primary
                      ? "bg-primary border-transparent text-white"
                      : "bg-card border-border text-foreground hover:border-primary/40"
                  }`}
                >
                  <div className="h-[22px] flex items-center justify-center">{t.icon}</div>
                  <div className="font-display font-bold text-[12px] uppercase tracking-[0.1em]">{t.label}</div>
                  <div className={`text-[10px] font-medium ${t.primary ? "opacity-85" : "opacity-55"}`}>{t.sub}</div>
                </button>
              ))}
            </div>

            {/* Wear this meme preview (only in fallback — in the afterglow
                path the wear card above already serves this role). */}
            <div className="rounded-[20px] bg-card border border-border p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-[11px] font-bold tracking-[0.16em] text-foreground uppercase font-display">Wear this meme</p>
                  <p className="text-[12px] text-muted-foreground mt-0.5">Your meme. Printed on something.</p>
                </div>
                <span className="text-muted-foreground text-lg">›</span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {PRODUCTS.slice(0, 4).map(p => (
                  <button
                    key={p.type}
                    onClick={() => setLocation(wearHref)}
                    className="rounded-[12px] bg-background border border-border overflow-hidden hover:border-primary/40 transition-colors"
                  >
                    <div className="aspect-square relative">
                      <GarmentPreview type={p.type} accentColor={p.color} />
                    </div>
                    <div className="px-3 py-2 flex items-center justify-between">
                      <span className="font-display font-bold text-[12px] uppercase tracking-wider">{p.label}</span>
                      <span className="text-[12px] text-muted-foreground font-medium">{p.price}+</span>
                    </div>
                  </button>
                ))}
              </div>

              <div className="flex items-center justify-center gap-1.5 mt-4 text-[10px] text-muted-foreground">
                Powered by Zazzle <ExtLinkIcon size={10} />
              </div>
            </div>
          </>
        )}

        {/* Quiet share-link footer (always available — share is universal but
            no longer dominant once the user is in the wear-vs-AI choice). */}
        <button
          onClick={handleShare}
          className="w-full mt-4 flex items-center justify-center gap-2 text-[12px] text-muted-foreground hover:text-foreground transition-colors min-h-[44px]"
        >
          <ShareIcon /> Share this meme
        </button>

        {meme.createdByName && (
          <p className="text-xs text-muted-foreground text-center mt-4">
            Generated by <span className="text-primary font-bold">{meme.createdByName}</span>
          </p>
        )}
      </div>

      {/* ── Desktop: two-pane ─────────────────────────────── */}
      <div className="hidden md:grid" style={{ gridTemplateColumns: "1fr 1fr", height: "calc(100vh - 64px)" }}>
        {/* Meme pane L */}
        <div className="bg-secondary border-r border-border flex flex-col items-center justify-center p-12 overflow-auto">
          <div className="flex items-center gap-3 mb-5 self-start">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-green-500/16 text-green-400 text-[11px] font-bold tracking-[0.16em] font-display uppercase border border-green-500/30">
              ✓ Saved
            </span>
            <span className="text-[12px] text-muted-foreground">
              {meme.originalWidth && meme.originalHeight ? `${meme.originalWidth}×${meme.originalHeight}` : "1080×1080"} · ready to download
            </span>
          </div>

          <div className="w-full max-w-[520px] rounded-[24px] overflow-hidden shadow-[0_30px_80px_rgba(0,0,0,0.5)]">
            <img src={meme.imageUrl} alt="Meme" className="w-full object-cover" />
          </div>

          <AdminMediaInfo
            fileName={getFileNameFromUrl(meme.imageUrl)}
            fileSizeBytes={meme.uploadFileSizeBytes}
            mimeType={getMimeTypeFromUrl(meme.imageUrl)}
            width={meme.originalWidth}
            height={meme.originalHeight}
          />
        </div>

        {/* Tracks pane R */}
        <div className="p-14 overflow-auto flex flex-col">
          <button
            onClick={() => factId ? setLocation(`/facts/${factId}`) : setLocation("/")}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground text-sm mb-8 transition-colors self-start"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Fact
          </button>

          <h1 className="font-display font-bold text-[42px] uppercase tracking-tight leading-[0.96] mb-2">
            What's <span className="text-primary">next</span>?
          </h1>
          <p className="text-[15px] text-muted-foreground mb-8 leading-relaxed">
            {afterglowCopy.desktopSubheader}
          </p>

          {/* Afterglow path: two co-equal cards side-by-side. Wear (physical
              artifact) on the left, AI (more / wilder generation) on the
              right. Both cards have the same height, the same visual weight,
              and a single primary CTA each — neither is presented as
              "secondary" relative to the other. Share moves to a quiet
              footer link below. */}
          {showAfterglowUpgrade ? (
            <div className="grid grid-cols-2 gap-4 flex-1">
              {/* Wear card */}
              <button
                onClick={() => setLocation(wearHref)}
                className="flex flex-col rounded-[20px] bg-card border border-border overflow-hidden text-left hover:border-primary/40 transition-colors"
              >
                <div className="aspect-[4/3] relative bg-secondary border-b border-border">
                  <GarmentPreview type="tee" accentColor="#0F0F11" />
                </div>
                <div className="p-5 flex flex-col flex-1">
                  <p className="text-[10px] font-display font-bold tracking-[0.18em] text-muted-foreground uppercase mb-1">
                    Make it physical
                  </p>
                  <h3 className="font-display font-bold text-[20px] uppercase tracking-tight leading-tight mb-1.5">
                    Wear this meme
                  </h3>
                  <p className="text-[13px] text-muted-foreground leading-relaxed mb-4">
                    Tee, hoodie, mug, or sticker — from $5. Ships from Zazzle.
                  </p>
                  <span className="mt-auto inline-flex items-center justify-center gap-2 h-[48px] rounded-[12px] bg-primary text-white font-display font-bold text-[12px] uppercase tracking-wider">
                    Pick a thing <ExtLinkIcon size={14} />
                  </span>
                </div>
              </button>

              {/* AI card */}
              <button
                onClick={() => setLocation(factId ? `/facts/${factId}?mode=ai` : "/pricing")}
                className="flex flex-col rounded-[20px] overflow-hidden text-left bg-gradient-to-br from-primary/15 via-card to-card border border-primary/40 transition-colors"
              >
                <div className="aspect-[4/3] relative flex items-center justify-center border-b border-primary/30" style={{ background: "radial-gradient(circle at 30% 35%, rgba(249,115,22,0.32), transparent 60%), linear-gradient(180deg, #1a1a1d 0%, #0f0f11 100%)" }}>
                  <span className="text-7xl">👑</span>
                </div>
                <div className="p-5 flex flex-col flex-1">
                  <p className="text-[10px] font-display font-bold tracking-[0.18em] text-primary uppercase mb-1">
                    Make more, wilder
                  </p>
                  <h3 className="font-display font-bold text-[20px] uppercase tracking-tight leading-tight mb-1.5">
                    Try AI mode
                  </h3>
                  <p className="text-[13px] text-muted-foreground leading-relaxed mb-4">
                    AI dramatizes the fact and casts {teaserName} as the literal subject — same meme, ten times bigger.
                  </p>
                  <span className="mt-auto inline-flex items-center justify-center gap-2 h-[48px] rounded-[12px] bg-primary text-white font-display font-bold text-[12px] uppercase tracking-wider">
                    Try AI mode →
                  </span>
                </div>
              </button>
            </div>
          ) : (
            /* Fallback: 3 full-width rows. Wear and Legendary are styled to
               feel co-equal (matching size, both with `border-primary/40`),
               with Share intentionally lighter as the universal/default. */
            <div className="flex flex-col gap-3 flex-1">
              {/* Share */}
              <button
                onClick={handleShare}
                className="flex items-center gap-4 p-5 rounded-[18px] bg-card border border-border hover:border-primary/40 transition-colors text-left"
              >
                <div className="w-[52px] h-[52px] rounded-full bg-background flex items-center justify-center text-muted-foreground flex-shrink-0">
                  <ShareIcon />
                </div>
                <div className="flex-1">
                  <div className="font-display font-bold text-[18px] uppercase tracking-tight">Download &amp; share</div>
                  <div className="text-[13px] text-muted-foreground mt-0.5">Save to your device · post anywhere · free forever</div>
                </div>
                <span className="text-muted-foreground text-xl">›</span>
              </button>

              {/* Wear it — co-equal with Legendary below. */}
              <button
                onClick={() => setLocation(wearHref)}
                className="flex items-center gap-4 p-6 rounded-[18px] bg-card border border-primary/40 hover:border-primary transition-colors text-left"
              >
                <div className="w-[52px] h-[52px] rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <TeeIcon />
                </div>
                <div className="flex-1">
                  <div className="font-display font-bold text-[18px] text-primary uppercase tracking-tight">Wear this meme</div>
                  <div className="text-[13px] text-muted-foreground mt-0.5">Tee · hoodie · mug · sticker · from $5 — ships from Zazzle</div>
                </div>
                <ExtLinkIcon size={20} className="text-primary" />
              </button>

              {/* AI / Legendary — same visual weight as Wear above. */}
              {showLegendaryTile && (
                <button
                  onClick={() => setLocation("/pricing")}
                  className="flex items-center gap-4 p-6 rounded-[18px] bg-card border border-primary/40 hover:border-primary transition-colors text-left"
                >
                  <div className="w-[52px] h-[52px] rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 text-2xl">
                    👑
                  </div>
                  <div className="flex-1">
                    <div className="font-display font-bold text-[18px] text-primary uppercase tracking-tight">Turn this up to 11</div>
                    <div className="text-[13px] text-muted-foreground mt-0.5">
                      AI dramatizes the fact — see {meme.createdByName ?? "you"} as the literal subject
                    </div>
                  </div>
                  <span className="text-primary text-xl">›</span>
                </button>
              )}
            </div>
          )}

          {/* Quiet share-link footer in the afterglow path (in the fallback,
              Share is already a full row above so we don't repeat it). */}
          {showAfterglowUpgrade && (
            <button
              onClick={handleShare}
              className="mt-5 inline-flex items-center justify-center gap-2 self-center text-[13px] text-muted-foreground hover:text-foreground transition-colors py-2"
            >
              <ShareIcon /> Or just share this meme
            </button>
          )}

          {fact && (
            <Link href={`/facts/${factId}`}>
              <button className="mt-6 text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2">
                View full fact →
              </button>
            </Link>
          )}

          <div className="flex items-center justify-center gap-2 mt-8 text-[11px] text-muted-foreground">
            Merch is print-on-demand · Powered by Zazzle <ExtLinkIcon size={11} />
          </div>
        </div>
      </div>
    </Layout>
  );
}
