import { useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Library as LibraryIcon, Settings, Crown, ShieldOff, Eraser, LogOut, User as UserIcon,
} from "lucide-react";

interface AccountMenuProps {
  /** The clickable element rendered as the trigger — almost always the user's avatar. */
  children: ReactNode;
}

interface MenuItemSpec {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
}

async function handleSignOut(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  } catch {
    /* best-effort */
  }
  window.location.replace("/");
}

async function handleForgetMe(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
  } catch {
    /* best-effort */
  }
  localStorage.clear();
  sessionStorage.clear();
  document.cookie.split(";").forEach((c) => {
    document.cookie = c.replace(/^ +/, "").replace(/=.*/, `=;expires=${new Date(0).toUTCString()};path=/`);
  });
  window.location.replace("/");
}

async function handleToggleAdminMode(): Promise<void> {
  try {
    await fetch("/api/auth/toggle-admin-mode", { method: "POST", credentials: "include" });
  } catch {
    /* best-effort */
  }
  window.location.reload();
}

/**
 * Identity-anchored menu opened by tapping the avatar. Renders a Radix
 * dropdown anchored under the trigger on tablet+, or a slide-up bottom sheet
 * on mobile. The avatar is the only entry point — no nav route lives behind
 * it, which is what cleanly separates identity from content destinations.
 */
export function AccountMenu({ children }: AccountMenuProps) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const { role, realRole } = useAuth();
  const [, setLocation] = useLocation();
  const [forgetConfirm, setForgetConfirm] = useState(false);

  const isLegendary = role === "legendary" || role === "admin";
  const isRealAdmin = realRole === "admin";
  const isAdminModeOn = role === "admin";

  function navigate(href: string) {
    setOpen(false);
    setLocation(href);
  }

  const items: MenuItemSpec[] = [
    {
      label: "Library",
      icon: <LibraryIcon className="w-4 h-4" />,
      onSelect: () => navigate("/library"),
    },
    {
      label: "Settings",
      icon: <Settings className="w-4 h-4" />,
      onSelect: () => navigate("/profile"),
    },
  ];
  if (!isLegendary) {
    items.push({
      label: "Upgrade to Legendary",
      icon: <Crown className="w-4 h-4 text-yellow-500" />,
      onSelect: () => navigate("/pricing"),
    });
  }
  if (isRealAdmin && isAdminModeOn) {
    items.push({
      label: "Exit Admin",
      icon: <ShieldOff className="w-4 h-4" />,
      onSelect: () => { setOpen(false); void handleToggleAdminMode(); },
    });
  }
  items.push({
    label: forgetConfirm ? "Confirm: erase everything?" : "Forget Me",
    icon: <Eraser className="w-4 h-4" />,
    destructive: true,
    onSelect: () => {
      if (!forgetConfirm) {
        setForgetConfirm(true);
        return;
      }
      setOpen(false);
      void handleForgetMe();
    },
  });
  items.push({
    label: "Sign out",
    icon: <LogOut className="w-4 h-4" />,
    onSelect: () => { setOpen(false); void handleSignOut(); },
  });

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={(v) => { setOpen(v); if (!v) setForgetConfirm(false); }}>
        <SheetTrigger asChild>{children}</SheetTrigger>
        <SheetContent side="bottom" className="px-0 py-2 max-h-[80vh]">
          <div className="px-4 pb-2 pt-1 text-xs uppercase tracking-widest text-muted-foreground font-display">
            Account
          </div>
          <ul className="flex flex-col">
            {items.map((it, i) => {
              const isSeparatorBefore = it.destructive && i > 0 && !items[i - 1]?.destructive;
              return (
                <li key={it.label}>
                  {isSeparatorBefore && <div className="my-1 mx-4 border-t border-border" />}
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); it.onSelect(); }}
                    className={`w-full flex items-center gap-3 px-4 py-3 text-base font-medium ${
                      it.destructive ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-muted"
                    }`}
                  >
                    <span className="w-5 flex items-center justify-center">{it.icon}</span>
                    {it.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={(v) => { setOpen(v); if (!v) setForgetConfirm(false); }}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {items.map((it, i) => {
          const isSeparatorBefore = it.destructive && i > 0 && !items[i - 1]?.destructive;
          return (
            <div key={it.label}>
              {isSeparatorBefore && <DropdownMenuSeparator />}
              <DropdownMenuItem
                onSelect={(e) => { e.preventDefault(); it.onSelect(); }}
                className={it.destructive ? "text-destructive focus:text-destructive" : ""}
              >
                <span className="mr-2 inline-flex w-4">{it.icon}</span>
                {it.label}
              </DropdownMenuItem>
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Convenient default avatar trigger — renders the user's avatar URL or a generic icon. */
export function AccountMenuAvatarTrigger({ avatarUrl, fallbackInitial }: { avatarUrl: string | null; fallbackInitial?: string }) {
  return (
    <button
      type="button"
      aria-label="Open account menu"
      className="w-8 h-8 rounded-full overflow-hidden ring-1 ring-border flex-shrink-0 inline-flex items-center justify-center bg-secondary"
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt="Profile" className="w-full h-full object-cover" />
      ) : fallbackInitial ? (
        <span className="text-sm font-bold font-display text-foreground">{fallbackInitial}</span>
      ) : (
        <UserIcon className="w-4 h-4 text-muted-foreground" />
      )}
    </button>
  );
}
