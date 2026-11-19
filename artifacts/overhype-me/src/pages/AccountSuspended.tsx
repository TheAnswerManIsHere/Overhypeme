/**
 * @purpose The screen a suspended account is sent to (launch Phase 5, plan *Suspension*): it says the account is suspended, never why (the reason is admins' only), and offers what a suspended account can still do: contact support (Phase 16, increment 5) and sign out.
 * @subsystem accounts-auth
 */
import { Link } from "wouter";
import { useSignOut } from "@/hooks/use-sign-out";
import { Button } from "@/components/ui/Button";
import { AccountStateShell } from "@/components/account/AccountStateShell";

export default function AccountSuspended() {
  const signOut = useSignOut();
  return (
    <AccountStateShell title="This account is suspended">
      <p className="text-muted-foreground text-sm">While it is suspended you can't sign in, post, vote or make memes.</p>
      <p className="text-sm text-muted-foreground">
        Think this is a mistake? <Link href="/support?category=account" className="underline hover:text-primary" data-testid="suspended-support">Contact support</Link>.
      </p>
      <Button onClick={() => void signOut()} className="w-full">Sign out</Button>
    </AccountStateShell>
  );
}
