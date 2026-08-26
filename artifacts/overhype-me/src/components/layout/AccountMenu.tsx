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
 * Five of its seven items are on the Profile page the avatar now opens, in
 * BOTH the desktop and mobile action blocks: Edit Profile, Admin Panel,
 * Exit/Resume Admin, Forget Me, Sign Out. The other two are not universally
 * reachable, and neither gap is created by this deletion — the menu never
 * rendered, so both have been unreachable all along. Recorded on #565:
 *
 *   - **Membership** (`/pricing`) is on Profile's DESKTOP block only, behind
 *     `!isLegendaryMember` — so an existing Legendary member has no link on
 *     desktop, and no one has one below the `md` breakpoint at all.
 *   - **Invite friends** opened a global `ShareModal` with no fact context.
 *     No other surface offers that; `FactActionCluster` mounts the same modal
 *     but only ever to share one fact.
 *
 * Do not read this file as saying every former destination is exposed on
 * Profile. It is not, and an earlier revision of this comment said so
 * wrongly. (Codex, #576 round 1.)
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
