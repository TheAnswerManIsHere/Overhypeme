import { Navbar } from "./Navbar";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Navbar />
      <main className="flex-1 w-full">
        {children}
      </main>
      <footer className="w-full bg-black border-t border-border py-12 mt-auto">
        <div className="max-w-7xl mx-auto px-4 text-center">
          <div className="font-display text-4xl text-border mb-4 uppercase tracking-widest">Chuck Norris Database</div>
          <p className="text-muted-foreground text-sm max-w-md mx-auto">
            When Chuck Norris builds a web app, the code compiles itself out of fear.
          </p>
          <div className="mt-8 text-xs text-border tracking-wider">
            © {new Date().getFullYear()} CNDB. UNOFFICIAL FAN SITE.
          </div>
        </div>
      </footer>
    </>
  );
}
