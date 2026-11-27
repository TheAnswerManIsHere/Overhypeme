/**
 * @purpose Making an AI picture as its own flow (launch Phase 7; plan docs/plans/PLAN_PHASE7_AI_PICTURE_FLOW.md): photo → Fact Visualization Options → Stylize it → shape → the name on the meme → cost → Make it, then the picture's progress and the hand-off to the meme builder.
 * @subsystem visual-pipeline
 *
 * The server decides everything that costs or binds: the photo check says
 * whether the photo shows a person or a pet, and the command re-checks it, the
 * gag, the credit and the spend limit. The picture is drawn with the subject's
 * own name (the member's, or the pet's); the caption may name anyone (Q5: 2).
 * Loading goes through the query layer, with one automatic retry and a Try
 * again that keeps every choice (Issue #1315).
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AspectRatio, MyImageSource } from "@/components/meme-builder/types";
import { MyImagePicker } from "@/components/meme-builder/parts/MyImagePicker";
import { AspectRatioToggle } from "@/components/meme-builder/wizard/step2-image/AspectRatioToggle";
import { GuestPhotoSignupPanel } from "@/components/meme-builder/wizard/step2-image/GuestPhotoSignupPanel";
import { readBuilderDefaults, writePictureHandoff } from "@/components/meme-builder/wizard/state/wizardStorage";
import { PausedWhenReadOnly } from "@/components/PausedWhenReadOnly";
import { PRONOUN_PRESETS } from "@/lib/pronouns";
import { HighlightedFactText } from "@/components/facts/HighlightedFactText";
import { GagOptions } from "./GagOptions";
import { StylePicker } from "./StylePicker";
import {
  checkPhoto,
  fetchLookStyles,
  fetchMemberPicture,
  fetchMemberPictures,
  fetchPictureOptions,
  isInFlight,
  pictureKeys,
  PictureRequestError,
  simplePronouns,
  STATUS_WORDS,
  type MemberPictureState,
} from "./pictureApi";

export interface AiPictureFlowProps {
  factId: string;
  /** Token-laden fact text, shown in the subject's name for context. */
  factText: string;
  /** The member's own name and pronouns: the caption's default for a picture of them. */
  memberName: string;
  memberPronouns: string;
  signedIn: boolean;
  /** An unverified account gets the explanation, never the form. */
  verified: boolean;
  /** Opened from the meme builder: its shape and caption are the defaults, and Back returns to it. */
  fromBuilder: boolean;
  /** A gag to start on (the fact page's examples lead here with one). */
  initialGagId: number | null;
  /** Back, or cancel: to the builder when opened from it, else the fact. */
  onBack: () => void;
  /** Opens the builder for the fact, where the hand-off just written is applied. */
  onOpenBuilder: () => void;
}

const POLL_MS = 2500;
const PRONOUN_DEFAULT = "they/them";

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

interface CaptionIdentity {
  name: string;
  pronouns: string;
}

