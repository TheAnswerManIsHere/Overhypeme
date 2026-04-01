import { useState, useRef, useCallback, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/Button";
import { PronounEditor } from "@/components/ui/PronounEditor";
import { isCustomPronouns, parseCustom, displayPronouns, DEFAULT_PRONOUNS } from "@/lib/pronouns";
import { Loader2, Copy, Check, Mail, ArrowRight, Send } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ── AI suggestion (mirrors NameTag logic) ───────────────────────────────────

async function fetchSuggestedPronouns(name: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch("/api/ai/suggest-pronouns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal,
    });
    if (!res.ok) return null;
    const data = await res.json() as { subject?: string; object?: string };
    if (typeof data.subject === "string" && typeof data.object === "string") {
      const preset = `${data.subject}/${data.object}`;
      return preset;
    }
    return null;
  } catch {
    return null;
  }
}

function canApply(draftPronouns: string): boolean {
  if (!isCustomPronouns(draftPronouns)) return true;
  const p = parseCustom(draftPronouns);
  if (!p) return false;
  return !!(p.subj.trim() && p.obj.trim() && p.poss.trim() && p.possPro.trim() && p.refl.trim());
}

// ── URL builder ─────────────────────────────────────────────────────────────

function buildShareUrl(name: string, pronouns: string): string {
  const base = `${window.location.origin}${import.meta.env.BASE_URL}`.replace(/\/+$/, "");
  const params = new URLSearchParams({ displayName: name, pronouns });
  return `${base}/?${params.toString()}`;
}

// ── Social share helpers ─────────────────────────────────────────────────────

const SHARE_TEXT = (name: string) =>
  `Someone thinks ${name || "you"}'re legendary. See your personalized facts on Overhype.me →`;

function openPopup(url: string) {
  window.open(url, "_blank", "width=600,height=480,noopener,noreferrer");
}

function shareTwitter(shareUrl: string, name: string) {
  openPopup(`https://twitter.com/intent/tweet?text=${encodeURIComponent(SHARE_TEXT(name))}&url=${encodeURIComponent(shareUrl)}`);
}

