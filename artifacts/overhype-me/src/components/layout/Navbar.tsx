import { Link, useLocation } from "wouter";
import { Search, Plus, User, LogIn, Menu, X, Star, Crown, ShieldCheck, ShieldOff, Activity, Share2, Eraser } from "lucide-react";
import { useAuth } from "@workspace/replit-auth-web";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { NameTag } from "@/components/NameTag";
import { ShareModal } from "@/components/ShareModal";
import { useGetMyProfile, getGetMyProfileQueryKey } from "@workspace/api-client-react";

function dicebearUrl(style: string, seed: string) {
  return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}`;
}

export function Navbar() {
  const { user, isAuthenticated, role, logout } = useAuth();
  const { data: profile } = useGetMyProfile({
    query: { queryKey: getGetMyProfileQueryKey(), enabled: isAuthenticated, staleTime: 60_000 }
  });

  const navAvatarUrl = (() => {
    if (profile?.isPremium && profile?.profileImageUrl && (profile?.avatarSource ?? "avatar") === "photo") {
      return profile.profileImageUrl;
    }
    if (profile?.id) {
      return dicebearUrl(profile?.avatarStyle ?? "bottts", profile.id);
    }
    return null;
  })();
  const [, setLocation] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [togglingAdmin, setTogglingAdmin] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [forgetMeConfirm, setForgetMeConfirm] = useState(false);

  function handleForgetMe() {
    // Destroy server session (best-effort — guest users may not have one)
    void fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    localStorage.clear();
    sessionStorage.clear();
    document.cookie.split(";").forEach((c) => {
      document.cookie = c
        .replace(/^ +/, "")
        .replace(/=.*/, `=;expires=${new Date(0).toUTCString()};path=/`);
    });
    window.location.replace("/");
  }

  // ── Secret dev admin login: triple-click the logo ──────────────────────────
  const logoClickCount  = useRef(0);
  const logoClickTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleLogoClick = (e: React.MouseEvent) => {
    logoClickCount.current += 1;
    if (logoClickTimer.current) clearTimeout(logoClickTimer.current);

    if (logoClickCount.current >= 3) {
      logoClickCount.current = 0;
      e.preventDefault();
      void (async () => {
        try {
          const isProd = !window.location.hostname.endsWith(".replit.dev") && window.location.hostname !== "localhost";
          const headers: Record<string, string> = {};
          if (isProd) {
            const key = window.prompt("Admin key:");
            if (!key) return;
            headers["x-admin-key"] = key;
          }
          if (isAuthenticated) await logout();
          const res = await fetch("/api/auth/dev-admin-login", {
            method: "POST",
            credentials: "include",
            headers,
          });
          if (res.ok) {
            const data = await res.json() as { sid?: string };
            if (data.sid) localStorage.setItem("auth_token", data.sid);
            window.location.href = "/";
          }
        } catch {
          // silently ignore
        }
      })();
      return;
    }

    logoClickTimer.current = setTimeout(() => { logoClickCount.current = 0; }, 1500);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      setLocation(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
      setMobileMenuOpen(false);
    }
  };

  const handleToggleAdminMode = async () => {
    setTogglingAdmin(true);
    try {
      await fetch("/api/auth/toggle-admin-mode", {
        method: "POST",
        credentials: "include",
      });
      window.location.reload();
    } catch {
      setTogglingAdmin(false);
    }
  };

  const isRealAdmin = user?.isRealAdmin;
  const isAdminModeOn = user?.isAdmin;
  const isPremium = role === "legendary" || role === "admin";

  return (
    <nav className="sticky top-0 z-50 w-full bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b-2 border-border shadow-lg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-20">
          
          {/* Logo — triple-click for dev admin login */}
          <Link href="/" onClick={handleLogoClick} className="shrink-0 group">
            <img
              src={`${import.meta.env.BASE_URL}images/logo.svg`}
              alt="Overhype.me"
              className="h-9 w-auto opacity-90 group-hover:opacity-100 transition-opacity"
            />
          </Link>

          {/* Name tag — always visible */}
          <div className="flex items-center ml-3 shrink-0">
            <NameTag />
          </div>

          {/* Desktop Search */}
          <div className="hidden md:flex flex-1 max-w-xl mx-4">
            <form onSubmit={handleSearch} className="w-full relative">
              <Input 
                placeholder="Search facts, hashtags..." 
                icon={<Search className="w-5 h-5" />}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-11 bg-secondary border-transparent focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </form>
          </div>

          {/* Desktop Actions */}
          <div className="hidden md:flex items-center gap-4">
            <Button
              variant="primary"
              size="sm"
              onClick={() => setShareOpen(true)}
              className="gap-2 whitespace-nowrap font-bold uppercase tracking-wider shadow-[0_0_18px_rgba(249,115,22,0.45)] hover:shadow-[0_0_24px_rgba(249,115,22,0.7)] transition-shadow"
            >
              <Share2 className="w-4 h-4" /> SHARE THIS
            </Button>
            <Button variant="outline" size="sm" onClick={() => setLocation('/submit')} className="hidden lg:flex gap-2 whitespace-nowrap">
              <Plus className="w-4 h-4" /> SUBMIT FACT
            </Button>
            {isPremium ? (
              <div className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 bg-yellow-500/15 border border-yellow-500/40 rounded-sm">
                <Crown className="w-4 h-4 text-yellow-500" />
                <span className="text-xs font-display font-bold uppercase tracking-wider text-yellow-500">Legendary</span>
              </div>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setLocation('/pricing')} className="hidden lg:flex gap-2 whitespace-nowrap text-primary hover:text-primary">
                <Star className="w-4 h-4" /> GO LEGENDARY
              </Button>
            )}
            
            {isAuthenticated ? (
              <div className="flex items-center gap-3">
                {isRealAdmin && isAdminModeOn && (
                  <>
                    <Button variant="ghost" size="icon" onClick={() => setLocation('/admin')} title="Admin Panel">
                      <ShieldCheck className="w-5 h-5 text-primary" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleToggleAdminMode}
                      isLoading={togglingAdmin}
                      title="Exit admin mode"
                      className="gap-1 text-xs text-muted-foreground hover:text-destructive hidden lg:flex"
                    >
                      <ShieldOff className="w-3.5 h-3.5" /> EXIT ADMIN
                    </Button>
                  </>
                )}
                {isRealAdmin && !isAdminModeOn && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleToggleAdminMode}
                    isLoading={togglingAdmin}
                    title="Enter admin mode"
                    className="gap-1 text-xs text-muted-foreground hover:text-primary hidden lg:flex"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" /> ADMIN MODE
                  </Button>
                )}
                <Button variant="ghost" size="icon" onClick={() => setLocation('/activity')} title="Activity Feed">
                  <Activity className="w-5 h-5" />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => setLocation('/profile')}>
                  {navAvatarUrl ? (
                    <img src={navAvatarUrl} alt="Profile" className="w-8 h-8 rounded-sm object-cover" />
                  ) : (
                    <User className="w-5 h-5" />
                  )}
                </Button>
                {isRealAdmin && (
                  !forgetMeConfirm ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setForgetMeConfirm(true)}
                      title="Forget me — clear all local data and start fresh"
                      className="gap-1.5 text-muted-foreground hover:text-destructive px-2"
                    >
                      <Eraser className="w-3.5 h-3.5" />
                      <span className="hidden lg:inline text-xs">Forget me</span>
                    </Button>
                  ) : (
                    <div className="flex items-center gap-1 bg-destructive/10 border border-destructive/30 rounded-sm px-2 py-1">
                      <span className="text-xs text-destructive font-medium whitespace-nowrap">Forget me?</span>
                      <button
                        onClick={handleForgetMe}
                        className="text-xs font-bold text-destructive hover:text-white hover:bg-destructive px-1.5 py-0.5 rounded-sm transition-colors"
                      >
                        Yes
                      </button>
                      <button
                        onClick={() => setForgetMeConfirm(false)}
                        className="text-xs font-bold text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded-sm transition-colors"
                      >
                        No
                      </button>
                    </div>
                  )
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button variant="primary" size="sm" onClick={() => setLocation('/login')} className="gap-2 whitespace-nowrap animate-pulse">
                  <LogIn className="w-4 h-4" /> LOGIN
                </Button>
              </div>
            )}
          </div>

          {/* Mobile menu button */}
          <div className="flex items-center md:hidden">
            <Button variant="ghost" size="icon" onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </Button>
          </div>
        </div>
      </div>

      {/* Mobile Menu */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="md:hidden border-t-2 border-border overflow-hidden bg-card"
          >
            <div className="p-4 space-y-4">
              <form onSubmit={handleSearch}>
                <Input 
                  placeholder="Search facts..." 
                  icon={<Search className="w-5 h-5" />}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="bg-secondary"
                />
              </form>
              <Button
                variant="primary"
                className="w-full gap-2 font-bold uppercase tracking-wider shadow-[0_0_18px_rgba(249,115,22,0.4)]"
                onClick={() => { setMobileMenuOpen(false); setShareOpen(true); }}
              >
                <Share2 className="w-5 h-5" /> SHARE THIS
              </Button>
              <Button variant="outline" className="w-full gap-2" onClick={() => { setLocation('/submit'); setMobileMenuOpen(false); }}>
                <Plus className="w-5 h-5" /> SUBMIT NEW FACT
              </Button>
              {isPremium ? (
                <div className="flex items-center justify-center gap-2 py-2 bg-yellow-500/15 border border-yellow-500/40 rounded-sm">
                  <Crown className="w-5 h-5 text-yellow-500" />
                  <span className="text-sm font-display font-bold uppercase tracking-wider text-yellow-500">Legendary Member</span>
                </div>
              ) : (
                <Button variant="ghost" className="w-full gap-2 text-primary" onClick={() => { setLocation('/pricing'); setMobileMenuOpen(false); }}>
                  <Star className="w-5 h-5" /> GO LEGENDARY
                </Button>
              )}
              {isAuthenticated ? (
                <div className="grid grid-cols-2 gap-4">
                  {isRealAdmin && isAdminModeOn && (
                    <>
                      <Button variant="outline" className="w-full gap-2 col-span-2 border-primary text-primary" onClick={() => { setLocation('/admin'); setMobileMenuOpen(false); }}>
                        <ShieldCheck className="w-5 h-5" /> ADMIN PANEL
                      </Button>
                      <Button
                        variant="ghost"
                        className="w-full gap-2 col-span-2 text-muted-foreground hover:text-destructive"
                        onClick={handleToggleAdminMode}
                        isLoading={togglingAdmin}
                      >
                        <ShieldOff className="w-4 h-4" /> EXIT ADMIN MODE
                      </Button>
                    </>
                  )}
                  {isRealAdmin && !isAdminModeOn && (
                    <Button
                      variant="ghost"
                      className="w-full gap-2 col-span-2 text-muted-foreground hover:text-primary"
                      onClick={handleToggleAdminMode}
                      isLoading={togglingAdmin}
                    >
                      <ShieldCheck className="w-4 h-4" /> ENTER ADMIN MODE
                    </Button>
                  )}
                  <Button variant="secondary" className="w-full gap-2" onClick={() => { setLocation('/activity'); setMobileMenuOpen(false); }}>
                    <Activity className="w-5 h-5" /> ACTIVITY
                  </Button>
                  <Button variant="secondary" className="w-full gap-2" onClick={() => { setLocation('/profile'); setMobileMenuOpen(false); }}>
                    <User className="w-5 h-5" /> PROFILE
                  </Button>
                  {isRealAdmin && (
                    !forgetMeConfirm ? (
                      <Button
                        variant="ghost"
                        className="w-full gap-2 text-muted-foreground hover:text-destructive justify-center"
                        onClick={() => setForgetMeConfirm(true)}
                      >
                        <Eraser className="w-4 h-4" /> Forget me
                      </Button>
                    ) : (
                      <div className="flex items-center justify-center gap-2 bg-destructive/10 border border-destructive/30 rounded px-3 py-2">
                        <span className="text-sm text-destructive font-medium">Forget me?</span>
                        <button
                          onClick={handleForgetMe}
                          className="text-sm font-bold text-destructive hover:text-white hover:bg-destructive px-2 py-1 rounded transition-colors"
                        >
                          Yes
                        </button>
                        <button
                          onClick={() => setForgetMeConfirm(false)}
                          className="text-sm font-bold text-muted-foreground hover:text-foreground px-2 py-1 rounded transition-colors"
                        >
                          No
                        </button>
                      </div>
                    )
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <Button variant="primary" className="w-full gap-2" onClick={() => { setLocation('/login'); setMobileMenuOpen(false); }}>
                    <LogIn className="w-5 h-5" /> LOGIN / SIGNUP
                  </Button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} />
    </nav>
  );
}
