import { useCallback, useEffect, useRef, useState } from "react";

/**
 * "Make an AI picture" (launch Phase 7, increment 2; plan
 * docs/plans/PLAN_PHASE7_IMAGE_OFFERING.md §2): from the photo chosen above,
 * draw the member or their pet into one of this fact's approved gags, for one
 * credit, then use the picture as the meme's background.
 *
 * Steps: who is in it (me, or my pet with its name) → the gag (a choice only
 * where the fact has more than one, each shown with its examples) → the look →
 * a confirmation naming the cost and the balance after. Then the picture's
 * progress, which survives leaving and coming back (docs/ai-context/async-ui-status.md):
 * queued, drawing, done (used as the background) or failed with the reason and
 * "your credit was returned".
 *
 * The server decides everything: the member sends ids, and the server checks
 * the photo, the gag, the credit and the spend limit.
 */

interface GagOption {
  gagId: number;
  slot: number;
  examples: { male: string | null; female: string | null; pet: string | null };
}

interface PictureOptions {
  gags: GagOption[];
  choice: boolean;
  credits: number;
  nextIsFree: boolean;
}

interface LookStyle {
  id: string;
  label: string;
  description: string;
}

export interface MemberPictureState {
  attemptId: number;
  factId: number;
  status: "queued" | "drawing" | "done" | "failed";
  reason: string | null;
  creditReturned: boolean;
  aiImageId: number | null;
  imageUrl: string | null;
  createdAt: string;
}

interface Props {
  factId: string;
  /** The member's own photo chosen above (`/objects/...`), or null. */
  photoUploadKey: string | null;
  /** Called with the finished picture, to use as the background. */
  onPicture: (picture: { aiImageId: number; imageUrl: string }) => void;
  /** The AI picture currently used as the background, if any. */
  selectedAiImageId: number | null;
}

type Subject = "me" | "pet";
const POLL_MS = 2500;
const PRONOUN_CHOICES = ["he/him", "she/her", "they/them"] as const;

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

const STATUS_WORDS: Record<MemberPictureState["status"], string> = {
  queued: "Waiting to start drawing…",
  drawing: "Drawing your picture… this usually takes under a minute.",
  done: "Your picture is ready.",
  failed: "This picture couldn't be made.",
};

