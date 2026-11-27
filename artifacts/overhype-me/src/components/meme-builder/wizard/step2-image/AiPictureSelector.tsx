import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { fetchMemberPictures, isInFlight, pictureKeys, STATUS_WORDS } from "@/components/ai-picture/pictureApi";

/**
 * The builder's AI pictures (launch Phase 7; plan
 * docs/plans/PLAN_PHASE7_AI_PICTURE_FLOW.md, *The picture step*). Making a
 * picture is its own flow, opened by "Make an AI picture"; here the member's
 * finished pictures of this fact are offered as backgrounds by tap, never
 * applied on their own, and pictures still drawing show their state with a
 * link back to the flow. Picking one changes the background only, never the
 * caption.
 */

/** One of the member's finished pictures of this fact (`GET /users/me/ai-images`). */
interface FinishedPicture {
  id: number;
  storagePath: string;
}

interface Props {
  factId: string;
  /** The AI picture currently used as the background, if any. */
  selectedAiImageId: number | null;
  onPicture: (picture: { aiImageId: number; imageUrl: string }) => void;
  /** Opens the picture flow, keeping the draft as it stands. */
  onMakePicture: () => void;
}

export function AiPictureSelector({ factId, selectedAiImageId, onPicture, onMakePicture }: Props) {
  const [finished, setFinished] = useState<FinishedPicture[]>([]);
  const [finishedCursor, setFinishedCursor] = useState<string | null>(null);

  const loadFinished = useCallback((cursor: string | null) => {
    const q = new URLSearchParams({ imageType: "member_picture", factId });
    if (cursor) q.set("cursor", cursor);
    return fetch(`/api/users/me/ai-images?${q}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { images: FinishedPicture[]; nextCursor: string | null } | null) => {
        if (!body || !Array.isArray(body.images)) return;
        setFinished((prev) => {
          const seen = new Set(cursor ? prev.map((f) => f.id) : []);
          return [...(cursor ? prev : []), ...body.images.filter((f) => !seen.has(f.id))];
        });
        setFinishedCursor(body.nextCursor ?? null);
      })
      .catch(() => undefined);
  }, [factId]);
  useEffect(() => { void loadFinished(null); }, [loadFinished]);

  // Pictures of this fact still drawing, re-read while any is; when one
  // finishes, the finished list is read again so it can be picked.
  const { data } = useQuery({
    queryKey: pictureKeys.list,
    queryFn: fetchMemberPictures,
    refetchInterval: (q) => (q.state.data?.pictures.some((p) => isInFlight(p)) ? 3000 : false),
  });
  const drawing = (data?.pictures ?? []).filter((p) => String(p.factId) === factId && isInFlight(p));
  const drawingCount = drawing.length;
  const lastDrawingCount = useRef(0);
  useEffect(() => {
    if (drawingCount < lastDrawingCount.current) void loadFinished(null);
    lastDrawingCount.current = drawingCount;
  }, [drawingCount, loadFinished]);

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onMakePicture}
        className="w-full rounded-md border border-primary/40 bg-primary/10 px-4 py-3 text-left text-sm font-medium text-foreground hover:bg-primary/20"
        data-testid="ai-picture-open"
      >
        Make an AI picture
        <span className="block text-xs font-normal text-muted-foreground">From your photo, drawn into the joke. One credit.</span>
      </button>

      {drawing.length > 0 && (
        <ul className="space-y-1" data-testid="ai-picture-drawing" aria-live="polite">
          {drawing.map((p) => (
            <li key={p.attemptId} className="flex items-center justify-between gap-2 rounded-md border border-white/10 px-3 py-2 text-sm">
              <span role="status">{STATUS_WORDS[p.status]}</span>
              <Link href={`/facts/${factId}/picture?from=builder`} onClick={(e) => { e.preventDefault(); onMakePicture(); }} className="shrink-0 text-xs underline">
                Follow it
              </Link>
            </li>
          ))}
        </ul>
      )}

      {finished.length > 0 && (
        <div className="space-y-2" data-testid="ai-picture-finished">
          <p className="text-sm font-medium">Your pictures of this fact</p>
          <div className="flex flex-wrap gap-2">
            {finished.map((f) => {
              const url = `/api/memes/ai-user/image?storagePath=${encodeURIComponent(f.storagePath)}`;
              const used = f.id === selectedAiImageId;
              return (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={used}
                  aria-label={used ? "Used as your background" : "Use this picture"}
                  onClick={() => onPicture({ aiImageId: f.id, imageUrl: url })}
                  className={`rounded border-2 ${used ? "border-primary" : "border-transparent"}`}
                >
                  <img src={url} alt="" className="h-20 w-16 rounded object-cover" loading="lazy" />
                </button>
              );
            })}
          </div>
          {finishedCursor && (
            <button type="button" className="text-xs underline text-muted-foreground" onClick={() => void loadFinished(finishedCursor)}>
              Show more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
