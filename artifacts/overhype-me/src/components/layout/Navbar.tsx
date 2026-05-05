import { Link, useLocation } from "wouter";
import { Search, User, LogIn } from "lucide-react";
import { useAuth } from "@workspace/replit-auth-web";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useState } from "react";
import { NameTag } from "@/components/NameTag";
import { AccountMenuAvatarTrigger } from "@/components/layout/AccountMenu";
import { usePersonName } from "@/hooks/use-person-name";
import { useGetMyProfile, getGetMyProfileQueryKey } from "@workspace/api-client-react";

function dicebearUrl(style: string, seed: string) {
  return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}`;
}

// Module-level tap counter — intentionally outside the component so it survives
// Navbar remounts. Each page renders its own <Layout><Navbar />, meaning a click
// that navigates away from the current page will unmount and remount the Navbar,
// resetting any useRef values back to 0.  A module-level variable persists for
// the lifetime of the browser session, allowing the triple-click sequence to
// span the navigation that happens on click #1.
let _logoTapCount = 0;
let _logoTapTimer: ReturnType<typeof setTimeout> | null = null;

// Flame mark SVG matching the design
function FlameMark({ className = "" }: { className?: string }) {
  return (
    <svg width="14" height="17" viewBox="0 0 16 20" fill="none" className={className}>
      <path d="M8 1c1 4 5 5 5 10s-2.5 8-5 8-5-3-5-8c0-4 2-5 3-7 0 2 1 3 2 3z" fill="currentColor" />
    </svg>
  );
}

export function Navbar() {
  const { user, isAuthenticated, isLoading: authLoading, role } = useAuth();
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

  function doAdminLogin() {
    _logoTapCount = 0;
    if (_logoTapTimer) { clearTimeout(_logoTapTimer); _logoTapTimer = null; }
    // Use top-level navigation to the GET endpoint instead of fetch().
    //
    // Why: in Chrome (esp. on Windows) when the app is viewed inside an
    // iframe (e.g. Replit canvas preview) or when storage partitioning /
    // tracking-protection is active, Set-Cookie responses to fetch() inside
    // the iframe are silently dropped — the POST returns 200 but the new
    // session sid never lands in the cookie jar, so subsequent admin
    // requests come back 401 and the AdminLayout renders "Access Denied".
    //
    // Top-level navigation responses go through a different (more permissive)
    // cookie path in every modern browser, so the sid actually persists.
    // The GET handler returns an HTML page that JS-redirects to `returnTo`
    // *after* the Set-Cookie has been committed, then admin requests work.
    window.location.href = "/api/auth/dev-admin-login?returnTo=/admin";
  }

  // Mobile: onTouchEnd fires on every tap reliably (onClick is suppressed by
  // the browser on rapid taps due to double-tap zoom detection). Calling
  // e.preventDefault() here stops the synthetic click from also firing.
  const handleWordmarkTouchEnd = (e: React.TouchEvent) => {
    e.preventDefault();
    _logoTapCount += 1;
    if (_logoTapTimer) clearTimeout(_logoTapTimer);
    if (_logoTapCount >= 3) { doAdminLogin(); return; }
    _logoTapTimer = setTimeout(() => { _logoTapCount = 0; }, 1500);
    setLocation("/");
  };

  // Desktop: plain click handler (no touch suppression needed).
  const handleLogoClick = (e: React.MouseEvent) => {
    e.preventDefault();
    _logoTapCount += 1;
    if (_logoTapTimer) clearTimeout(_logoTapTimer);
    if (_logoTapCount >= 3) { doAdminLogin(); return; }
    _logoTapTimer = setTimeout(() => { _logoTapCount = 0; }, 1500);
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
              <button onClick={() => setLocation("/profile")} aria-label="Go to profile">
                <AccountMenuAvatarTrigger avatarUrl={navAvatarUrl} fallbackInitial={accountFallbackInitial} />
              </button>
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
            <Link href="/" onClick={handleLogoClick} className="shrink-0 group flex items-center gap-2 select-none">
              <img
                src={`${import.meta.env.BASE_URL}images/logo.svg`}
                alt="Overhype.me"
                draggable={false}
                className="h-8 w-auto opacity-90 group-hover:opacity-100 transition-opacity pointer-events-none"
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
                <button onClick={() => setLocation("/profile")} aria-label="Go to profile">
                  <AccountMenuAvatarTrigger avatarUrl={navAvatarUrl} fallbackInitial={accountFallbackInitial} />
                </button>
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
