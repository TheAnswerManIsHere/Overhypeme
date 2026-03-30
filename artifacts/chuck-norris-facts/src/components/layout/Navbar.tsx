import { Link, useLocation } from "wouter";
import { Search, Plus, User, LogIn, LogOut, Menu, X } from "lucide-react";
import { useAuth } from "@workspace/replit-auth-web";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

export function Navbar() {
  const { user, isAuthenticated, login, logout } = useAuth();
  const [, setLocation] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      setLocation(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
      setMobileMenuOpen(false);
    }
  };

  return (
    <nav className="sticky top-0 z-50 w-full bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b-2 border-border shadow-lg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-20">
          
          {/* Logo */}
          <Link href="/" className="flex items-center gap-3 shrink-0 group">
            <div className="w-10 h-10 bg-primary rounded-sm flex items-center justify-center transform group-hover:rotate-12 transition-transform duration-300 shadow-[0_0_15px_rgba(249,115,22,0.5)]">
              <img src={`${import.meta.env.BASE_URL}images/logo.png`} alt="Logo" className="w-full h-full object-contain mix-blend-screen" />
            </div>
            <div className="flex flex-col">
              <span className="font-display font-bold text-xl tracking-wider leading-none text-foreground group-hover:text-primary transition-colors">CHUCK NORRIS</span>
              <span className="font-display font-bold text-sm tracking-widest text-primary leading-none">DATABASE</span>
            </div>
          </Link>

          {/* Desktop Search */}
          <div className="hidden md:flex flex-1 max-w-xl mx-8">
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
            <Button variant="outline" size="sm" onClick={() => setLocation('/submit')} className="hidden lg:flex gap-2">
              <Plus className="w-4 h-4" /> SUBMIT FACT
            </Button>
            
            {isAuthenticated ? (
              <div className="flex items-center gap-3">
                <Button variant="ghost" size="icon" onClick={() => setLocation('/profile')}>
                  {user?.profileImageUrl ? (
                    <img src={user.profileImageUrl} alt="Profile" className="w-8 h-8 rounded-sm" />
                  ) : (
                    <User className="w-5 h-5" />
                  )}
                </Button>
                <Button variant="secondary" size="sm" onClick={logout} className="gap-2">
                  <LogOut className="w-4 h-4" /> EXIT
                </Button>
              </div>
            ) : (
              <Button variant="primary" size="sm" onClick={login} className="gap-2 animate-pulse">
                <LogIn className="w-4 h-4" /> LOGIN TO VOTE
              </Button>
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
              <Button variant="outline" className="w-full gap-2" onClick={() => { setLocation('/submit'); setMobileMenuOpen(false); }}>
                <Plus className="w-5 h-5" /> SUBMIT NEW FACT
              </Button>
              {isAuthenticated ? (
                <div className="grid grid-cols-2 gap-4">
                  <Button variant="secondary" className="w-full gap-2" onClick={() => { setLocation('/profile'); setMobileMenuOpen(false); }}>
                    <User className="w-5 h-5" /> PROFILE
                  </Button>
                  <Button variant="danger" className="w-full gap-2" onClick={logout}>
                    <LogOut className="w-5 h-5" /> EXIT
                  </Button>
                </div>
              ) : (
                <Button variant="primary" className="w-full gap-2" onClick={login}>
                  <LogIn className="w-5 h-5" /> LOGIN / SIGNUP
                </Button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
}
