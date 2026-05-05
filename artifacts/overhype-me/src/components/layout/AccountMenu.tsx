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
import { ShareModal } from "@/components/ShareModal";
import { UserAvatar, type UserAvatarSize } from "@/components/UserAvatar";
import {
  Pencil, Crown, ShieldCheck, ShieldOff, Eraser, LogOut, UserPlus,
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
  /** Items below the separator (admin tools + sign out). */
  group?: "primary" | "footer";
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
  const [shareOpen, setShareOpen] = useState(false);
  const { realRole, role } = useAuth();
  const [, setLocation] = useLocation();
  const [forgetConfirm, setForgetConfirm] = useState(false);

  const isRealAdmin = realRole === "admin";
  const isAdminModeOn = role === "admin";

  function navigate(href: string) {
    setOpen(false);
    setLocation(href);
  }

  const items: MenuItemSpec[] = [
    {
      label: "Edit Profile",
      icon: <Pencil className="w-4 h-4" />,
      onSelect: () => navigate("/profile"),
      group: "primary",
    },
    {
      label: "Membership",
      icon: <Crown className="w-4 h-4" />,
      onSelect: () => navigate("/pricing"),
      group: "primary",
    },
    {
      label: "Invite friends",
      icon: <UserPlus className="w-4 h-4" />,
      onSelect: () => { setOpen(false); setShareOpen(true); },
      group: "primary",
    },
  ];

  // Admin-only tools live with sign-out below the separator. Hidden entirely
  // for normal users so the menu stays at exactly 4 items for them.
  if (isRealAdmin) {
    if (isAdminModeOn) {
      items.push({
        label: "Admin Panel",
        icon: <ShieldCheck className="w-4 h-4 text-primary" />,
        onSelect: () => navigate("/admin"),
        group: "footer",
      });
      items.push({
        label: "Exit Admin",
        icon: <ShieldOff className="w-4 h-4" />,
        onSelect: () => { setOpen(false); void handleToggleAdminMode(); },
        group: "footer",
      });
    }
    items.push({
      label: forgetConfirm ? "Confirm: erase everything?" : "Forget Me",
      icon: <Eraser className="w-4 h-4" />,
      destructive: true,
      group: "footer",
      onSelect: () => {
        if (!forgetConfirm) {
          setForgetConfirm(true);
          return;
        }
        setOpen(false);
        void handleForgetMe();
      },
    });
  }

  items.push({
    label: "Sign out",
    icon: <LogOut className="w-4 h-4" />,
    onSelect: () => { setOpen(false); void handleSignOut(); },
    group: "footer",
  });

  // Insert a separator marker between groups for the renderer.
  const firstFooterIndex = items.findIndex((it) => it.group === "footer");

  function renderItems(variant: "sheet" | "dropdown") {
    return items.map((it, i) => {
      const showSeparator = i === firstFooterIndex && firstFooterIndex > 0;
      if (variant === "sheet") {
        return (
          <li key={it.label}>
            {showSeparator && <div className="my-1 mx-4 border-t border-border" />}
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
      }
      return (
        <div key={it.label}>
          {showSeparator && <DropdownMenuSeparator />}
          <DropdownMenuItem
            onSelect={(e) => { e.preventDefault(); it.onSelect(); }}
            className={it.destructive ? "text-destructive focus:text-destructive" : ""}
          >
            <span className="mr-2 inline-flex w-4">{it.icon}</span>
            {it.label}
          </DropdownMenuItem>
        </div>
      );
    });
  }

  const trigger = (
    <>
      {isMobile ? (
        <Sheet open={open} onOpenChange={(v) => { setOpen(v); if (!v) setForgetConfirm(false); }}>
          <SheetTrigger asChild>{children}</SheetTrigger>
          <SheetContent side="bottom" className="px-0 py-2 max-h-[80vh]">
            <div className="px-4 pb-2 pt-1 text-xs uppercase tracking-widest text-muted-foreground font-display">
              Account
            </div>
            <ul className="flex flex-col">{renderItems("sheet")}</ul>
          </SheetContent>
        </Sheet>
      ) : (
        <DropdownMenu open={open} onOpenChange={(v) => { setOpen(v); if (!v) setForgetConfirm(false); }}>
          <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {renderItems("dropdown")}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} />
    </>
  );

  return trigger;
}

/** Convenient default avatar trigger — renders the user's avatar with the
 *  Legendary decoration applied automatically based on auth state. */
export function AccountMenuAvatarTrigger({
  avatarUrl,
  fallbackInitial,
  size = "md",
}: {
  avatarUrl: string | null;
  fallbackInitial?: string;
  size?: UserAvatarSize;
}) {
  const { role } = useAuth();
  const isLegendary = role === "legendary" || role === "admin";
  return (
    <UserAvatar
      as="button"
      avatarUrl={avatarUrl}
      fallbackInitial={fallbackInitial}
      isLegendary={isLegendary}
      size={size}
      ariaLabel="Open account menu"
    />
  );
}
