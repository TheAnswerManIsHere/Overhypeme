import { Link, useLocation } from "wouter";
import { Search, Plus, User, LogIn, Star, Crown, ShieldCheck, Share2 } from "lucide-react";
import { useAuth } from "@workspace/replit-auth-web";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useState, useRef } from "react";
import { NameTag } from "@/components/NameTag";
import { ShareModal } from "@/components/ShareModal";
import { AccountMenu, AccountMenuAvatarTrigger } from "@/components/layout/AccountMenu";
import { usePersonName } from "@/hooks/use-person-name";
import { useGetMyProfile, getGetMyProfileQueryKey } from "@workspace/api-client-react";

function dicebearUrl(style: string, seed: string) {
  return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}`;
}

// Flame mark SVG matching the design
function FlameMark({ className = "" }: { className?: string }) {
  return (
    <svg width="14" height="17" viewBox="0 0 16 20" fill="none" className={className}>
      <path d="M8 1c1 4 5 5 5 10s-2.5 8-5 8-5-3-5-8c0-4 2-5 3-7 0 2 1 3 2 3z" fill="currentColor" />
    </svg>
  );
}

export function Navbar() {
  const { user, isAuthenticated, isLoading: authLoading, role, realRole, refreshUser } = useAuth();
  const { name } = usePersonName();
  const { data: profile } = useGetMyProfile({
    query: { queryKey: getGetMyProfileQueryKey(), enabled: isAuthenticated, staleTime: 60_000 }
  });
  // Cold visitor on mobile = nobody is logged in AND we don't yet have a stored
  // name.  In that state we collapse the left avatar/login chip so the top bar
  // is just the wordmark + search icon — the inline name input on Home does
  // the onboarding work instead of a competing nav button.
  const isColdMobile = !isAuthenticated && !authLoading && !name;

  const isLegendary = role === "legendary" || role === "admin";

  const navAvatarUrl = (() => {
    if (isLegendary && profile?.profileImageUrl && (profile?.avatarSource ?? "avatar") === "photo") {
      return profile.profileImageUrl;
    }
    if (profile?.id) {
      return dicebearUrl(profile?.avatarStyle ?? "bottts", profile.id);
    }
    return null;
  })();

  const [, setLocation] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const logoTapCount = useRef(0);
  const logoTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function doAdminLogin() {
    logoTapCount.current = 0;
    if (logoTapTimer.current) { clearTimeout(logoTapTimer.current); logoTapTimer.current = null; }
    // POST mutates the existing session in-place on the server — no new cookie
    // needs to be stored by the browser. Then refreshUser() re-fetches the
    // auth state so the UI reflects admin without any page navigation.
    void fetch("/api/auth/dev-admin-login", { method: "POST", credentials: "include" })
      .then((res) => { if (res.ok) void refreshUser(); })
      .catch(() => { /* silently ignore */ });
  }

  // Mobile: onTouchEnd fires on every tap reliably (onClick is suppressed by
  // the browser on rapid taps due to double-tap zoom detection). Calling
  // e.preventDefault() here stops the synthetic click from also firing.
  const handleWordmarkTouchEnd = (e: React.TouchEvent) => {
    e.preventDefault();
    logoTapCount.current += 1;
    if (logoTapTimer.current) clearTimeout(logoTapTimer.current);
    if (logoTapCount.current >= 3) { doAdminLogin(); return; }
    logoTapTimer.current = setTimeout(() => { logoTapCount.current = 0; }, 1500);
    setLocation("/");
  };

  // Desktop: plain click handler (no touch suppression needed).
  const handleLogoClick = (e: React.MouseEvent) => {
    e.preventDefault();
    logoTapCount.current += 1;
    if (logoTapTimer.current) clearTimeout(logoTapTimer.current);
    if (logoTapCount.current >= 3) { doAdminLogin(); return; }
    logoTapTimer.current = setTimeout(() => { logoTapCount.current = 0; }, 1500);
    setLocation("/");
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      setLocation(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
      setMobileSearchOpen(false);
    }
  };

  const isRealAdmin = realRole === "admin";
  const isAdminModeOn = role === "admin";

  const accountFallbackInitial = user?.firstName?.[0]?.toUpperCase() ?? user?.email?.[0]?.toUpperCase();

  return (
    <>
      {/* ── MOBILE top bar ───────────────────────────────────────────── */}
      <header className="md:hidden sticky top-0 z-50 w-full bg-background/95 backdrop-blur border-b border-border">
        <div className="flex items-center h-14 px-4">
          {/* Left: avatar / profile link.  Suppressed entirely for cold visitors
              so the top bar is wordmark-first; the inline name input on Home
              owns the onboarding moment. */}
          <div className="w-10 flex items-center">
            {isAuthenticated && !authLoading ? (
              <button onClick={() => setLocation("/profile")} aria-label="Go to profile">
                <AccountMenuAvatarTrigger avatarUrl={navAvatarUrl} fallbackInitial={accountFallbackInitial} />
              </button>
            ) : !isColdMobile ? (
              <button onClick={() => setLocation("/login")} className="w-8 h-8 rounded-full bg-secondary border border-border flex items-center justify-center text-muted-foreground">
                <User className="w-4 h-4" />
              </button>
            ) : null}
          </div>

          {/* Center: wordmark — touch handler for reliable triple-tap on mobile */}
          <button
            type="button"
            onTouchEnd={handleWordmarkTouchEnd}
            onClick={handleLogoClick}
            className="flex-1 flex items-center justify-center gap-1.5"
            style={{ touchAction: "manipulation" }}
          >
            <FlameMark className="text-primary" />
            <span className="font-display font-bold text-sm uppercase tracking-widest text-foreground">
              OVERHYPE<span className="text-primary">.ME</span>
            </span>
          </button>

          {/* Right: search icon */}
          <div className="w-10 flex items-center justify-end">
            <button
              onClick={() => setMobileSearchOpen(v => !v)}
              className="w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Search"
            >
              <Search className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Name tag row — visible on mobile in BOTH auth states. For unauth visitors
            this is the only entry point to set their name; for signed-in users
            tapping it routes to /profile. The chip is centered so it reads as the
            primary identity input on the page rather than competing with nav. */}
        {!isColdMobile && (
          <div className="px-4 pb-2 flex items-center justify-center">
            <NameTag />
          </div>
        )}

        {/* Inline search expansion */}
        {mobileSearchOpen && (
          <div className="px-4 pb-3">
            <form onSubmit={handleSearch}>
              <Input
                placeholder="Search facts, hashtags…"
                icon={<Search className="w-4 h-4" />}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="bg-secondary border-transparent focus-visible:border-primary h-10"
                autoFocus
              />
            </form>
          </div>
        )}
      </header>

      {/* ── DESKTOP top bar (unchanged structure, refined look) ──────── */}
      <nav className="hidden md:block sticky top-0 z-50 w-full bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b border-border shadow-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">

            {/* Logo */}
            <Link href="/" onClick={handleLogoClick} className="shrink-0 group flex items-center gap-2">
              <img
                src={`${import.meta.env.BASE_URL}images/logo.svg`}
                alt="Overhype.me"
                className="h-8 w-auto opacity-90 group-hover:opacity-100 transition-opacity"
              />
            </Link>

            {/* Name tag */}
            <div className="flex items-center ml-3 shrink-0">
              <NameTag />
            </div>

            {/* Desktop Search */}
            <div className="hidden md:flex flex-1 max-w-xl mx-4">
              <form onSubmit={handleSearch} className="w-full relative">
                <Input
                  placeholder="Search facts, hashtags…"
                  icon={<Search className="w-5 h-5" />}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="h-10 bg-secondary border-transparent focus-visible:border-primary focus-visible:ring-primary/20"
                />
              </form>
            </div>

            {/* Desktop actions */}
            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShareOpen(true)}
                className="gap-2 whitespace-nowrap font-bold uppercase tracking-wider shadow-[0_0_18px_rgba(249,115,22,0.4)] hover:shadow-[0_0_24px_rgba(249,115,22,0.7)] transition-shadow"
              >
                <Share2 className="w-4 h-4" /> SHARE
              </Button>
              <Button variant="outline" size="sm" onClick={() => setLocation('/submit')} className="hidden lg:flex gap-2 whitespace-nowrap">
                <Plus className="w-4 h-4" /> SUBMIT
              </Button>
              {isLegendary ? (
                <div className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 bg-yellow-500/15 border border-yellow-500/40 rounded-full">
                  <Crown className="w-4 h-4 text-yellow-500" />
                  <span className="text-xs font-display font-bold uppercase tracking-wider text-yellow-500">Legendary</span>
                </div>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setLocation('/pricing')} className="hidden lg:flex gap-2 whitespace-nowrap text-primary hover:text-primary">
                  <Star className="w-4 h-4" /> LEGENDARY
                </Button>
              )}

              {!authLoading && (isAuthenticated ? (
                <div className="flex items-center gap-2">
                  {isRealAdmin && isAdminModeOn && (
                    <Button variant="ghost" size="icon" onClick={() => setLocation('/admin')} title="Admin Panel">
                      <ShieldCheck className="w-5 h-5 text-primary" />
                    </Button>
                  )}
                  <AccountMenu>
                    <AccountMenuAvatarTrigger avatarUrl={navAvatarUrl} fallbackInitial={accountFallbackInitial} />
                  </AccountMenu>
                </div>
              ) : (
                <Button variant="primary" size="sm" onClick={() => setLocation('/login')} className="gap-2 whitespace-nowrap">
                  <LogIn className="w-4 h-4" /> LOGIN
                </Button>
              ))}
            </div>
          </div>
        </div>
      </nav>

      <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} />
    </>
  );
}