export function AiPictureFlow(props: AiPictureFlowProps) {
  const { signedIn, verified, onBack } = props;
  return (
    <div
      className="fixed inset-x-0 bottom-0 top-[var(--read-only-notice-h,0px)] z-50 overflow-y-auto bg-[#111] text-white"
      role="dialog"
      aria-modal="true"
      aria-label="Make an AI picture"
      data-testid="ai-picture-flow"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/10 bg-[#111] px-4 py-3">
        <button type="button" onClick={onBack} className="text-sm underline" data-testid="ai-picture-back">
          {props.fromBuilder ? "Back to your meme" : "Back"}
        </button>
        <h1 className="font-display text-lg tracking-wide">Make an AI picture</h1>
        <span className="w-12" aria-hidden />
      </div>
      <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
        {!signedIn ? (
          <GuestPhotoSignupPanel />
        ) : !verified ? (
          <p className="rounded-md border border-white/10 bg-white/5 p-4 text-sm">
            Verify your email to make AI pictures. <a href="/check-email" className="underline">Resend the email</a>
          </p>
        ) : (
          <FlowForm {...props} />
        )}
      </div>
    </div>
  );
}

function FlowForm({ factId, factText, memberName, memberPronouns, fromBuilder, initialGagId, onOpenBuilder }: AiPictureFlowProps) {
  const queryClient = useQueryClient();
  // Opened from the builder: its shape and caption identity are the defaults.
  const [builder] = useState(() => (fromBuilder ? readBuilderDefaults(factId) : null));

  const [photo, setPhoto] = useState<MyImageSource | null>(null);
  const [petName, setPetName] = useState("");
  const [petPronouns, setPetPronouns] = useState(PRONOUN_DEFAULT);
  const [gagId, setGagId] = useState<number | null>(initialGagId);
  const [lookStyleId, setLookStyleId] = useState<string | null>(null);
  const [shape, setShape] = useState<AspectRatio>(builder?.aspectRatio ?? "portrait");
  // The caption identity the member chose, here or in the builder; null while
  // it follows the picture's subject. A chosen identity is never replaced.
  const [chosenCaption, setChosenCaption] = useState<CaptionIdentity | null>(() =>
    builder?.chosenCaption ? { name: builder.chosenCaption.name, pronouns: builder.chosenCaption.pronouns ?? memberPronouns } : null,
  );
  const [activeId, setActiveId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // One request per confirmation, id and parameters together: a retried
  // request is the same picture, never a second credit, until the server answers.
  const pending = useRef<{ requestId: string; body: Record<string, unknown> } | null>(null);
  // A request was sent and its answer never came: it is resent exactly as it
  // was, whatever has changed since (the balance included), until the server
  // answers. The server decides credit, and returns the earlier picture.
  const [unconfirmed, setUnconfirmed] = useState(false);

  // ── The photo check: keyed by the chosen photo, so a result for a photo no
  // longer chosen can never set the subject.
  const uploadKey = photo?.objectPath ?? null;
  const photoCheck = useQuery({
    queryKey: pictureKeys.photoCheck(uploadKey ?? ""),
    queryFn: () => checkPhoto(uploadKey!),
    enabled: !!uploadKey,
    // A check can cost money: it runs once per photo chosen, and again only
    // when the member asks (Try again), never on focus or remount.
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
  const subject = photoCheck.data && photoCheck.data.uploadKey === uploadKey ? photoCheck.data.subject : null;
  const photoUnusable = photoCheck.error instanceof PictureRequestError && photoCheck.error.status === 422 ? photoCheck.error.message : null;

  // ── The choices: one automatic retry, then a Try again that keeps every selection.
  const options = useQuery({ queryKey: pictureKeys.options(factId), queryFn: () => fetchPictureOptions(factId), retry: 1 });
  const looks = useQuery({ queryKey: pictureKeys.looks, queryFn: fetchLookStyles, retry: 1, staleTime: Infinity });
  const gags = options.data?.gags;
  useEffect(() => {
    // A re-read keeps the member's gag while the fact still offers it.
    if (!gags) return;
    setGagId((prev) => (gags.some((g) => g.gagId === prev) ? prev : gags[0]?.gagId ?? null));
  }, [gags]);
  const retryLoad = () => {
    if (options.isError) void options.refetch();
    if (looks.isError) void looks.refetch();
  };

  // ── The member's pictures of this fact still drawing, shown on return. A
  // row stays once seen, so a picture that finishes shows its outcome; the
  // list is re-read while any of them other than the one followed (which is
  // polled on its own) is still in flight (docs/ai-context/async-ui-status.md).
  const [seenIds, setSeenIds] = useState<number[]>([]);
  const list = useQuery({
    queryKey: pictureKeys.list,
    queryFn: fetchMemberPictures,
    refetchInterval: (q) => (q.state.data?.pictures.some((p) => String(p.factId) === factId && p.attemptId !== activeId && isInFlight(p)) ? 5000 : false),
  });
  const ofThisFact = (list.data?.pictures ?? []).filter((p) => String(p.factId) === factId);
  const drawingIds = ofThisFact.filter(isInFlight).map((p) => p.attemptId);
  const drawingKey = drawingIds.join(",");
  useEffect(() => {
    if (!drawingKey) return;
    const ids = drawingKey.split(",").map(Number);
    setSeenIds((prev) => (ids.every((id) => prev.includes(id)) ? prev : [...new Set([...prev, ...ids])]));
  }, [drawingKey]);
  const otherRows = ofThisFact.filter((p) => seenIds.includes(p.attemptId) && p.attemptId !== activeId);
  const firstDrawing = drawingIds[0] ?? null;
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current || firstDrawing === null) return;
    adopted.current = true;
    setActiveId((prev) => prev ?? firstDrawing);
  }, [firstDrawing]);

  // ── The picture being followed.
  const active = useQuery({
    queryKey: pictureKeys.one(activeId),
    queryFn: () => fetchMemberPicture(activeId!),
    enabled: activeId !== null,
    staleTime: POLL_MS,
    refetchInterval: (q) => (q.state.data && !isInFlight(q.state.data.picture) ? false : POLL_MS),
  });
  const picture = active.data?.picture ?? null;
  const finishedStatus = picture && !isInFlight(picture) ? picture.status : null;
  useEffect(() => {
    // A finished picture changes the balance and the "next one is free" line.
    if (!finishedStatus) return;
    void queryClient.invalidateQueries({ queryKey: pictureKeys.options(factId) });
    void queryClient.invalidateQueries({ queryKey: pictureKeys.list });
    void queryClient.invalidateQueries({ queryKey: pictureKeys.finished(factId) });
  }, [finishedStatus, factId, queryClient]);

  // ── The caption: chosen, or the subject's own.
  // The picture is drawn with the subject's own name, and the description is
  // read in it; the caption defaults to it unless the member chose another.
  const isPet = subject === "pet";
  const drawn: CaptionIdentity = isPet ? { name: petName.trim(), pronouns: petPronouns } : { name: memberName, pronouns: memberPronouns };
  const caption = chosenCaption ?? drawn;
  const drawnName = drawn.name || "your pet";

  const credits = active.data?.credits ?? options.data?.credits ?? 0;
  const canAfford = credits >= 1;
  const cost = options.data?.nextIsFree ? "your free picture" : "1 credit";

  // Why Make it cannot be pressed yet, in words (#1315: no silent disabled form).
  const blocker = (() => {
    if (!uploadKey) return "Choose a photo of you or your pet first.";
    if (photoCheck.isPending) return "Checking your photo…";
    if (photoUnusable) return photoUnusable;
    if (!subject) return "We couldn't check this photo. Try again.";
    if (isPet && !drawn.name) return "Give your pet's name, for the picture.";
    if (options.isPending) return "Loading this fact's pictures…";
    // A failed re-read leaves the last answer cached; its cost line may be stale, so it waits for Try again.
    if (!options.data || options.isError) return "This fact's pictures didn't load. Try again above.";
    if (options.data.gags.length === 0) return "This fact has no picture to draw yet.";
    if (!canAfford) return "You have no credits left for a picture.";
    if (!caption.name.trim()) return "Put a name on the meme.";
    return null;
  })();

  const makeIt = async () => {
    if (submitting) return;
    if (!pending.current && (blocker || !uploadKey || !subject)) return;
    setSubmitting(true);
    setSubmitError(null);
    pending.current ??= {
      requestId: newRequestId(),
      body: {
        gagId: options.data?.choice ? gagId : null,
        uploadKey,
        lookStyleId,
        // Drawn with the subject's own name: the member's, or the pet's (Q5: 2).
        subject: isPet ? { kind: "pet", name: drawn.name, pronouns: simplePronouns(drawn.pronouns) } : { kind: "me" },
        aspectRatio: shape,
        caption: { name: caption.name.trim(), pronouns: simplePronouns(caption.pronouns) },
      },
    };
    const unsure = "We couldn't tell whether this picture started. Try again; you won't be charged twice.";
    try {
      const res = await fetch(`/api/facts/${encodeURIComponent(factId)}/member-pictures`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: pending.current.requestId, ...pending.current.body }),
      });
      const body = await res.json().catch(() => null);
      if (res.status >= 400 && res.status < 500) {
        // A refusal is final for this confirmation: the next try is a new request.
        pending.current = null;
        setUnconfirmed(false);
        setSubmitError(body?.message ?? "We couldn't start this picture. Try again.");
        return;
      }
      if (!res.ok || !body?.picture) {
        // A server error or an unreadable answer may still have started the picture: keep the request.
        setSubmitError(unsure);
        setUnconfirmed(true);
        return;
      }
      pending.current = null;
      setUnconfirmed(false);
      const started = body.picture as MemberPictureState;
      queryClient.setQueryData(pictureKeys.one(started.attemptId), { picture: started, credits: body.credits as number });
      setActiveId(started.attemptId);
    } catch {
      // A lost response keeps the same request: trying again cannot spend twice.
      setSubmitError(unsure);
      setUnconfirmed(true);
    } finally {
      setSubmitting(false);
    }
  };

  const makeMeme = (p: MemberPictureState) => {
    if (!p.aiImageId || !p.imageUrl) return;
    writePictureHandoff({
      factId,
      aiImageId: p.aiImageId,
      imageUrl: p.imageUrl,
      aspectRatio: p.aspectRatio ?? shape,
      // The caption the picture was made for, read from its own state; an
      // older picture has none, and the builder's caption stays as it is.
      caption: p.caption
        ? { name: p.caption.name, pronouns: p.caption.pronouns, chosen: !!chosenCaption && chosenCaption.name.trim() === p.caption.name }
        : null,
    });
    onOpenBuilder();
  };

  const makeAnother = () => {
    // The choices stay; the cost and the balance are read again.
    setActiveId(null);
    setSubmitError(null);
    pending.current = null;
    setUnconfirmed(false);
    void queryClient.invalidateQueries({ queryKey: pictureKeys.options(factId) });
  };

  const loadFailed = options.isError || looks.isError;

  return (
    <>
      <p className="font-display text-xl leading-snug" data-testid="ai-picture-fact"><HighlightedFactText template={factText} name={drawnName} pronouns={drawn.pronouns} /></p>

      {otherRows.map((p) => (
        <div key={p.attemptId} className="flex items-center justify-between rounded-md border border-white/10 px-3 py-2 text-sm" data-testid="ai-picture-other-drawing">
          <span role="status">{STATUS_WORDS[p.status]}</span>
          <button type="button" className="text-xs underline" onClick={() => setActiveId(p.attemptId)}>Show</button>
        </div>
      ))}

      {picture && (
        <section className="space-y-3 rounded-md border border-white/10 p-4" role="status" aria-live="polite" data-testid="ai-picture-status">
          <p className="text-sm">{STATUS_WORDS[picture.status]}</p>
          {picture.status === "failed" && (
            <p className="text-sm text-muted-foreground">
              {picture.reason}
              {picture.creditReturned ? " Your credit was returned." : " Your credit will be returned shortly."}
            </p>
          )}
          {picture.status === "done" && picture.imageUrl && (
            <img src={picture.imageUrl} alt="Your AI picture" className="max-h-80 rounded object-contain" />
          )}
          {picture.status === "done" && !picture.imageUrl && (
            <p className="text-sm text-muted-foreground">This picture was deleted, so there is nothing to show.</p>
          )}
          {!isInFlight(picture) && (
            <div className="flex flex-wrap gap-2">
              {picture.status === "done" && picture.imageUrl && (
                <button type="button" onClick={() => makeMeme(picture)} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" data-testid="ai-picture-make-meme">
                  Make a meme with it
                </button>
              )}
              <button type="button" onClick={makeAnother} className="rounded-md border border-white/20 px-4 py-2 text-sm" data-testid="ai-picture-make-another">
                Make another
              </button>
            </div>
          )}
          {picture.status === "done" && picture.imageUrl && <p className="text-xs text-muted-foreground">It's also in My content.</p>}
        </section>
      )}

      {!picture && (
        <>
          <section className="space-y-2">
            <h2 className="text-sm font-medium">Your photo</h2>
            <p className="text-xs text-muted-foreground">A photo of you or your pet. The picture stars whoever is in it.</p>
            <MyImagePicker selected={photo} onSelect={setPhoto} onAutoSelect={setPhoto} />
            <div aria-live="polite" data-testid="ai-picture-photo-check">
              {uploadKey && photoCheck.isPending && <p className="text-sm text-muted-foreground">Checking your photo…</p>}
              {subject === "person" && <p className="text-sm text-muted-foreground">A picture of you.</p>}
              {subject === "pet" && <p className="text-sm text-muted-foreground">A picture of your pet.</p>}
              {photoUnusable && <p role="alert" className="text-sm text-destructive">{photoUnusable}</p>}
              {photoCheck.isError && !photoUnusable && (
                <p role="alert" className="text-sm text-destructive">
                  We couldn't check this photo — try again.{" "}
                  <button type="button" className="underline" onClick={() => void photoCheck.refetch()}>Try again</button>
                </p>
              )}
            </div>
            {isPet && (
              <>
              <p className="text-xs text-muted-foreground">Your pet's name and pronouns, for the picture:</p>
              <div className="flex gap-2">
                <input
                  value={petName}
                  onChange={(e) => setPetName(e.target.value)}
                  maxLength={40}
                  placeholder="Your pet's name"
                  aria-label="Your pet's name"
                  className="min-w-0 flex-1 rounded-md border border-white/20 bg-transparent px-3 py-2 text-sm"
                  data-testid="ai-picture-pet-name"
                />
                <select
                  value={petPronouns}
                  onChange={(e) => setPetPronouns(e.target.value)}
                  aria-label="Your pet's pronouns"
                  className="rounded-md border border-white/20 bg-secondary px-2 py-2 text-sm"
                >
                  {PRONOUN_PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              </>
            )}
          </section>

          {loadFailed && (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="ai-picture-load-error">
              We couldn't load this fact's picture choices.{" "}
              <button type="button" className="underline" onClick={retryLoad} data-testid="ai-picture-retry">Try again</button>
            </div>
          )}
          {options.isPending && <p className="text-sm text-muted-foreground">Loading this fact's pictures…</p>}

          {gags && gags.length === 0 && <p className="text-sm text-muted-foreground">This fact has no picture to draw yet.</p>}
          {gags && gags.length > 0 && (
            <GagOptions gags={gags} selectedGagId={gagId} onSelect={setGagId} subjectName={drawnName} subjectPronouns={drawn.pronouns} />
          )}

          {looks.data && <StylePicker looks={looks.data} value={lookStyleId} onChange={setLookStyleId} />}

          <section className="space-y-2">
            <h2 className="text-sm font-medium">Shape</h2>
            <AspectRatioToggle value={shape} onChange={setShape} />
            <p className="text-xs text-muted-foreground">Your meme uses this shape. You can change it in the builder, but the picture will be cropped to fit.</p>
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">Name on the meme</h2>
            <div className="flex gap-2">
              <input
                value={caption.name}
                onChange={(e) => setChosenCaption({ name: e.target.value, pronouns: caption.pronouns })}
                maxLength={40}
                aria-label="Name on the meme"
                className="min-w-0 flex-1 rounded-md border border-white/20 bg-transparent px-3 py-2 text-sm"
                data-testid="ai-picture-caption-name"
              />
              <select
                value={simplePronouns(caption.pronouns) ?? caption.pronouns}
                onChange={(e) => setChosenCaption({ name: caption.name, pronouns: e.target.value })}
                aria-label="Pronouns on the meme"
                className="rounded-md border border-white/20 bg-secondary px-2 py-2 text-sm"
                data-testid="ai-picture-caption-pronouns"
              >
                {!PRONOUN_PRESETS.includes(caption.pronouns as typeof PRONOUN_PRESETS[number]) && <option value={caption.pronouns}>{caption.pronouns}</option>}
                {PRONOUN_PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <p className="text-xs text-muted-foreground">Making this for a friend? Put their name here. The picture still stars you or your pet.</p>
          </section>

          <section className="space-y-2">
            <p className="text-sm" data-testid="ai-picture-cost">
              {options.data ? (
                <>Costs {cost}. {canAfford ? `${credits - 1} ${credits - 1 === 1 ? "credit" : "credits"} left after.` : ""}</>
              ) : null}
            </p>
            {submitError && <p role="alert" className="text-sm text-destructive">{submitError}</p>}
            <PausedWhenReadOnly className="w-full">
              <button
                type="button"
                onClick={() => void makeIt()}
                disabled={(!!blocker && !unconfirmed) || submitting}
                className="w-full rounded-md bg-primary px-4 py-3 text-sm font-bold uppercase tracking-wider text-primary-foreground disabled:opacity-50"
                data-testid="ai-picture-confirm"
              >
                {submitting ? "Starting…" : unconfirmed ? "Try again" : "Make it"}
              </button>
            </PausedWhenReadOnly>
            {blocker && !unconfirmed && <p className="text-xs text-muted-foreground" data-testid="ai-picture-blocker">{blocker}</p>}
          </section>
        </>
      )}
    </>
  );
}
