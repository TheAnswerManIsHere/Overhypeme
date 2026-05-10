import { useState, useRef, useEffect, Suspense } from "react";
import { Link, useLocation } from "wouter";
import { motion } from "framer-motion";
import { format } from "date-fns";
import { Flame, Loader2, CheckCircle2, Crown, User as UserIcon } from "lucide-react";
import { FactSummary, useListComments, getListCommentsQueryKey } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-mutations";
import { useAuth } from "@workspace/replit-auth-web";
import { useToast } from "@/hooks/use-toast";
import { CommentHeartButton } from "@/components/comments/CommentHeartButton";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { AccessGate } from "@/components/AccessGate";
import { lazyWithRetry } from "@/lib/lazy-retry";

const HCaptcha = lazyWithRetry(() => import("@hcaptcha/react-hcaptcha"));
const HCAPTCHA_SITE_KEY =
  import.meta.env.VITE_HCAPTCHA_SITE_KEY || "10000000-ffff-ffff-ffff-000000000001";

type FormState = "idle" | "submitting" | "error";

interface OptimisticComment {
  id: number;
  text: string;
  authorName: string;
  pending: true;
}

interface Props {
  fact: FactSummary;
  /**
   * `feed` renders the compact inline variant used on FactCard expansion
   * and on the hero (3-comment limit, "View all" link, optimistic adds,
   * footer CTAs to make a meme / open the fact page).
   *
   * `detail` renders the full-page variant used on FactDetail (50-comment
   * limit, no "View all" link, full comment cards, no footer CTAs because
   * the page has its own primary CTA).
   */
  variant: "feed" | "detail";

  /** Feed variant only — drives the focused-name decoration on the
      composer avatar and is forwarded to the success-state copy. */
  name?: string;

  /** Feed variant only — draft text persisted by the parent (so the
      draft survives card collapse/expand). */
  draft?: string;
  onDraftChange?: (text: string) => void;

  /** Feed variant only — bumps the parent's local commentCount delta
      before the server count refreshes. */
  onCommentSubmit?: () => void;
  onCommentError?: () => void;
}

const FEED_LIMIT = 3;
const DETAIL_LIMIT = 50;

