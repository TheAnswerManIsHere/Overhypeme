import { useLocation } from "wouter";
import { Home, Trophy, Library as LibraryIcon } from "lucide-react";

const DESTINATIONS = [
  { href: "/",          label: "Facts",     Icon: Home        },
  { href: "/top-facts", label: "Top Facts", Icon: Trophy      },
  { href: "/library",   label: "Library",   Icon: LibraryIcon },
] as const;

function isActive(location: string, href: string): boolean {
  if (href === "/")          return location === "/";
  if (href === "/top-facts") return location === "/top-facts" || location === "/hall-of-fame";
  if (href === "/library")   return location.startsWith("/library");
  return location.startsWith(href);
}

function go(href: string) {
  window.history.pushState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Unified primary nav for the three top-level destinations: Facts, Top Facts,
 * Library. Renders as a fixed bottom tab bar on mobile and a horizontal row
 * directly under the top bar at tablet and above. The Library icon is a
 * content-style icon (stack/grid) and never an avatar — that visual signal
 * is what separates content destinations from identity (the avatar opens
 * the AccountMenu; it never navigates).
 */
export function PrimaryNav() {
  const [location] = useLocation();

  return (
    <>
      {/* Tablet+ horizontal row, sits beneath the top header */}
      <div className="hidden md:flex sticky top-16 z-40 w-full bg-background/95 backdrop-blur border-b border-border">
        <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-1 h-11">
            {DESTINATIONS.map(({ href, label, Icon }) => {
              const active = isActive(location, href);
              return (
                <a
                  key={href}
                  href={href}
                  onClick={(e) => { e.preventDefault(); go(href); }}
                  className={`inline-flex items-center gap-2 h-9 px-4 rounded-sm font-display text-sm uppercase tracking-wider transition-colors ${
                    active ? "text-primary" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="w-4 h-4" strokeWidth={active ? 2.4 : 1.8} />
                  {label}
                  {active && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-primary" />}
                </a>
              );
            })}
          </div>
        </div>
      </div>

      {/* Mobile fixed bottom tab bar */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-background/95 backdrop-blur border-t border-border flex items-stretch"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        {DESTINATIONS.map(({ href, label, Icon }) => {
          const active = isActive(location, href);
          return (
            <a
              key={href}
              href={href}
              onClick={(e) => { e.preventDefault(); go(href); }}
              className="flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 min-h-[56px] relative"
            >
              <Icon
                className={`w-6 h-6 transition-colors ${active ? "text-foreground" : "text-muted-foreground"}`}
                strokeWidth={active ? 2.2 : 1.8}
              />
              <span className={`text-[9px] font-semibold tracking-wide transition-colors leading-tight text-center ${active ? "text-foreground" : "text-muted-foreground"}`}>
                {label}
              </span>
              {active && <span className="absolute top-1.5 w-1 h-1 rounded-full bg-primary" />}
            </a>
          );
        })}
      </nav>
    </>
  );
}
