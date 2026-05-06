import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { motion } from "framer-motion";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import { Flame, Loader2, CheckCircle2 } from "lucide-react";
import { FactSummary, useListComments, getListCommentsQueryKey } from "@workspace/api-client-react";
import { useAppMutations } from "@/hooks/use-mutations";
import { useAuth } from "@workspace/replit-auth-web";
import { useToast } from "@/hooks/use-toast";
import { CommentHeartButton } from "@/components/comments/CommentHeartButton";

const HCAPTCHA_SITE_KEY =
  import.meta.env.VITE_HCAPTCHA_SITE_KEY || "10000000-ffff-ffff-ffff-000000000001";

type FormState = "idle" | "submitting" | "error";

interface OptimisticComment {
  id: number;
  text: string;
  authorName: string;
  pending: true;
}

interface FactCardCommentsProps {
  fact: FactSummary;
  name: string;
  onCommentSubmit?: () => void;
  onCommentError?: () => void;
  draft?: string;
  onDraftChange?: (text: string) => void;
}

export function FactCardComments({ fact, name, onCommentSubmit, onCommentError, draft = "", onDraftChange }: FactCardCommentsProps) {
  const [, setLocation] = useLocation();
  const { isAuthenticated, role, user } = useAuth();
  const { addComment } = useAppMutations();
  const { toast } = useToast();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const captchaRef = useRef<HCaptcha>(null);

  const [formState, setFormState] = useState<FormState>("idle");
  const [text, setText] = useState(draft);
  const [captchaToken, setCaptchaToken] = useState("");
  const [optimisticComments, setOptimisticComments] = useState<OptimisticComment[]>([]);
  const [submitted, setSubmitted] = useState(false);

  const isLegendary = role === "legendary" || role === "admin";
  const needsCaptcha = isAuthenticated && !isLegendary;
  const canSubmit =
    text.trim().length > 0 &&
    (!needsCaptcha || !!captchaToken) &&
    (formState === "idle" || formState === "error");

  const { data: commentsData, isLoading } = useListComments(
    fact.id,
    { limit: 3 },
    { query: { queryKey: getListCommentsQueryKey(fact.id, { limit: 3 }) } }
  );

  const topComments = commentsData?.comments?.slice(0, 3) ?? [];

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedText = text.trim();
    if (!trimmedText || formState === "submitting") return;

    const optimisticId = Date.now();
    const optimisticEntry: OptimisticComment = {
      id: optimisticId,
      text: trimmedText,
      authorName: user?.displayName ?? user?.firstName ?? name ?? "You",
      pending: true,
    };

    setOptimisticComments((prev) => [optimisticEntry, ...prev]);
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
          captchaRef.current?.resetCaptcha();
        },
        onError: () => {
          setOptimisticComments((prev) => prev.filter((c) => c.id !== optimisticId));
          setText(trimmedText);
          captchaRef.current?.resetCaptcha();
          onCommentError?.();
          toast({
            title: "Failed to post comment",
            description: "Please try again.",
            variant: "destructive",
            duration: 4000,
          });
          setFormState("error");
        },
      }
    );
  };

  const allDisplayComments: Array<OptimisticComment | NonNullable<typeof topComments>[number]> = [
    ...optimisticComments,
    ...topComments,
  ];

  const avatarInitial = (str: string | null | undefined) =>
    (str?.[0] ?? "?").toUpperCase();

  const myInitial = name
    ? name[0].toUpperCase()
    : avatarInitial(user?.displayName ?? user?.firstName);

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
        {/* Comment list */}
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
            <Loader2 className="w-3 h-3 animate-spin" />
            Loading comments…
          </div>
        ) : allDisplayComments.length > 0 ? (
          <div className="space-y-3 mb-3">
            {allDisplayComments.map((c) => {
              const isPending = "pending" in c && c.pending;
              return (
                <div key={c.id} className="flex gap-2.5">
                  <div className="w-7 h-7 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0 text-xs font-bold font-display text-primary">
                    {avatarInitial(c.authorName)}
                  </div>
                  <div className="flex-1 pt-1.5">
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      <span className="text-foreground font-semibold">
                        {c.authorName ?? "Anonymous"}
                      </span>{" "}
                      {c.text}
                    </p>
                    {isPending && (
                      <p className="text-[10px] text-muted-foreground/50 mt-0.5 italic">
                        awaiting moderation
                      </p>
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
            })}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground mb-3 italic">
            Be the first to comment.
          </p>
        )}

        {/* View all link */}
        <Link
          href={`/facts/${fact.id}#comments`}
          className="block text-xs font-semibold text-muted-foreground hover:text-primary transition-colors mb-4"
        >
          View all {fact.commentCount} comments →
        </Link>

        {/* Submission confirmation */}
        {submitted ? (
          <div className="mb-4 flex items-start gap-2.5 rounded-xl bg-primary/10 border border-primary/20 px-4 py-3">
            <CheckCircle2 className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
            <p className="text-xs text-foreground leading-relaxed">
              Thanks for submitting your comment. Once it has been proven worthy by our review team, it will appear here.
            </p>
          </div>
        ) : isAuthenticated ? (
          /* Reply form */
          <form onSubmit={handleSubmit} className="space-y-2 mb-4">
            <div className="flex gap-2.5">
              <div className="w-7 h-7 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0 text-xs font-bold font-display text-primary mt-1">
                {myInitial}
              </div>
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  onDraftChange?.(e.target.value);
                }}
                disabled={formState === "submitting"}
                placeholder="Add a comment…"
                rows={2}
                className="flex-1 px-3.5 py-2 bg-secondary border border-border rounded-xl text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:border-primary/60 transition-colors disabled:opacity-50"
              />
            </div>
            {needsCaptcha && (
              <div className="pl-9">
                <HCaptcha
                  ref={captchaRef}
                  sitekey={HCAPTCHA_SITE_KEY}
                  theme="dark"
                  size="compact"
                  onVerify={setCaptchaToken}
                  onExpire={() => setCaptchaToken("")}
                />
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
        ) : (
          <div className="mb-4 text-center py-2">
            <Link
              href={`/login?from=/facts/${fact.id}`}
              className="text-xs font-semibold text-primary hover:underline"
            >
              Log in to comment
            </Link>
          </div>
        )}

        {/* Make a meme — primary action */}
        <button
          onClick={() => setLocation(`/facts/${fact.id}/meme`)}
          className="w-full h-11 bg-primary text-white rounded-xl font-display font-bold text-sm tracking-widest uppercase flex items-center justify-center gap-2 hover:opacity-90 transition-opacity shadow-[0_4px_16px_rgba(255,101,0,0.25)]"
        >
          <Flame className="w-4 h-4" />
          Make a meme of this
        </button>

        {/* Open fact page — secondary */}
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
