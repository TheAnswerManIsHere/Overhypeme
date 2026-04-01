import { Navbar } from "./Navbar";
import { AdSlot } from "@/components/AdSlot";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Navbar />
      <main className="flex-1 w-full">
        {children}
      </main>
      {/* Leaderboard ad above footer — hidden for premium users */}
      <div className="w-full max-w-7xl mx-auto px-4 py-4">
        <AdSlot slot={import.meta.env.VITE_ADSENSE_SLOT_LEADERBOARD ?? "0987654321"} format="horizontal" />
      </div>
      <footer className="w-full bg-black border-t border-border py-12 mt-auto">
        <div className="max-w-7xl mx-auto px-4 text-center">
          <div className="font-display text-4xl text-border mb-4 uppercase tracking-widest">The Custom Name Database</div>
          <p className="text-muted-foreground text-sm max-w-md mx-auto">
            The world's most personalized facts database. Enter your name. Become legendary.
          </p>
          <div className="mt-8 text-xs text-border tracking-wider">
            © {new Date().getFullYear()} TCNDB. ALL RIGHTS RESERVED.
          </div>
        </div>
      </footer>
    </>
  );
}