export function FactComments({
  fact,
  variant,
  name,
  draft = "",
  onDraftChange,
  onCommentSubmit,
  onCommentError,
}: Props) {
  const [, setLocation] = useLocation();
  const { isAuthenticated, role, user } = useAuth();
  const { addComment } = useAppMutations();
  const { toast } = useToast();

  const isLegendary = role === "legendary" || role === "admin";
  const needsCaptcha = isAuthenticated && !isLegendary;

  const limit = variant === "feed" ? FEED_LIMIT : DETAIL_LIMIT;
  const [commentSort, setCommentSort] = useState<"top" | "new">("top");
  const queryParams = { limit, sort: commentSort } as const;
  const { data: commentsData, isLoading } = useListComments(
    fact.id,
    queryParams,
    { query: { queryKey: getListCommentsQueryKey(fact.id, queryParams) } },
  );
  const comments = commentsData?.comments ?? [];

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const captchaRef = useRef<unknown>(null);

  const [formState, setFormState] = useState<FormState>("idle");
  const [text, setText] = useState(draft);
  const [captchaToken, setCaptchaToken] = useState("");
  const [optimisticComments, setOptimisticComments] = useState<OptimisticComment[]>([]);
  const [submitted, setSubmitted] = useState(false);

  const canSubmit =
    text.trim().length > 0 &&
    (!needsCaptcha || !!captchaToken) &&
    (formState === "idle" || formState === "error");

  // Auto-focus the composer only on the feed variant — autofocus inside a
  // page-long article would steal scroll position.
  useEffect(() => {
    if (variant !== "feed") return;
    const id = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [variant]);

  function resetCaptcha() {
    const ref = captchaRef.current as { resetCaptcha?: () => void } | null;
    ref?.resetCaptcha?.();
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAuthenticated) { setLocation(`/login?from=/facts/${fact.id}`); return; }
    const trimmedText = text.trim();
    if (!trimmedText || formState === "submitting") return;

    if (variant === "feed") {
      const optimisticId = Date.now();
      setOptimisticComments((prev) => [{
        id: optimisticId,
        text: trimmedText,
        authorName: user?.displayName ?? user?.firstName ?? name ?? "You",
        pending: true,
      }, ...prev]);
      setFormState("submitting");
      setText("");
      onDraftChange?.("");
      setCaptchaToken("");
      onCommentSubmit?.();

      addComment.mutate(
        { factId: fact.id, data: { text: trimmedText, captchaToken } },
        {
          onSuccess: () => {
            setOptimisticComments((prev) => prev.filter((c) => c.id !== optimisticId));
            setFormState("idle");
            onDraftChange?.("");
            setSubmitted(true);
            resetCaptcha();
          },
          onError: () => {
            setOptimisticComments((prev) => prev.filter((c) => c.id !== optimisticId));
            setText(trimmedText);
            resetCaptcha();
            onCommentError?.();
            toast({ title: "Failed to post comment", description: "Please try again.", variant: "destructive", duration: 4000 });
            setFormState("error");
          },
        },
      );
      return;
    }

    // Detail variant: simpler — no optimistic insert, no draft persistence.
    setFormState("submitting");
    addComment.mutate(
      { factId: fact.id, data: { text: trimmedText, captchaToken } },
      {
        onSuccess: () => {
          setText("");
          setCaptchaToken("");
          setFormState("idle");
          setSubmitted(true);
          resetCaptcha();
        },
        onError: () => {
          resetCaptcha();
          toast({ title: "Failed to post comment", description: "Please try again.", variant: "destructive", duration: 4000 });
          setFormState("error");
        },
      },
    );
  };

  // ── Sub-renders ────────────────────────────────────────────────────────────

  const avatarInitial = (str: string | null | undefined) => (str?.[0] ?? "?").toUpperCase();
  const myInitial = name ? name[0].toUpperCase() : avatarInitial(user?.displayName ?? user?.firstName);

  function renderFeedRow(c: OptimisticComment | (typeof comments)[number]) {
    const isPending = "pending" in c && c.pending;
    return (
      <div key={c.id} className="flex gap-2.5">
        <div className="w-7 h-7 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0 text-xs font-bold font-display text-primary">
          {avatarInitial(c.authorName)}
        </div>
        <div className="flex-1 pt-1.5">
          <p className="text-xs text-muted-foreground leading-relaxed">
            <span className="text-foreground font-semibold">{c.authorName ?? "Anonymous"}</span>{" "}
            {c.text}
          </p>
          {isPending && (
            <p className="text-[10px] text-muted-foreground/50 mt-0.5 italic">awaiting moderation</p>
          )}
          {!isPending && "heartCount" in c && (
            <div className="mt-1">
              <CommentHeartButton
                commentId={c.id}
                initialHeartCount={c.heartCount}
                initialViewerHasHearted={c.viewerHasHearted}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderDetailRow(c: (typeof comments)[number]) {
    return (
      <div key={c.id} className="bg-card p-5 border-l-4 border-muted rounded-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            {c.authorImage ? (
              <img src={c.authorImage} alt="Avatar" className="w-8 h-8 rounded-sm" />
            ) : (
              <div className="w-8 h-8 bg-muted flex items-center justify-center rounded-sm">
                <UserIcon className="w-4 h-4 text-muted-foreground" />
              </div>
            )}
            <span className="font-bold text-primary">{c.authorName || "ANONYMOUS"}</span>
          </div>
          <span className="text-xs text-muted-foreground font-medium">{format(new Date(c.createdAt), "MMM dd, yyyy")}</span>
        </div>
        <p className="text-foreground leading-relaxed">{c.text}</p>
        <div className="mt-3 flex items-center">
          <CommentHeartButton
            commentId={c.id}
            initialHeartCount={c.heartCount}
            initialViewerHasHearted={c.viewerHasHearted}
          />
        </div>
      </div>
    );
  }

  // ── Composer (variant-specific styling, shared logic) ──────────────────────

  function renderFeedComposer() {
    if (submitted) {
      return (
        <div className="mb-4 flex items-start gap-2.5 rounded-xl bg-primary/10 border border-primary/20 px-4 py-3">
          <CheckCircle2 className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
          <p className="text-xs text-foreground leading-relaxed">
            Thanks for submitting your comment. Once it has been proven worthy by our review team, it will appear here.
          </p>
        </div>
      );
    }
    if (!isAuthenticated) {
      return (
        <div className="mb-4 text-center py-2">
          <Link href={`/login?from=/facts/${fact.id}`} className="text-xs font-semibold text-primary hover:underline">
            Sign in to comment
          </Link>
        </div>
      );
    }
    return (
      <form onSubmit={handleSubmit} className="space-y-2 mb-4">
        <div className="flex gap-2.5">
          <div className="w-7 h-7 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0 text-xs font-bold font-display text-primary mt-1">
            {myInitial}
          </div>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => { setText(e.target.value); onDraftChange?.(e.target.value); }}
            disabled={formState === "submitting"}
            placeholder="Add a comment…"
            rows={2}
            className="flex-1 px-3.5 py-2 bg-secondary border border-border rounded-xl text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:border-primary/60 transition-colors disabled:opacity-50"
          />
        </div>
        {needsCaptcha && (
          <div className="pl-9">
            <Suspense fallback={<div className="w-[164px] h-[144px] bg-muted animate-pulse rounded-sm" />}>
              <HCaptcha
                ref={captchaRef as never}
                sitekey={HCAPTCHA_SITE_KEY}
                theme="dark"
                size="compact"
                onVerify={setCaptchaToken}
                onExpire={() => setCaptchaToken("")}
              />
            </Suspense>
          </div>
        )}
        <div className="flex justify-end pl-9">
          <button
            type="submit"
            disabled={!canSubmit}
            className="px-4 py-1.5 bg-primary text-white rounded-full text-xs font-display font-bold uppercase tracking-widest hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {formState === "submitting" ? "Posting…" : "Post"}
          </button>
        </div>
      </form>
    );
  }

  function renderDetailComposer() {
    if (!isAuthenticated) {
      return (
        <AccessGate
          reason="login"
          size="sm"
          description="Sign in to comment."
          returnTo={`/facts/${fact.id}`}
        />
      );
    }
    if (submitted) {
      return (
        <div className="bg-secondary p-6 rounded-sm border-2 border-border text-center space-y-3">
          <p className="font-display font-bold text-foreground uppercase tracking-wide">Comment Received</p>
          <p className="text-sm text-muted-foreground">Your comment is pending review and will appear once approved.</p>
          <Button variant="outline" size="sm" onClick={() => setSubmitted(false)}>Submit Another</Button>
        </div>
      );
    }
    return (
      <form onSubmit={handleSubmit} className="bg-secondary p-6 rounded-sm border-2 border-border space-y-4">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Smack some knowledge on us..."
          className="bg-background min-h-[100px]"
          disabled={formState === "submitting"}
        />
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
          {isLegendary ? (
            <div className="flex items-center gap-2 text-yellow-500 text-sm font-display font-bold uppercase tracking-wider">
              <Crown className="w-4 h-4" /> Captcha skipped (Legendary)
            </div>
          ) : (
            <div className="overflow-hidden rounded-sm border-2 border-border">
              <Suspense fallback={<div className="w-[303px] h-[78px] bg-muted animate-pulse rounded-sm" />}>
                <HCaptcha
                  ref={captchaRef as never}
                  sitekey={HCAPTCHA_SITE_KEY}
                  onVerify={setCaptchaToken}
                />
              </Suspense>
            </div>
          )}
          <Button type="submit" isLoading={formState === "submitting"} disabled={!canSubmit} className="w-full sm:w-auto">
            POST COMMENT
          </Button>
        </div>
      </form>
    );
  }

  // ── Layout ─────────────────────────────────────────────────────────────────

  if (variant === "feed") {
    const allFeed: Array<OptimisticComment | (typeof comments)[number]> = [
      ...optimisticComments,
      ...comments.slice(0, FEED_LIMIT),
    ];
    return (
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
      >
        <section
          id={`fact-${fact.id}-comments`}
          aria-label="Comments"
          className="mt-3 pt-4 border-t border-border/50"
        >
          {isLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading comments…
            </div>
          ) : allFeed.length > 0 ? (
            <div className="space-y-3 mb-3">
              {allFeed.map(renderFeedRow)}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground mb-3 italic">Be the first to comment.</p>
          )}

          <Link
            href={`/facts/${fact.id}#comments`}
            className="block text-xs font-semibold text-muted-foreground hover:text-primary transition-colors mb-4"
          >
            View all {fact.commentCount} comments →
          </Link>

          {renderFeedComposer()}

          <button
            onClick={() => setLocation(`/facts/${fact.id}/meme`)}
            className="w-full h-11 bg-primary text-white rounded-xl font-display font-bold text-sm tracking-widest uppercase flex items-center justify-center gap-2 hover:opacity-90 transition-opacity shadow-[0_4px_16px_rgba(255,101,0,0.25)]"
          >
            <Flame className="w-4 h-4" /> Make a meme of this
          </button>

          <Link
            href={`/facts/${fact.id}`}
            className="block w-full text-center text-xs text-muted-foreground hover:text-primary transition-colors mt-2 py-1 font-medium"
          >
            Open fact page
          </Link>
        </section>
      </motion.div>
    );
  }

  // Detail variant — full-page comments section.
  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between gap-4 border-b-2 border-border pb-2">
        <h3 id="comments" className="text-2xl font-display uppercase tracking-wide">
          Comments ({fact.commentCount})
        </h3>
        {comments.length > 1 && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground font-display tracking-wider uppercase">Sort</span>
            <select
              value={commentSort}
              onChange={(e) => setCommentSort(e.target.value as "top" | "new")}
              className="bg-secondary border border-border/80 rounded-full px-3 py-1.5 text-xs font-semibold text-foreground hover:border-primary/50 transition-colors focus:outline-none focus:border-primary"
              aria-label="Sort comments"
            >
              <option value="top">Top</option>
              <option value="new">Newest</option>
            </select>
          </div>
        )}
      </div>

      <div className="space-y-4">
        {comments.map(renderDetailRow)}
        {comments.length === 0 && (
          <p className="text-muted-foreground py-8 text-center border-2 border-dashed border-border rounded-sm">
            No comments yet.
          </p>
        )}
      </div>

      {renderDetailComposer()}
    </div>
  );
}
