import { useState } from "react";
import { useLocation, useRoute } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGetFact, getGetFactQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@workspace/replit-auth-web";
import { useToast } from "@/hooks/use-toast";
import { CACHED_COPY_NOTICE } from "@/lib/cachedCopyNotice";
import { Layout } from "@/components/layout/Layout";
import { AlertCircle, Ban, ArrowLeft, Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Link } from "wouter";
import {
  AdminMediaInfoForUrl,
  getFileNameFromUrl,
  getMimeTypeFromUrl,
  useImageDimensions,
} from "@/components/ui/AdminMediaInfo";
import { MemeHeartButton } from "@/components/memes/MemeHeartButton";
import { resolveViewerCell } from "@/pages/memePage/useViewerCell";
import {
  CTABarAnonOther,
  CTABarLegendaryOther,
  CTABarOwn,
  CTABarRegisteredOther,
} from "@/pages/memePage/cta/CTABar";
import { upgradeDestination } from "@/pages/memePage/upgradeDestination";
import { MemeShareModal } from "@/components/share/MemeShareModal";
import { useAskBefore } from "@/hooks/use-identity-gate";

interface StoredImageSource {
  type?: "upload" | "identity";
  templateId?: string;
}

interface MemeData {
  id: number;
  factId: number;
  templateId: string;
  imageUrl: string;
  permalinkSlug: string;
  permalinkUrl: string;
  isPublic: boolean;
  factText: string;
  createdAt: string;
  createdById: string | null;
  createdByName: string | null;
  originalWidth: number | null;
  originalHeight: number | null;
  uploadFileSizeBytes: number | null;
  heartCount: number;
  viewerHasHearted: boolean;
  isNsfw: boolean;
  imageTransform: string | null;
  imageSource: StoredImageSource | null;
}

type MemeResult =
  | { meme: MemeData; deleted: false; private: false }
  | { meme: null; deleted: true; private: false }
  // A live private meme this visitor may not see: the server says only that
  // it is private, so its link reads as real rather than broken (#591).
  | { meme: null; deleted: false; private: true };

function DimsFromUrl({ url }: { url: string }) {
  const dims = useImageDimensions(url);
  if (!dims) return <>…</>;
  return <>{dims.width}×{dims.height}</>;
}

