import type { ReactNode } from "react";
import { Link } from "wouter";
import { AlertTriangle } from "lucide-react";
import type { MemberPictureState } from "@/components/ai-picture/pictureApi";

/**
 * My content's "Your AI pictures" (launch Phase 7, increment 2): the pictures
 * still drawing, the ones that failed recently, and the finished list. Those
 * come from two requests, so the section shows when either has something to
 * say, and the finished list's own failure is said here rather than read past.
 */
export function MemberPicturesSection({ drawing, recentlyFailed, list, children }: {
  drawing: MemberPictureState[];
  recentlyFailed: MemberPictureState[];
  list: { items?: unknown[]; isLoading: boolean; isError: boolean };
  /** The finished pictures' grid, shown once the list has loaded. */
  children: ReactNode;
}) {
  const hasItems = !!list.items && list.items.length > 0;
  if (drawing.length === 0 && recentlyFailed.length === 0 && !list.isLoading && !list.isError && !hasItems) return null;
  return (
    <div className="mt-10" data-testid="my-ai-pictures">
      <h3 className="text-lg font-display uppercase tracking-wider text-foreground mb-1">Your AI Pictures</h3>
      <p className="text-sm text-muted-foreground mb-6">Pictures drawn from your photos. Use one as a meme background from that fact's meme builder.</p>
      {(drawing.length > 0 || recentlyFailed.length > 0) && (
        <ul className="mb-6 space-y-2" aria-live="polite">
          {drawing.map((p) => (
            <li key={p.attemptId} className="rounded-sm border-2 border-border bg-card px-3 py-2 text-sm">
              {p.status === "queued" ? "Waiting to start drawing…" : "Drawing…"}{" "}
              <Link href={`/facts/${p.factId}`} className="underline text-muted-foreground">this fact</Link>
            </li>
          ))}
          {recentlyFailed.map((p) => (
            <li key={p.attemptId} className="rounded-sm border-2 border-border bg-card px-3 py-2 text-sm">
              {p.reason} {p.creditReturned ? "Your credit was returned." : "Your credit will be returned shortly."}
            </li>
          ))}
        </ul>
      )}
      {list.isError ? (
        <div className="text-center py-8 bg-card border-2 border-destructive/30 rounded-sm" data-testid="my-ai-pictures-error">
          <AlertTriangle className="w-8 h-8 text-destructive/60 mx-auto mb-2" />
          <p className="text-muted-foreground font-medium">Could not load your pictures. Please try again later.</p>
        </div>
      ) : list.isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="aspect-[3/4] bg-card border-2 border-border rounded-sm animate-pulse" />
          ))}
        </div>
      ) : (
        children
      )}
    </div>
  );
}