export function AiPicturePanel({ factId, photoUploadKey, onPicture, selectedAiImageId }: Props) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<PictureOptions | null>(null);
  const [looks, setLooks] = useState<LookStyle[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [subject, setSubject] = useState<Subject>("me");
  const [petName, setPetName] = useState("");
  const [petPronouns, setPetPronouns] = useState<string>("they/them");
  const [gagId, setGagId] = useState<number | null>(null);
  const [lookStyleId, setLookStyleId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [picture, setPicture] = useState<MemberPictureState | null>(null);
  // One id per confirmation: a retried request is the same picture, never a second credit.
  const requestId = useRef<string | null>(null);
  const delivered = useRef<number | null>(null);

  // Coming back to the builder shows the latest picture of this fact still in flight.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/member-pictures", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { pictures: MemberPictureState[] } | null) => {
        if (cancelled || !body) return;
        const inFlight = body.pictures.find((p) => String(p.factId) === factId && (p.status === "queued" || p.status === "drawing"));
        if (inFlight) { setPicture(inFlight); setOpen(true); }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [factId]);

  // The options load when the panel opens.
  useEffect(() => {
    if (!open || options) return;
    let cancelled = false;
    Promise.all([
      fetch(`/api/facts/${encodeURIComponent(factId)}/picture-options`, { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error("options");
        return r.json() as Promise<PictureOptions>;
      }),
      fetch("/api/look-styles", { credentials: "include" }).then((r) => (r.ok ? (r.json() as Promise<LookStyle[]>) : [])),
    ])
      .then(([o, l]) => {
        if (cancelled) return;
        setOptions(o);
        setLooks(l);
        setGagId(o.gags[0]?.gagId ?? null);
      })
      .catch(() => { if (!cancelled) setLoadError("We couldn't load this fact's pictures. Try again in a moment."); });
    return () => { cancelled = true; };
  }, [open, options, factId]);

  // Follow a picture while it draws.
  const inFlight = picture && (picture.status === "queued" || picture.status === "drawing");
  useEffect(() => {
    if (!picture || !inFlight) return;
    const t = setTimeout(() => {
      void fetch(`/api/member-pictures/${picture.attemptId}`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { picture: MemberPictureState; credits: number } | null) => {
          if (!body) return;
          setPicture(body.picture);
          setOptions((o) => (o ? { ...o, credits: body.credits } : o));
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [picture, inFlight]);

  // A finished picture becomes the background, once.
  useEffect(() => {
    if (picture?.status === "done" && picture.aiImageId && picture.imageUrl && delivered.current !== picture.aiImageId) {
      delivered.current = picture.aiImageId;
      onPicture({ aiImageId: picture.aiImageId, imageUrl: picture.imageUrl });
    }
  }, [picture, onPicture]);

  const confirm = useCallback(async () => {
    if (!photoUploadKey || submitting) return;
    if (subject === "pet" && !petName.trim()) { setSubmitError("Give your pet's name, for the picture."); return; }
    setSubmitting(true);
    setSubmitError(null);
    requestId.current ??= newRequestId();
    try {
      const res = await fetch(`/api/facts/${encodeURIComponent(factId)}/member-pictures`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: requestId.current,
          gagId: options?.choice ? gagId : null,
          uploadKey: photoUploadKey,
          lookStyleId,
          subject: subject === "pet" ? { kind: "pet", name: petName.trim(), pronouns: petPronouns } : { kind: "me" },
          aspectRatio: "portrait",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A refusal is final for this confirmation: the next try is a new request.
        requestId.current = null;
        setSubmitError(body.message ?? "We couldn't start this picture. Try again.");
        return;
      }
      requestId.current = null;
      setPicture(body.picture as MemberPictureState);
      setOptions((o) => (o ? { ...o, credits: body.credits } : o));
    } catch {
      // A lost response keeps the same id: trying again cannot spend twice.
      setSubmitError("We lost the connection. Try again; you won't be charged twice.");
    } finally {
      setSubmitting(false);
    }
  }, [factId, gagId, lookStyleId, options, petName, petPronouns, photoUploadKey, subject, submitting]);

  const cost = options?.nextIsFree ? "your free picture" : "1 credit";
  const canAfford = (options?.credits ?? 0) >= 1;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-md border border-primary/40 bg-primary/10 px-4 py-3 text-left text-sm font-medium text-foreground hover:bg-primary/20"
        data-testid="ai-picture-open"
      >
        Make an AI picture of you in this fact
        <span className="block text-xs font-normal text-muted-foreground">From your photo, drawn into the joke. One credit.</span>
      </button>
    );
  }

  return (
    <section className="space-y-4 rounded-md border border-white/10 bg-secondary/30 p-4" aria-label="Make an AI picture" data-testid="ai-picture-panel">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-xl tracking-wide">Make an AI picture</h2>
        {options && (
          <span className="text-xs text-muted-foreground" data-testid="ai-picture-balance">
            {options.credits} {options.credits === 1 ? "credit" : "credits"}
          </span>
        )}
      </div>

      {picture && (
        <div className="space-y-2 rounded-md border border-white/10 p-3" role="status" aria-live="polite" data-testid="ai-picture-status">
          <p className="text-sm">{STATUS_WORDS[picture.status]}</p>
          {picture.status === "failed" && (
            <p className="text-sm text-muted-foreground">
              {picture.reason}
              {picture.creditReturned ? " Your credit was returned." : " Your credit will be returned shortly."}
            </p>
          )}
          {picture.status === "done" && picture.imageUrl && (
            <div className="flex items-center gap-3">
              <img src={picture.imageUrl} alt="Your AI picture" className="h-20 w-16 rounded object-cover" />
              {picture.aiImageId !== selectedAiImageId ? (
                <button
                  type="button"
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
                  onClick={() => picture.aiImageId && picture.imageUrl && onPicture({ aiImageId: picture.aiImageId, imageUrl: picture.imageUrl })}
                >
                  Use this picture
                </button>
              ) : (
                <span className="text-xs text-muted-foreground">Used as your background. It's also in My content.</span>
              )}
            </div>
          )}
          {picture.status === "done" && !picture.imageUrl && (
            <p className="text-sm text-muted-foreground">This picture was deleted, so there is nothing to show.</p>
          )}
          {(picture.status === "done" || picture.status === "failed") && (
            <button type="button" className="text-xs underline text-muted-foreground" onClick={() => setPicture(null)}>
              Make another
            </button>
          )}
        </div>
      )}

      {!picture && (
        <>
          {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
          {!photoUploadKey && <p className="text-sm text-muted-foreground">Choose a photo of you or your pet above first.</p>}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Who's in the picture?</legend>
            <div className="flex gap-2">
              {(["me", "pet"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={subject === s}
                  onClick={() => setSubject(s)}
                  className={`rounded-md border px-3 py-1.5 text-sm ${subject === s ? "border-primary bg-primary/15" : "border-white/15"}`}
                >
                  {s === "me" ? "Me" : "My pet"}
                </button>
              ))}
            </div>
            {subject === "pet" && (
              <div className="flex gap-2">
                <input
                  value={petName}
                  onChange={(e) => setPetName(e.target.value)}
                  maxLength={40}
                  placeholder="Your pet's name"
                  aria-label="Your pet's name"
                  className="min-w-0 flex-1 rounded-md border border-white/15 bg-transparent px-3 py-1.5 text-sm"
                />
                <select
                  value={petPronouns}
                  onChange={(e) => setPetPronouns(e.target.value)}
                  aria-label="Your pet's pronouns"
                  className="rounded-md border border-white/15 bg-transparent px-2 py-1.5 text-sm"
                >
                  {PRONOUN_CHOICES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            )}
            <p className="text-xs text-muted-foreground">Making this for a friend? Put their name in the caption. The picture still stars you or your pet.</p>
          </fieldset>

          {options && options.gags.length === 0 && (
            <p className="text-sm text-muted-foreground">This fact has no picture to draw yet.</p>
          )}
          {options && options.gags.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{options.choice ? "Pick the joke" : "The joke"}</legend>
              <div className="space-y-2">
                {options.gags.map((g, i) => {
                  const picked = gagId === g.gagId;
                  const shots = [g.examples.male, g.examples.female, g.examples.pet].filter((u): u is string => !!u);
                  return (
                    <button
                      key={g.gagId}
                      type="button"
                      disabled={!options.choice}
                      aria-pressed={picked}
                      onClick={() => setGagId(g.gagId)}
                      className={`flex w-full items-center gap-2 rounded-md border p-2 text-left ${picked ? "border-primary" : "border-white/15"}`}
                      data-testid="ai-picture-gag"
                    >
                      <span className="w-14 shrink-0 text-xs text-muted-foreground">{options.choice ? `Option ${i + 1}` : "Examples"}</span>
                      <span className="flex gap-1">
                        {shots.map((u) => <img key={u} src={u} alt="" className="h-14 w-11 rounded object-cover" loading="lazy" />)}
                        {shots.length === 0 && <span className="text-xs text-muted-foreground">No examples yet</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">The look</legend>
            <select
              value={lookStyleId ?? ""}
              onChange={(e) => setLookStyleId(e.target.value || null)}
              aria-label="The look"
              className="w-full rounded-md border border-white/15 bg-transparent px-2 py-1.5 text-sm"
            >
              <option value="">Photoreal</option>
              {looks.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          </fieldset>

          {submitError && <p role="alert" className="text-sm text-destructive">{submitError}</p>}

          {options && !canAfford && (
            <p className="text-sm text-muted-foreground">You have no credits left for a picture.</p>
          )}
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={!photoUploadKey || !options || options.gags.length === 0 || !canAfford || submitting}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            data-testid="ai-picture-confirm"
          >
            {submitting ? "Starting…" : `Make it: ${cost}`}
            {options && canAfford && (
              <span className="block text-xs font-normal opacity-80">
                {options.credits - 1} {options.credits - 1 === 1 ? "credit" : "credits"} left after
              </span>
            )}
          </button>
        </>
      )}
    </section>
  );
}