export default function MemePage() {
  const [, params] = useRoute("/m/:slug");
  const { user, role, can } = useAuth();
  const slug = params?.slug ?? "";

  const { data: memeResult, isLoading, error } = useQuery<MemeResult>({
    queryKey: ["meme-page", slug],
    queryFn: async () => {
      const res = await fetch(`/api/memes/${slug}`, { credentials: "include" });
      if (res.status === 410) return { meme: null, deleted: true as const, private: false as const };
      if (res.status === 403) return { meme: null, deleted: false as const, private: true as const };
      if (!res.ok) throw new Error("Meme not found");
      const data = (await res.json()) as MemeData;
      return { meme: data, deleted: false as const, private: false as const };
    },
    enabled: !!slug,
    retry: false,
  });

  const meme = memeResult?.meme ?? null;
  const isDeleted = memeResult?.deleted === true;
  const isPrivate = memeResult?.private === true;
  const factId = meme?.factId;
  const { data: fact } = useGetFact(factId ?? 0, {
    query: { queryKey: getGetFactQueryKey(factId ?? 0), enabled: !!factId },
  });

  const [, setLocation] = useLocation();
  // In-page actions ask for a missing identity first (identity-flow Phase 3);
  // sign-in and sign-up go straight there (P3-1).
  const askBefore = useAskBefore();
  const [shareOpen, setShareOpen] = useState(false);
  const [ownerBusy, setOwnerBusy] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

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
          <p className="text-muted-foreground mb-6">This meme has been removed.</p>
          <Link href="/">
            <Button variant="outline" className="gap-2">
              <ArrowLeft className="w-4 h-4" /> Return to Base
            </Button>
          </Link>
        </div>
      </Layout>
    );
  }

  if (isPrivate) {
    return (
      <Layout>
        <div className="max-w-xl mx-auto mt-20 p-8 bg-card border border-border rounded-[20px] text-center" data-testid="meme-private">
          <Lock className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
          <h2 className="text-3xl font-display uppercase mb-2">This Meme Is Private</h2>
          <p className="text-muted-foreground mb-6">
            {user
              ? "Its creator has kept it to themselves."
              : "Its creator has kept it to themselves. If it's yours, sign in to see it."}
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {!user && (
              <Link href={`/login?from=${encodeURIComponent(`/m/${slug}`)}`}>
                <Button className="gap-2" data-testid="meme-private-sign-in">Sign in</Button>
              </Link>
            )}
            <Link href="/">
              <Button variant="outline" className="gap-2">
                <ArrowLeft className="w-4 h-4" /> Return to Base
              </Button>
            </Link>
          </div>
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
          <Link href="/">
            <Button variant="outline" className="gap-2">
              <ArrowLeft className="w-4 h-4" /> Return to Base
            </Button>
          </Link>
        </div>
      </Layout>
    );
  }

  const cell = resolveViewerCell({
    role,
    userId: user?.id ?? null,
    meme: { createdById: meme.createdById },
  });

  // "Make this fact about me" opens the standard meme builder on the fact's
  // own builder route, with this fact already chosen (#851). The button waits
  // for the fact to load, so a fact that is gone never opens an empty builder.
  const factReady = !!fact;

  const handleDownload = () => {
    const url = meme.imageUrl;
    const filename = `overhype-${slug}.jpg`;
    if (!url) return;
    fetch(url)
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
      })
      .catch(() => {
        // Browsers handle the download click gracefully; nothing useful to
        // surface to the user on a network blip.
      });
  };

  const handleCustomShare = () => {
    setShareOpen(true);
  };

  // #875 R3: visibility and delete from the meme's own page. The server's
  // message (a read-only pause, the Legendary gate) is what the toast shows.
  const ownerRequest = async (path: string, init: RequestInit): Promise<boolean> => {
    setOwnerBusy(true);
    try {
      const res = await fetch(path, { credentials: "include", ...init });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        toast({ title: body?.error ?? "That didn't work", variant: "destructive" });
        return false;
      }
      return true;
    } finally {
      setOwnerBusy(false);
    }
  };
  const handleSetPublic = async (next: boolean) => {
    const ok = await ownerRequest(`/api/memes/${slug}/visibility`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isPublic: next }),
    });
    if (!ok) return;
    toast(next ? { title: "Your meme is public" } : { title: "Your meme is private", description: CACHED_COPY_NOTICE });
    void queryClient.invalidateQueries({ queryKey: ["meme-page", slug] });
    void queryClient.invalidateQueries({ queryKey: ["profile-my-memes"] });
    if (factId) void queryClient.invalidateQueries({ queryKey: ["listFactMemes", factId] });
  };
  const handleDelete = async () => {
    const ok = await ownerRequest(`/api/memes/${slug}`, { method: "DELETE" });
    if (!ok) return;
    void queryClient.invalidateQueries({ queryKey: ["profile-my-memes"] });
    void queryClient.invalidateQueries({ queryKey: ["my-recently-deleted"] });
    if (factId) void queryClient.invalidateQueries({ queryKey: ["listFactMemes", factId] });
    toast({ title: "Meme deleted", description: "You can restore it from Recently deleted in your Library." });
    setLocation("/library?tab=deleted");
  };

  const openMakeAboutMe = () => {
    if (!factReady) return;
    setLocation(`/facts/${meme.factId}/meme`);
  };

  // A signed-out visitor's "make this about me" is a sign-up: there is no
  // background they can build on until Phase 7 (stock went with Pexels).
  const handleAnonMake = () => {
    window.location.href = upgradeDestination("registered", window.location.pathname + window.location.search).href;
  };

  let ctaBar: React.ReactNode = null;
  switch (cell) {
    case "anon-other":
      ctaBar = (
        <CTABarAnonOther onSignup={handleAnonMake} />
      );
      break;
    case "own":
      ctaBar = (
        <CTABarOwn
          onDownload={() => askBefore(handleDownload)}
          onCustomShare={() => askBefore(handleCustomShare)}
          isPublic={meme.isPublic}
          canMakePrivate={can("meme_private_visibility")}
          onSetPublic={(next) => { void handleSetPublic(next); }}
          onDelete={() => { void handleDelete(); }}
          busy={ownerBusy}
        />
      );
      break;
    case "registered-other":
      ctaBar = (
        <CTABarRegisteredOther
          onMakeAboutMe={openMakeAboutMe}
          factTemplateReady={factReady}
        />
      );
      break;
    case "legendary-other":
      ctaBar = (
        <CTABarLegendaryOther
          onMakeAboutMe={openMakeAboutMe}
          factTemplateReady={factReady}
        />
      );
      break;
  }

  return (
    <Layout>
      {/* ── Mobile layout ─────────────────────────────────── */}
      <div className="md:hidden px-4 pt-4 pb-10">
        <div className="flex items-center gap-3 mb-4">
          <span
            data-testid="saved-chip"
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-500/16 text-green-400 text-[11px] font-bold tracking-[0.12em] font-display uppercase border border-green-500/30"
          >
            ✓ Saved
          </span>
          <span className="text-[11px] text-muted-foreground" data-testid="dims-meta">
            {meme.originalWidth && meme.originalHeight
              ? `${meme.originalWidth}×${meme.originalHeight}`
              : <DimsFromUrl url={meme.imageUrl} />}{" "}
            · ready
          </span>
        </div>

        <div className="rounded-[20px] overflow-hidden mb-3 shadow-[0_12px_32px_rgba(0,0,0,0.4)]">
          <img src={meme.imageUrl} alt="Meme" className="w-full object-cover" loading="eager" />
        </div>
        <div className="mb-5 flex items-center">
          <MemeHeartButton
            memeId={meme.id}
            initialHeartCount={meme.heartCount}
            initialViewerHasHearted={meme.viewerHasHearted}
          />
        </div>

        <div className="mb-3">
          <h2 className="font-display font-bold text-[18px] uppercase tracking-tight leading-tight">
            What&apos;s <span className="text-primary">next</span>?
          </h2>
        </div>
        {ctaBar}

        <p className="text-xs text-muted-foreground text-center mt-4" data-testid="meme-made-on">
          {meme.createdByName && (
            <>Generated by <span className="text-primary font-bold">{meme.createdByName}</span> · </>
          )}
          {new Date(meme.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
        </p>

        {fact && (
          <div className="mt-4 text-center">
            <Link
              href={`/facts/${factId}`}
              className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              View full fact →
            </Link>
          </div>
        )}
      </div>

      {/* ── Desktop two-pane ──────────────────────────────── */}
      <div
        className="hidden md:grid"
        style={{ gridTemplateColumns: "1fr 1fr", height: "calc(100vh - 64px)" }}
      >
        <div className="bg-secondary border-r border-border flex flex-col items-center justify-center p-12 overflow-auto">
          <div className="flex items-center gap-3 mb-5 self-start">
            <span
              data-testid="saved-chip-desktop"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-green-500/16 text-green-400 text-[11px] font-bold tracking-[0.16em] font-display uppercase border border-green-500/30"
            >
              ✓ Saved
            </span>
            <span className="text-[12px] text-muted-foreground" data-testid="dims-meta-desktop">
              {meme.originalWidth && meme.originalHeight
                ? `${meme.originalWidth}×${meme.originalHeight}`
                : <DimsFromUrl url={meme.imageUrl} />}{" "}
              · ready to download
            </span>
          </div>

          <div className="w-full max-w-[520px] rounded-[24px] overflow-hidden shadow-[0_30px_80px_rgba(0,0,0,0.5)]">
            <img src={meme.imageUrl} alt="Meme" className="w-full object-cover" />
          </div>
          <div className="w-full max-w-[520px] mt-3 flex items-center">
            <MemeHeartButton
              memeId={meme.id}
              initialHeartCount={meme.heartCount}
              initialViewerHasHearted={meme.viewerHasHearted}
            />
          </div>

          <AdminMediaInfoForUrl
            url={meme.imageUrl}
            fileName={getFileNameFromUrl(meme.imageUrl)}
            fileSizeBytes={meme.uploadFileSizeBytes}
            mimeType={getMimeTypeFromUrl(meme.imageUrl)}
          />
        </div>

        <div className="p-14 overflow-auto flex flex-col">
          <Link
            href={factId ? `/facts/${factId}` : "/"}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground text-sm mb-8 transition-colors self-start"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Fact
          </Link>

          <h1 className="font-display font-bold text-[42px] uppercase tracking-tight leading-[0.96] mb-2">
            What&apos;s <span className="text-primary">next</span>?
          </h1>
          <p className="text-[15px] text-muted-foreground mb-2 leading-relaxed">
            {meme.factText}
          </p>
          <p className="text-xs text-muted-foreground mb-8" data-testid="meme-made-on-desktop">
            {meme.createdByName ? <>Generated by <span className="text-primary font-bold">{meme.createdByName}</span> · </> : null}
            {new Date(meme.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
          </p>

          <div className="max-w-md w-full">{ctaBar}</div>

          {fact && (
            <Link
              href={`/facts/${factId}`}
              className="mt-6 text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2 self-start"
            >
              View full fact →
            </Link>
          )}
        </div>
      </div>

      <MemeShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        slug={slug}
        fallbackPermalink={`${typeof window !== "undefined" ? window.location.origin : ""}/m/${slug}`}
      />
    </Layout>
  );
}
