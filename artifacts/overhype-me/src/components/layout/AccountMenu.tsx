/**
 * The avatar control in the top-right of the header.
 *
 * This file used to also export an `AccountMenu` dropdown — Edit Profile,
 * Membership, Invite friends, Admin Panel, Exit/Resume Admin, Forget Me,
 * Sign out — but **nothing ever mounted it**. `Navbar` imports only the
 * trigger below and wires it to navigate (`Navbar.tsx:151,223`), so the
 * dropdown was ~200 lines of unreachable UI whose one visible trace was an
 * `ariaLabel` promising a menu that could not open. Profile.tsx's own
 * comment recorded that it never mounted, back at PR #425's round 6.
 *
 * Every item it held is reachable on the Profile page the avatar now opens,
 * with ONE exception recorded on #565: "Invite friends" opened a global
 * `ShareModal` with no fact context, and no other surface offers that. That
 * gap is not created by this deletion — the menu never rendered, so the entry
 * point has been unreachable all along — but it is real and wants a home.
 */

import { useAuth } from "@workspace/replit-auth-web";
import { UserAvatar, type UserAvatarSize } from "@/components/UserAvatar";

/** The user's avatar as a button, with the Legendary decoration applied
 *  automatically from auth state. The caller supplies the click behaviour. */
export function AccountMenuAvatarTrigger({
  avatarUrl,
  fallbackInitial,
  size = "md",
  onClick,
}: {
  avatarUrl: string | null;
  fallbackInitial?: string;
  size?: UserAvatarSize;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
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
      // Says what the button DOES. It previously announced "Open account
      // menu" to screen readers while navigating to Profile, which is the
      // defect this file's deletion exists to close.
      ariaLabel="Open your profile"
      onClick={onClick}
    />
  );
}
