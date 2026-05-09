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
import { ArrowRight, Crown, Download, ExternalLink, Library, Share2, ShoppingBag } from "lucide-react";
import { Link } from "wouter";
import { useState } from "react";

const PRONOUNS = ["he/him", "she/her", "they/them"] as const;
type Pronouns = (typeof PRONOUNS)[number];

interface OpenBuilderArgs {
  initialName?: string;
  initialPronouns?: string;
}

/* ─── shared atoms ───────────────────────────────────────────────────────── */

function PrimaryButton({
  children,
  onClick,
  href,
  testId,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
  testId?: string;
}) {
  const cls =
    "inline-flex items-center justify-center gap-2 h-[52px] px-5 rounded-[14px] bg-primary text-white font-display font-bold text-[13px] uppercase tracking-wider hover:brightness-110 transition w-full";
  if (href) {
    return (
      <Link href={href} data-testid={testId} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button onClick={onClick} data-testid={testId} className={cls}>
      {children}
    </button>
  );
}

function SecondaryButton({
  children,
  onClick,
  href,
  testId,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
  testId?: string;
}) {
  const cls =
    "inline-flex items-center justify-center gap-2 h-[44px] px-4 rounded-[12px] bg-card border border-border text-foreground font-display font-bold text-[12px] uppercase tracking-wider hover:border-primary/60 transition w-full";
  if (href) {
    return (
      <Link href={href} data-testid={testId} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button onClick={onClick} data-testid={testId} className={cls}>
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
        <ShoppingBag className="w-4 h-4 text-muted-foreground" />
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
            See yourself in it
          </div>
        </div>
      </Link>
    </div>
  );
}

/* ─── anon-other ─────────────────────────────────────────────────────────── */

export function CTABarAnonOther({
  onOpenBuilder,
}: {
  onOpenBuilder: (a: OpenBuilderArgs) => void;
}) {
  const [name, setName] = useState("");
  const [pronouns, setPronouns] = useState<Pronouns>("they/them");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onOpenBuilder({
      initialName: name.trim() || undefined,
      initialPronouns: pronouns,
    });
  };

  return (
    <div className="space-y-4" data-testid="cta-anon-other">
      <form onSubmit={handleSubmit} className="rounded-[16px] bg-card border border-primary/40 p-4 space-y-3">
        <p className="text-[11px] font-display font-bold tracking-[0.18em] text-primary uppercase">
          See it with your name
        </p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          maxLength={50}
          data-testid="anon-name-input"
          className="w-full h-[44px] px-3 rounded-[10px] bg-background border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
        />
        <select
          value={pronouns}
          onChange={(e) => setPronouns(e.target.value as Pronouns)}
          data-testid="anon-pronouns-input"
          className="w-full h-[44px] px-3 rounded-[10px] bg-background border border-border text-foreground focus:outline-none focus:border-primary"
        >
          {PRONOUNS.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <PrimaryButton testId="anon-see-with-name">
          See it with your name <ArrowRight className="w-4 h-4" />
        </PrimaryButton>
      </form>
      <SecondaryButton href="/library" testId="browse-more-facts">
        <Library className="w-4 h-4" /> Browse more facts
      </SecondaryButton>
      <TierLadderTeasers />
    </div>
  );
}

/* ─── anon-own-transient ─────────────────────────────────────────────────── */

export function CTABarAnonOwnTransient({
  onSignup,
  onDownload,
}: {
  onSignup: () => void;
  onDownload: () => void;
}) {
  return (
    <div className="space-y-3" data-testid="cta-anon-own-transient">
      <PrimaryButton onClick={onSignup} testId="anon-signup">
        Save your meme — sign up free <ArrowRight className="w-4 h-4" />
      </PrimaryButton>
      <SecondaryButton onClick={onDownload} testId="anon-download">
        <Download className="w-4 h-4" /> Download
      </SecondaryButton>
      <TierLadderTeasers />
    </div>
  );
}

/* ─── registered-own ─────────────────────────────────────────────────────── */

export function CTABarRegisteredOwn({
  onDownload,
  onCustomShare,
  wearHref,
  legendaryUpsellSubject,
}: {
  onDownload: () => void;
  onCustomShare: () => void;
  wearHref: string;
  legendaryUpsellSubject: string;
}) {
  return (
    <div className="space-y-3" data-testid="cta-registered-own">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <PrimaryButton onClick={onDownload} testId="own-download">
          <Download className="w-4 h-4" /> Download
        </PrimaryButton>
        <PrimaryButton onClick={onCustomShare} testId="own-custom-share">
          <Share2 className="w-4 h-4" /> Custom share
        </PrimaryButton>
      </div>
      <Link
        href="/pricing"
        data-testid="legendary-upsell"
        className="block rounded-[14px] bg-card border border-primary/40 p-4 hover:border-primary transition"
      >
        <div className="flex items-start gap-3">
          <Crown className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-display text-[14px] uppercase tracking-wider text-primary mb-1">
              Turn this up to 11
            </div>
            <div className="text-[12px] text-muted-foreground leading-snug">
              See yourself in this meme like {legendaryUpsellSubject}, not just your name.
            </div>
          </div>
          <ArrowRight className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
        </div>
      </Link>
      <SecondaryButton href={wearHref} testId="merch-wear">
        <ShoppingBag className="w-4 h-4" /> Wear this meme <ExternalLink className="w-3 h-3 opacity-70" />
      </SecondaryButton>
    </div>
  );
}

/* ─── registered-other ───────────────────────────────────────────────────── */

export function CTABarRegisteredOther({
  onMakeAboutMe,
  legendaryUpsellSubject,
}: {
  onMakeAboutMe: () => void;
  legendaryUpsellSubject: string;
}) {
  return (
    <div className="space-y-3" data-testid="cta-registered-other">
      <PrimaryButton onClick={onMakeAboutMe} testId="make-this-about-me">
        Make this fact about me <ArrowRight className="w-4 h-4" />
      </PrimaryButton>
      <SecondaryButton href="/library" testId="browse-more-facts">
        <Library className="w-4 h-4" /> Browse more facts
      </SecondaryButton>
      <Link
        href="/pricing"
        data-testid="legendary-upsell"
        className="block rounded-[14px] bg-card border border-primary/40 p-4 hover:border-primary transition"
      >
        <div className="flex items-start gap-3">
          <Crown className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="font-display text-[14px] uppercase tracking-wider text-primary mb-1">
              Turn this up to 11
            </div>
            <div className="text-[12px] text-muted-foreground leading-snug">
              See yourself in this meme like {legendaryUpsellSubject}, not just your name.
            </div>
          </div>
          <ArrowRight className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
        </div>
      </Link>
    </div>
  );
}

/* ─── legendary-own-stock ────────────────────────────────────────────────── */

export function CTABarLegendaryOwnStock({
  onTurnUp,
  onDownload,
  onCustomShare,
  wearHref,
}: {
  onTurnUp: () => void;
  onDownload: () => void;
  onCustomShare: () => void;
  wearHref: string;
}) {
  return (
    <div className="space-y-3" data-testid="cta-legendary-own-stock">
      <PrimaryButton onClick={onTurnUp} testId="turn-up-to-11">
        <Crown className="w-4 h-4" /> Turn this up to 11
      </PrimaryButton>
      <div className="grid grid-cols-2 gap-3">
        <SecondaryButton onClick={onDownload} testId="own-download">
          <Download className="w-4 h-4" /> Download
        </SecondaryButton>
        <SecondaryButton onClick={onCustomShare} testId="own-custom-share">
          <Share2 className="w-4 h-4" /> Custom share
        </SecondaryButton>
      </div>
      <SecondaryButton href={wearHref} testId="merch-wear">
        <ShoppingBag className="w-4 h-4" /> Wear this meme <ExternalLink className="w-3 h-3 opacity-70" />
      </SecondaryButton>
    </div>
  );
}

/* ─── legendary-own-pulid ────────────────────────────────────────────────── */

export function CTABarLegendaryOwnPulid({
  onDownload,
  onCustomShare,
  wearHref,
}: {
  onDownload: () => void;
  onCustomShare: () => void;
  wearHref: string;
}) {
  return (
    <div className="space-y-3" data-testid="cta-legendary-own-pulid">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <PrimaryButton onClick={onDownload} testId="own-download">
          <Download className="w-4 h-4" /> Download
        </PrimaryButton>
        <PrimaryButton onClick={onCustomShare} testId="own-custom-share">
          <Share2 className="w-4 h-4" /> Custom share
        </PrimaryButton>
      </div>
      <SecondaryButton href={wearHref} testId="merch-wear">
        <ShoppingBag className="w-4 h-4" /> Wear this meme <ExternalLink className="w-3 h-3 opacity-70" />
      </SecondaryButton>
    </div>
  );
}

/* ─── legendary-other ────────────────────────────────────────────────────── */

export function CTABarLegendaryOther({
  onMakeAboutMe,
}: {
  onMakeAboutMe: () => void;
}) {
  return (
    <div className="space-y-3" data-testid="cta-legendary-other">
      <PrimaryButton onClick={onMakeAboutMe} testId="make-this-about-me">
        <Crown className="w-4 h-4" /> Make this fact about me
      </PrimaryButton>
      <SecondaryButton href="/library" testId="browse-more-facts">
        <Library className="w-4 h-4" /> Browse more facts
      </SecondaryButton>
    </div>
  );
}