function shareFacebook(shareUrl: string) {
  openPopup(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`);
}

function shareWhatsApp(shareUrl: string, name: string) {
  openPopup(`https://wa.me/?text=${encodeURIComponent(`${SHARE_TEXT(name)} ${shareUrl}`)}`);
}

function shareLinkedIn(shareUrl: string) {
  openPopup(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`);
}

function shareTelegram(shareUrl: string, name: string) {
  openPopup(`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(SHARE_TEXT(name))}`);
}

// ── Inline SVG brand icons ────────────────────────────────────────────────────

function IconX() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
    </svg>
  );
}

function IconFacebook() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden="true">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
    </svg>
  );
}

function IconWhatsApp() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

function IconLinkedIn() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden="true">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

function IconTelegram() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden="true">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

interface ShareModalProps {
  open: boolean;
  onClose: () => void;
}

type Step = "identity" | "share";

export function ShareModal({ open, onClose }: ShareModalProps) {
  const [step, setStep] = useState<Step>("identity");
  const [recipientName, setRecipientName] = useState("");
  const [recipientPronouns, setRecipientPronouns] = useState(DEFAULT_PRONOUNS);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const { toast } = useToast();

  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const isEmailValid = recipientEmail.trim().length > 0 && EMAIL_REGEX.test(recipientEmail.trim());

  const userChosenRef = useRef(false);
  const hasOverriddenRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const applyEnabled = canApply(recipientPronouns) && recipientName.trim().length > 0;
  const shareUrl = buildShareUrl(recipientName.trim(), recipientPronouns);
  const displayPron = displayPronouns(recipientPronouns);

  // Reset state on open
  useEffect(() => {
    if (open) {
      setStep("identity");
      setRecipientName("");
      setRecipientPronouns(DEFAULT_PRONOUNS);
      setRecipientEmail("");
      setEmailError("");
      setAiLoading(false);
      setSending(false);
      setCopied(false);
      setEmailSent(false);
      userChosenRef.current = false;
      hasOverriddenRef.current = false;
    } else {
      debounceTimerRef.current && clearTimeout(debounceTimerRef.current);
      abortControllerRef.current?.abort();
    }
  }, [open]);

  // Focus name input when identity step shows
  useEffect(() => {
    if (open && step === "identity") {
      setTimeout(() => nameInputRef.current?.focus(), 100);
    }
  }, [open, step]);

  // Cleanup on unmount
  useEffect(() => () => {
    debounceTimerRef.current && clearTimeout(debounceTimerRef.current);
    abortControllerRef.current?.abort();
  }, []);

  const triggerSuggestion = useCallback((nameValue: string) => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    if (!nameValue.trim()) {
      abortControllerRef.current?.abort();
      setAiLoading(false);
      return;
    }
    debounceTimerRef.current = setTimeout(async () => {
      if (userChosenRef.current) return;
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setAiLoading(true);
      const suggestion = await fetchSuggestedPronouns(nameValue.trim(), controller.signal);
      if (controller.signal.aborted) return;
      setAiLoading(false);
      if (suggestion && !userChosenRef.current) {
        setRecipientPronouns(suggestion);
      }
    }, 450);
  }, []);

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setRecipientName(val);
    hasOverriddenRef.current = false;
    triggerSuggestion(val);
  }

  function handlePronounsChange(val: string) {
    userChosenRef.current = true;
    hasOverriddenRef.current = true;
    debounceTimerRef.current && clearTimeout(debounceTimerRef.current);
    abortControllerRef.current?.abort();
    setAiLoading(false);
    setRecipientPronouns(val);
  }

  function handleNext() {
    if (!applyEnabled) return;
    debounceTimerRef.current && clearTimeout(debounceTimerRef.current);
    abortControllerRef.current?.abort();
    setAiLoading(false);
    setStep("share");
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast({ title: "Copy failed", description: "Please copy the link manually.", variant: "destructive" });
    }
  }

  function handleEmailChange(e: React.ChangeEvent<HTMLInputElement>) {
    setRecipientEmail(e.target.value);
    if (emailError) setEmailError(""); // clear error while they're typing
  }

  function handleEmailBlur() {
    const val = recipientEmail.trim();
    if (!val) { setEmailError(""); return; }
    if (!EMAIL_REGEX.test(val)) {
      setEmailError("That doesn't look like a valid email address — please double-check it.");
    } else {
      setEmailError("");
    }
  }

  async function handleSendEmail() {
    if (!isEmailValid || sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/share/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipientEmail: recipientEmail.trim(),
          recipientName: recipientName.trim(),
          shareUrl,
        }),
      });
      if (res.ok) {
        setEmailSent(true);
        setRecipientEmail("");
        toast({ title: "Invite sent!", description: `Email sent to ${recipientEmail.trim()}` });
      } else {
        const err = await res.json() as { error?: string };
        toast({ title: "Failed to send", description: err.error ?? "Please try again.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Network error", description: "Please try again.", variant: "destructive" });
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md bg-background border-border max-h-[90vh] overflow-y-auto">
        {step === "identity" ? (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2 mb-1">
                <div className="w-1 h-6 bg-primary rounded-full" />
                <DialogTitle className="font-display text-xl font-bold uppercase tracking-wider text-foreground">
                  Who are you sharing with?
                </DialogTitle>
              </div>
              <p className="text-sm text-muted-foreground pl-3">
                We'll personalise the facts for them before you share.
              </p>
            </DialogHeader>

            <div className="space-y-4 py-2">
              {/* Name field */}
              <div>
                <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1.5">
                  Their Name
                </label>
                <div className="flex items-center gap-2">
                  <input
                    ref={nameInputRef}
                    value={recipientName}
                    onChange={handleNameChange}
                    onKeyDown={(e) => e.key === "Enter" && applyEnabled && handleNext()}
                    placeholder="e.g. Alex, Sam, Jordan…"
                    className="flex-1 bg-secondary border border-border rounded-sm px-3 py-2 text-sm font-bold text-foreground outline-none focus:border-primary transition-colors placeholder:text-muted-foreground placeholder:font-normal"
                  />
                  {aiLoading && (
                    <Loader2 className="w-4 h-4 text-muted-foreground animate-spin shrink-0" />
                  )}
                </div>
              </div>

              {/* Pronouns */}
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider">
                    Their Pronouns
                  </label>
                  {aiLoading && (
                    <span className="text-[10px] text-muted-foreground italic">suggesting…</span>
                  )}
                </div>
                <PronounEditor value={recipientPronouns} onChange={handlePronounsChange} />
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                className="flex-1 gap-2 font-bold uppercase tracking-wider"
                disabled={!applyEnabled}
                onClick={handleNext}
              >
                Next <ArrowRight className="w-4 h-4" />
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2 mb-1">
                <div className="w-1 h-6 bg-primary rounded-full" />
                <DialogTitle className="font-display text-xl font-bold uppercase tracking-wider text-foreground">
                  Share with {recipientName}
                </DialogTitle>
              </div>
              <p className="text-sm text-muted-foreground pl-3">
                Personalised for <strong className="text-foreground">{recipientName}</strong>{displayPron ? ` (${displayPron})` : ""}. Their name loads automatically when they open the link.
              </p>
            </DialogHeader>

            <div className="space-y-5 py-1">

              {/* ── Copy link ─────────────────────────────────────── */}
              <div className="rounded-sm border border-border bg-secondary p-4">
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3">Copy Link</p>
                <button
                  onClick={handleCopyLink}
                  className="w-full flex items-center justify-between gap-3 group"
                >
                  <span className={`text-sm font-medium underline underline-offset-2 decoration-primary transition-colors ${copied ? "text-green-500 decoration-green-500" : "text-primary group-hover:text-primary/80"}`}>
                    Overhype.me
                  </span>
                  <span className={`flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider transition-colors shrink-0 ${copied ? "text-green-500" : "text-muted-foreground group-hover:text-foreground"}`}>
                    {copied ? <><Check className="w-3.5 h-3.5" /> Copied!</> : <><Copy className="w-3.5 h-3.5" /> Copy link</>}
                  </span>
                </button>
              </div>

              {/* ── Share on social ───────────────────────────────── */}
              <div className="rounded-sm border border-border bg-secondary p-4">
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3">Share On</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => shareTwitter(shareUrl, recipientName)}
                    className="flex items-center gap-2 px-3 py-2 rounded-sm border border-border bg-background hover:bg-[#1d9bf0]/10 hover:border-[#1d9bf0] hover:text-[#1d9bf0] text-muted-foreground text-xs font-bold transition-all"
                  >
                    <IconX /> X / Twitter
                  </button>
                  <button
                    onClick={() => shareWhatsApp(shareUrl, recipientName)}
                    className="flex items-center gap-2 px-3 py-2 rounded-sm border border-border bg-background hover:bg-[#25d366]/10 hover:border-[#25d366] hover:text-[#25d366] text-muted-foreground text-xs font-bold transition-all"
                  >
                    <IconWhatsApp /> WhatsApp
                  </button>
                  <button
                    onClick={() => shareFacebook(shareUrl)}
                    className="flex items-center gap-2 px-3 py-2 rounded-sm border border-border bg-background hover:bg-[#1877f2]/10 hover:border-[#1877f2] hover:text-[#1877f2] text-muted-foreground text-xs font-bold transition-all"
                  >
                    <IconFacebook /> Facebook
                  </button>
                  <button
                    onClick={() => shareLinkedIn(shareUrl)}
                    className="flex items-center gap-2 px-3 py-2 rounded-sm border border-border bg-background hover:bg-[#0a66c2]/10 hover:border-[#0a66c2] hover:text-[#0a66c2] text-muted-foreground text-xs font-bold transition-all"
                  >
                    <IconLinkedIn /> LinkedIn
                  </button>
                  <button
                    onClick={() => shareTelegram(shareUrl, recipientName)}
                    className="flex items-center gap-2 px-3 py-2 rounded-sm border border-border bg-background hover:bg-[#0088cc]/10 hover:border-[#0088cc] hover:text-[#0088cc] text-muted-foreground text-xs font-bold transition-all col-span-2"
                  >
                    <IconTelegram /> Telegram
                  </button>
                </div>
              </div>

              {/* ── Send via email ────────────────────────────────── */}
              <div className="rounded-sm border border-border bg-secondary p-4">
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5" /> Send via Email
                </p>
                {emailSent ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-green-500 text-sm font-medium">
                      <Check className="w-4 h-4 shrink-0" /> Invite sent!
                    </span>
                    <button
                      onClick={() => setEmailSent(false)}
                      className="text-xs text-muted-foreground hover:text-foreground underline transition-colors"
                    >
                      Send another
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <input
                      type="email"
                      value={recipientEmail}
                      onChange={handleEmailChange}
                      onBlur={handleEmailBlur}
                      onKeyDown={(e) => e.key === "Enter" && isEmailValid && !sending && handleSendEmail()}
                      placeholder={`${recipientName.toLowerCase().split(" ")[0] ?? "friend"}@example.com`}
                      className={`w-full bg-background border rounded-sm px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground ${
                        emailError ? "border-destructive focus:border-destructive" : "border-border focus:border-primary"
                      }`}
                    />
                    {emailError && (
                      <p className="text-xs text-destructive leading-snug">{emailError}</p>
                    )}
                    <Button
                      variant="primary"
                      className="w-full gap-2"
                      onClick={handleSendEmail}
                      disabled={!isEmailValid || sending}
                      isLoading={sending}
                    >
                      <Send className="w-3.5 h-3.5" />
                      Send Invite
                    </Button>
                  </div>
                )}
              </div>

            </div>

            <div className="flex items-center justify-between pt-1">
              <button
                onClick={() => setStep("identity")}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                ← Change name / pronouns
              </button>
              <Button variant="secondary" size="sm" onClick={onClose}>Done</Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
