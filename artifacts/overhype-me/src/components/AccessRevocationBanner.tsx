import { useState, useEffect } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import { AlertTriangle, X, Mail } from "lucide-react";

const SUPPORT_EMAIL = "overhypeme+support@gmail.com";

type RevocationKind = "refund" | "dispute_opened" | "dispute_lost";
type Notice = { kind: RevocationKind; occurredAt: string } | null;

function describeNotice(kind: RevocationKind): string {
  switch (kind) {
    case "refund":
      return "Your Legendary membership was refunded, so Legendary features are no longer available on this account.";
    case "dispute_opened":
      return "A payment dispute was opened on your Legendary purchase, so Legendary features are paused while the dispute is reviewed.";
    case "dispute_lost":
      return "A payment dispute on your Legendary purchase was finalized, so Legendary features are no longer available on this account.";
  }
}

function dismissalKey(kind: RevocationKind, occurredAt: string) {
  return `revocation-notice-dismissed:${kind}:${occurredAt}`;
}

export function AccessRevocationBanner() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [notice, setNotice] = useState<Notice>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!isAuthenticated || authLoading) return;
    let cancelled = false;
    fetch("/api/stripe/access-revocation-notice", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { notice: Notice };
        if (cancelled) return;
        setNotice(data.notice ?? null);
        if (data.notice) {
          try {
            const key = dismissalKey(data.notice.kind, data.notice.occurredAt);
            if (sessionStorage.getItem(key) === "1") setDismissed(true);
          } catch {
            // sessionStorage unavailable (private mode) — ignore.
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, authLoading]);

  if (!isAuthenticated || authLoading || !notice || dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(dismissalKey(notice.kind, notice.occurredAt), "1");
    } catch {
      // ignore
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full bg-orange-500/10 border-b border-orange-500/30 px-4 py-2.5"
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <AlertTriangle className="w-4 h-4 text-orange-500 shrink-0" />
          <p className="text-sm text-orange-700 dark:text-orange-400 truncate">
            <span className="font-semibold">Membership update:</span>{" "}
            {describeNotice(notice.kind)}{" "}
            <a
              href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Membership access question")}`}
              className="inline-flex items-center gap-1 underline hover:no-underline font-semibold"
            >
              <Mail className="w-3 h-3" />
              Contact support
            </a>
          </p>
        </div>
        <button
          onClick={handleDismiss}
          className="text-orange-500 hover:text-orange-700 dark:hover:text-orange-300 shrink-0"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
