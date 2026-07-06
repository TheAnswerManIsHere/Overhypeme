import { useState } from "react";
import { ExternalLink, X } from "lucide-react";

export type PexelsGender = "male" | "female" | "neutral";
export const PEXELS_GENDERS: PexelsGender[] = ["male", "female", "neutral"];

export interface PexelsThumb {
  id: number;
  url: string;
  photographer?: string;
  photographer_url?: string;
}

export interface PexelsGalleryData {
  keywords: Record<PexelsGender, string> | null;
  images: Record<PexelsGender, PexelsThumb[]>;
}

export function emptyPexelsImages(): Record<PexelsGender, PexelsThumb[]> {
  return { male: [], female: [], neutral: [] };
}

export function pexelsImageTotals(images: Record<PexelsGender, PexelsThumb[]>): Record<PexelsGender, number> & { total: number } {
  const male = images.male.length;
  const female = images.female.length;
  const neutral = images.neutral.length;
  return { male, female, neutral, total: male + female + neutral };
}

export function PexelsImageGallery({ data, initialGender = "neutral" }: { data: PexelsGalleryData; initialGender?: PexelsGender }) {
  const [activeGender, setActiveGender] = useState<PexelsGender>(initialGender);
  const [lightboxPhoto, setLightboxPhoto] = useState<PexelsThumb | null>(null);
  const totals = pexelsImageTotals(data.images);

  return (
    <>
      <div className="flex items-center gap-1.5" data-testid="pexels-gender-tabs">
        {PEXELS_GENDERS.map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setActiveGender(g)}
            className={`px-2 py-1 text-[10px] font-semibold uppercase tracking-wide rounded-sm ${
              activeGender === g ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            }`}
          >
            {g} ({totals[g]})
          </button>
        ))}
      </div>

      {data.keywords && (
        <p className="text-[10px] text-muted-foreground italic">
          Keywords ({activeGender}): {data.keywords[activeGender]}
        </p>
      )}

      <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5 max-h-72 overflow-auto" data-testid={`pexels-grid-${activeGender}`}>
        {data.images[activeGender].map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setLightboxPhoto(p)}
            // Fixed-height tiles (NOT aspect-square): inside a `max-h-* overflow-auto`
            // grid, aspect-ratio items can compress rows instead of scrolling.
            className="group relative block h-20 overflow-hidden rounded-sm border border-border text-left"
            title={p.photographer ? `Photo by ${p.photographer}` : "Open image"}
          >
            <img src={p.url} alt="" loading="lazy" className="h-full w-full object-cover" />
            {p.photographer && (
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 py-0.5 text-[8px] text-white opacity-0 group-hover:opacity-100">
                {p.photographer}
              </span>
            )}
          </button>
        ))}
      </div>

      <a
        href="https://www.pexels.com"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
      >
        Photos provided by Pexels <ExternalLink className="w-2.5 h-2.5" />
      </a>

      {lightboxPhoto && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          role="dialog"
          aria-modal="true"
          data-testid="pexels-lightbox"
          onClick={() => setLightboxPhoto(null)}
        >
          <button
            type="button"
            onClick={() => setLightboxPhoto(null)}
            className="absolute right-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
            aria-label="Close image"
            data-testid="pexels-lightbox-close"
          >
            <X className="h-5 w-5" />
          </button>
          <figure className="max-h-full max-w-full" onClick={(e) => e.stopPropagation()}>
            <img src={lightboxPhoto.url} alt="" className="max-h-[85dvh] max-w-[95vw] object-contain" />
            {lightboxPhoto.photographer && (
              <figcaption className="mt-2 text-center text-xs text-white/80">
                Photo by{" "}
                <a href={lightboxPhoto.photographer_url ?? "https://www.pexels.com"} target="_blank" rel="noreferrer" className="underline">
                  {lightboxPhoto.photographer}
                </a>
              </figcaption>
            )}
          </figure>
        </div>
      )}
    </>
  );
}
