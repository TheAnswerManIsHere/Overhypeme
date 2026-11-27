import { useEffect, useRef } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  fetchFinishedPictures,
  fetchMemberPictures,
  isInFlight,
  pictureKeys,
  STATUS_WORDS,
} from "@/components/ai-picture/pictureApi";

/**
 * The builder's AI pictures (launch Phase 7; plan
 * docs/plans/PLAN_PHASE7_AI_PICTURE_FLOW.md, *The picture step*). Making a
 * picture is its own flow, opened by "Make an AI picture"; here the member's
 * finished pictures of this fact are offered as backgrounds by tap, never
 * applied on their own, and pictures still drawing show their state with a
 * link back to the flow. Picking one changes the background only, never the
 * caption.
 */

interface Props {
  factId: string;
  /** The AI picture currently used as the background, if any. */
  selectedAiImageId: number | null;
  onPicture: (picture: { aiImageId: number; imageUrl: string }) => void;
  /** Opens the picture flow, keeping the draft as it stands. */
  onMakePicture: () => void;
}

export function AiPictureSelector({ factId, selectedAiImageId, onPicture, onMakePicture }: Props) {
  const finishedQuery = useInfiniteQuery({
    queryKey: pictureKeys.finished(factId),
    queryFn: ({ pageParam }) => fetchFinishedPictures(factId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const finished = finishedQuery.data?.pages.flatMap((p) => p.images) ?? [];

  // Pictures of this fact still drawing, re-read while any is; when one
  // finishes, the finished list is read again so it can be picked.
  const drawingOf = (pictures: Awaited<ReturnType<typeof fetchMemberPictures>>["pictures"] | undefined) =>
    (pictures ?? []).filter((p) => String(p.factId) === factId && isInFlight(p));
  const { data } = useQuery({
    queryKey: pictureKeys.list,
    queryFn: fetchMemberPictures,
    refetchInterval: (q) => (drawingOf(q.state.data?.pictures).length > 0 ? 3000 : false),
  });
  const drawing = drawingOf(data?.pictures);
  const drawingCount = drawing.length;
  const lastDrawingCount = useRef(0);
  const refetchFinished = finishedQuery.refetch;
  useEffect(() => {
    if (drawingCount < lastDrawingCount.current) void refetchFinished();
    lastDrawingCount.current = drawingCount;
  }, [drawingCount, refetchFinished]);

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
              <button type="button" onClick={onMakePicture} className="shrink-0 text-xs underline">
                Follow it
              </button>
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
          {finishedQuery.hasNextPage && (
            <button type="button" className="text-xs underline text-muted-foreground" onClick={() => void finishedQuery.fetchNextPage()}>
              Show more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
