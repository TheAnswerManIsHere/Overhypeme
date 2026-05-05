import { Link, useLocation } from "wouter";
import { Search, User, LogIn } from "lucide-react";
import { useAuth } from "@workspace/replit-auth-web";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useState, useRef } from "react";
import { NameTag } from "@/components/NameTag";
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
  const { user, isAuthenticated, isLoading: authLoading, role, refreshUser } = useAuth();
  const { name } = usePersonName();
  const { data: profile } = useGetMyProfile({
    query: { queryKey: getGetMyProfileQueryKey(), enabled: isAuthenticated, staleTime: 60_000 }
  });
  // Cold visitor on mobile = nobody is logged in AND we don't yet have a stored
  // name.  In that state we collapse the avatar/login chip so the top bar
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

  const accountFallbackInitial = user?.firstName?.[0]?.toUpperCase() ?? user?.email?.[0]?.toUpperCase();

  return (
    <>
      {/* ── MOBILE top bar ───────────────────────────────────────────── */}
      <header className="md:hidden sticky top-0 z-50 w-full bg-background/95 backdrop-blur border-b border-border">
        <div className="flex items-center h-14 px-4 gap-2">
          {/* Left: wordmark — touch handler for reliable triple-tap on mobile */}
          <button
            type="button"
            onTouchEnd={handleWordmarkTouchEnd}
            onClick={handleLogoClick}
            className="flex-1 flex items-center justify-start gap-1.5"
            style={{ touchAction: "manipulation" }}
          >
            <FlameMark className="text-primary" />
            <span className="font-display font-bold text-sm uppercase tracking-widest text-foreground">
              OVERHYPE<span className="text-primary">.ME</span>
            </span>
          </button>

          {/* Right cluster: search icon, then avatar — mirrors desktop's
              "avatar lives in the top-right corner" rule. */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setMobileSearchOpen(v => !v)}
              className="w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Search"
            >
              <Search className="w-5 h-5" />
            </button>
            {isAuthenticated && !authLoading ? (
              <AccountMenu>
                <AccountMenuAvatarTrigger avatarUrl={navAvatarUrl} fallbackInitial={accountFallbackInitial} />
              </AccountMenu>
            ) : !isColdMobile ? (
              <button onClick={() => setLocation("/login")} className="w-8 h-8 rounded-full bg-secondary border border-border flex items-center justify-center text-muted-foreground" aria-label="Sign in">
                <User className="w-4 h-4" />
              </button>
            ) : null}
          </div>
        </div>

        {/* Identity row — full-width, prominent. THE personalization affordance,
            so it earns its visual weight underneath the top bar. */}
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

      {/* ── DESKTOP top bar ──────────────────────────────────────────── */}
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

            {/* Identity selector */}
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

            {/* Avatar / login — chrome contains navigation only; SHARE / SUBMIT
                / LEGENDARY no longer live here (Invite friends + Membership
                are inside the avatar dropdown; Submit lives on /library). */}
            <div className="flex items-center gap-3">
              {!authLoading && (isAuthenticated ? (
                <AccountMenu>
                  <AccountMenuAvatarTrigger avatarUrl={navAvatarUrl} fallbackInitial={accountFallbackInitial} />
                </AccountMenu>
              ) : (
                <Button variant="primary" size="sm" onClick={() => setLocation('/login')} className="gap-2 whitespace-nowrap">
                  <LogIn className="w-4 h-4" /> LOGIN
                </Button>
              ))}
            </div>
          </div>
        </div>
      </nav>
    </>
  );
}
