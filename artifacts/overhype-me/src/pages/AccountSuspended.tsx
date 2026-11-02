/**
 * @purpose The screen a suspended account is sent to (launch Phase 5, plan *Suspension*): it says the account is suspended, never why (the reason is admins' only), and offers the one thing a suspended account can do, sign out.
 * @subsystem accounts-auth
 */
import { useSignOut } from "@/hooks/use-sign-out";
import { Button } from "@/components/ui/Button";

export default function AccountSuspended() {
  const signOut = useSignOut();
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-xl p-6 sm:p-8 shadow-lg space-y-5 text-center">
        <h1 className="text-3xl font-display uppercase tracking-tight text-foreground">This account is suspended</h1>
        <p className="text-muted-foreground text-sm">While it is suspended you can't sign in, post, vote or make memes.</p>
        <Button onClick={() => void signOut()} className="w-full">Sign out</Button>
      </div>
    </div>
  );
}
