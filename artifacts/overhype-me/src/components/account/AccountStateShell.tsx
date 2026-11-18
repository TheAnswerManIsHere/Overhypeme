/**
 * @purpose The centred card the account-state screens share (launch Phase 5): keep-or-delete and suspended, one title and their content, with the legal links beneath (launch Phase 14).
 * @subsystem accounts-auth
 */
import type { ReactNode } from "react";
import { LegalLinks } from "@/components/legal/LegalLinks";

export function AccountStateShell({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-6 p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-xl p-6 sm:p-8 shadow-lg space-y-5 text-center">
        {title && <h1 className="text-3xl font-display uppercase tracking-tight text-foreground">{title}</h1>}
        {children}
      </div>
      <LegalLinks className="text-xs text-muted-foreground" />
    </div>
  );
}
