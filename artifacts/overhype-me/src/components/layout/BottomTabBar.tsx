import { useLocation } from "wouter";
import { Home, Smile, Trophy, User } from "lucide-react";

const TABS = [
  { href: "/",            label: "Feed",       Icon: Home  },
  { href: "/hall-of-fame",label: "Meme",       Icon: Smile },
  { href: "/hall-of-fame",label: "Hall",        Icon: Trophy },
  { href: "/profile",     label: "Me",         Icon: User  },
] as const;

export function BottomTabBar() {
  const [location] = useLocation();

  function isActive(href: string, label: string) {
    if (label === "Feed") return location === "/";
    if (label === "Hall") return location === "/hall-of-fame";
    if (label === "Meme") return false; // never "active" — always navigates to HOF
    if (label === "Me")   return location.startsWith("/profile");
    return location.startsWith(href);
  }

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-background/95 backdrop-blur border-t border-border flex items-stretch"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
      {TABS.map(({ href, label, Icon }) => {
        const active = isActive(href, label);
        return (
          <a
            key={label}
            href={href}
            onClick={e => {
              e.preventDefault();
              window.history.pushState({}, "", href);
              window.dispatchEvent(new PopStateEvent("popstate"));
            }}
            className="flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 min-h-[56px] relative"
          >
            <Icon
              className={`w-6 h-6 transition-colors ${active ? "text-foreground" : "text-muted-foreground"}`}
              strokeWidth={active ? 2.2 : 1.8}
            />
            <span className={`text-[10px] font-semibold tracking-wide transition-colors ${active ? "text-foreground" : "text-muted-foreground"}`}>
              {label}
            </span>
            {active && (
              <span className="absolute top-1.5 w-1 h-1 rounded-full bg-primary" />
            )}
          </a>
        );
      })}
    </nav>
  );
}
