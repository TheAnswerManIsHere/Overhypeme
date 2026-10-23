/**
 * Phase-5 CTA bars — one variant per ViewerCell.
 *
 * Each variant is a pure presentation component that takes the page-level
 * actions as props. The page wires them up; the component knows nothing
 * about routing or auth state directly.
 *
 * Visual treatment matches the existing MemePage screenshots: dark cinematic
 * background, brand-orange accents, Bebas Neue display, JetBrains Mono
 * metadata. The structure is "primary card / secondary row / tertiary row"
 * for every variant so the visual rhythm reads consistently.
 */
import { ArrowRight, Crown, Download, Library, Share2, Upload } from "lucide-react";
import { Link } from "wouter";

/* ─── shared atoms ───────────────────────────────────────────────────────── */

function PrimaryButton({
  children,
  onClick,
  href,
  testId,
  disabled,
  type,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
  testId?: string;
  disabled?: boolean;
  type?: "submit" | "button";
}) {
  const base =
    "inline-flex items-center justify-center gap-2 h-[52px] px-5 rounded-[14px] bg-primary text-white font-display font-bold text-[13px] uppercase tracking-wider transition w-full";
  const cls = disabled
    ? `${base} opacity-50 cursor-not-allowed`
    : `${base} hover:brightness-110`;
  if (href && !disabled) {
    return (
      <Link href={href} data-testid={testId} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button
      type={type ?? "button"}
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
      data-testid={testId}
      className={cls}
    >
      {children}
    </button>
  );
}

function SecondaryButton({
  children,
  onClick,
  href,
  testId,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
  testId?: string;
  disabled?: boolean;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 h-[44px] px-4 rounded-[12px] bg-card border border-border text-foreground font-display font-bold text-[12px] uppercase tracking-wider transition w-full";
  const cls = disabled
    ? `${base} opacity-50 cursor-not-allowed`
    : `${base} hover:border-primary/60`;
  if (href && !disabled) {
    return (
      <Link href={href} data-testid={testId} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
      data-testid={testId}
      className={cls}
    >
      {children}
    </button>
  );
}

function TertiaryLink({
  children,
  href,
  testId,
}: {
  children: React.ReactNode;
  href: string;
  testId?: string;
}) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
    >
      {children}
    </Link>
  );
}

function TierLadderTeasers() {
  return (
    <div className="grid grid-cols-2 gap-2 mt-2">
      <Link
        href="/login"
        data-testid="tier-ladder-signup"
        className="flex items-center gap-2 p-3 rounded-[10px] bg-card border border-border hover:border-primary/40 transition"
      >
        <Upload className="w-4 h-4 text-muted-foreground" />
        <div className="text-left">
          <div className="font-display text-[10px] uppercase tracking-wider text-foreground">
            Free
          </div>
          <div className="text-[10px] text-muted-foreground leading-tight">
            Upload your photo
          </div>
        </div>
      </Link>
      <Link
        href="/pricing"
        data-testid="tier-ladder-legendary"
        className="flex items-center gap-2 p-3 rounded-[10px] bg-card border border-primary/40 hover:border-primary transition"
      >
        <Crown className="w-4 h-4 text-primary" />
        <div className="text-left">
          <div className="font-display text-[10px] uppercase tracking-wider text-primary">
            Legendary
          </div>
          <div className="text-[10px] text-muted-foreground leading-tight">
            Keep memes private
          </div>
        </div>
      </Link>
    </div>
  );
}

/* ─── anon-other ─────────────────────────────────────────────────────────── */

export function CTABarAnonOther({ onSignup }: { onSignup: () => void }) {
  // A signed-out visitor has no background to build on until launch Phase 7's
  // free hero renders (stock photos went with Pexels, Phase 4, removal 6), so
  // the card asks for the sign-up a meme needs rather than promising a preview
  // with their name. The name-and-pronoun form it replaced is at the tag
  // `pre-cut/stock-pexels`.
  return (
    <div className="space-y-4" data-testid="cta-anon-other">
      <div className="rounded-[16px] bg-card border border-primary/40 p-4 space-y-3">
        <p className="text-[11px] font-display font-bold tracking-[0.18em] text-primary uppercase">
          Make this meme about you
        </p>
        <p className="text-sm text-muted-foreground leading-snug">
          Sign up free to put your own photo and name behind this fact.
        </p>
        <PrimaryButton onClick={onSignup} testId="anon-signup-make">
          Sign up free <ArrowRight className="w-4 h-4" />
        </PrimaryButton>
      </div>
      <SecondaryButton href="/" testId="browse-more-facts">
        <Library className="w-4 h-4" /> Browse more facts
      </SecondaryButton>
      <TierLadderTeasers />
    </div>
  );
}

/* ─── own ──────────────────────────────────────────────────────────────── */

export function CTABarOwn({
  onDownload,
  onCustomShare,
}: {
  onDownload: () => void;
  onCustomShare: () => void;
}) {
  return (
    <div className="space-y-3" data-testid="cta-own">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <PrimaryButton onClick={onDownload} testId="own-download">
          <Download className="w-4 h-4" /> Download
        </PrimaryButton>
        <PrimaryButton onClick={onCustomShare} testId="own-custom-share">
          <Share2 className="w-4 h-4" /> Custom share
        </PrimaryButton>
      </div>
    </div>
  );
}

/* ─── registered-other ───────────────────────────────────────────────────── */

export function CTABarRegisteredOther({
  onMakeAboutMe,
  factTemplateReady,
}: {
  onMakeAboutMe: () => void;
  factTemplateReady: boolean;
}) {
  return (
    <div className="space-y-3" data-testid="cta-registered-other">
      <PrimaryButton
        onClick={factTemplateReady ? onMakeAboutMe : undefined}
        disabled={!factTemplateReady}
        testId="make-this-about-me"
      >
        {factTemplateReady ? "Make this fact about me" : "Loading…"} <ArrowRight className="w-4 h-4" />
      </PrimaryButton>
      <SecondaryButton href="/" testId="browse-more-facts">
        <Library className="w-4 h-4" /> Browse more facts
      </SecondaryButton>
    </div>
  );
}

/* ─── legendary-other ────────────────────────────────────────────────────── */

export function CTABarLegendaryOther({
  onMakeAboutMe,
  factTemplateReady,
}: {
  onMakeAboutMe: () => void;
  factTemplateReady: boolean;
}) {
  return (
    <div className="space-y-3" data-testid="cta-legendary-other">
      <PrimaryButton
        onClick={factTemplateReady ? onMakeAboutMe : undefined}
        disabled={!factTemplateReady}
        testId="make-this-about-me"
      >
        <Crown className="w-4 h-4" /> {factTemplateReady ? "Make this fact about me" : "Loading…"}
      </PrimaryButton>
      <SecondaryButton href="/library" testId="browse-more-facts">
        <Library className="w-4 h-4" /> Browse more facts
      </SecondaryButton>
    </div>
  );
}
