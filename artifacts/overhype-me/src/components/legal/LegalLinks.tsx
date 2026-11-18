/**
 * @purpose The four legal-page links (launch Phase 14, increment 1), in the one order the footer, sign-up and onboarding all show them.
 * @subsystem public-site
 */
import { Link } from "wouter";
import { LEGAL_DOCS } from "@/generated/legal";

export function LegalLinks({ className = "" }: { className?: string }) {
  return (
    <nav aria-label="Legal" className={className}>
      <ul className="flex flex-wrap justify-center gap-x-5 gap-y-2">
        {LEGAL_DOCS.map((doc) => (
          <li key={doc.slug}>
            <Link href={`/${doc.slug}`} className="hover:text-primary underline-offset-4 hover:underline">
              {doc.title}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** One line under a sign-up or set-up form; it informs, it does not record acceptance (increment 4 does). */
export function LegalNotice() {
  return (
    <p className="text-xs text-muted-foreground text-center">
      Overhype.me is for adults. Read our{" "}
      <Link href="/terms" className="underline hover:text-primary">Terms</Link>,{" "}
      <Link href="/privacy" className="underline hover:text-primary">Privacy Policy</Link> and{" "}
      <Link href="/guidelines" className="underline hover:text-primary">Community Guidelines</Link>.
    </p>
  );
}
