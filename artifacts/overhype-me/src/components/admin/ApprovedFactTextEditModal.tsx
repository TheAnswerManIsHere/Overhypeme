import { useState } from "react";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  APPROVED_FACT_TEXT_EDIT_PHRASE,
  FACT_TEXT_EDIT_REASON_MIN,
  FACT_TEXT_EDIT_REASON_MAX,
  type ApprovedFactTextEditImpact,
} from "@workspace/api-zod";

/**
 * The deliberately-severe confirmation gate for editing an APPROVED fact's
 * text. Shows the old→new wording, the durable consequences (conditional on
 * what actually applies to this fact), and requires the admin to type an exact
 * phrase + a reason before the edit is allowed. Server-enforced regardless —
 * this is the friction + the record of intent, not the security boundary.
 */
export function ApprovedFactTextEditModal({
  impact,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  impact: ApprovedFactTextEditImpact;
  busy: boolean;
  error: string | null;
  onConfirm: (confirmation: { phrase: typeof APPROVED_FACT_TEXT_EDIT_PHRASE; reason: string; expectedOldTextHash: string }) => void;
  onCancel: () => void;
}) {
  const [phrase, setPhrase] = useState("");
  const [reason, setReason] = useState("");

  const phraseOk = phrase === APPROVED_FACT_TEXT_EDIT_PHRASE;
  const reasonOk = reason.trim().length >= FACT_TEXT_EDIT_REASON_MIN && reason.trim().length <= FACT_TEXT_EDIT_REASON_MAX;
  const canConfirm = phraseOk && reasonOk && !busy;

  const consequences: string[] = [];
  if (impact.persistedMemeCount > 0) {
    consequences.push(
      `${impact.liveMemeCount} live meme${impact.liveMemeCount === 1 ? "" : "s"} (${impact.persistedMemeCount} total ever rendered) keep the OLD wording baked into their images — they will not update.`,
    );
  }
  if (impact.isRoot && impact.affectedVariantCount > 0) {
    consequences.push(
      `${impact.affectedVariantCount} variant${impact.affectedVariantCount === 1 ? "" : "s"} were classified against the old wording and will be marked stale for reprocess.`,
    );
  }
  consequences.push("This fact's taxonomy was classified from the old wording; it will be marked stale for reprocess (send it back to review to refresh it).");
  if (impact.refreshInFlight) {
    consequences.push("A refresh is in flight for this fact — this edit will block its promotion until it is re-prepared.");
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" data-testid="approved-fact-text-edit-modal">
      <div className="bg-card border border-destructive/40 rounded-lg w-full max-w-lg p-6 flex flex-col gap-4 shadow-xl max-h-[90svh] overflow-y-auto">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
            <ShieldAlert className="w-5 h-5 text-destructive" />
          </div>
          <div>
            <h2 className="font-display font-bold text-foreground uppercase tracking-wide">Change approved fact text</h2>
            <p className="text-xs text-muted-foreground mt-0.5">A rare, high-consequence action. Read before confirming.</p>
          </div>
        </div>

        {/* old → new diff */}
        <div className="space-y-2">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1">Current (stored)</p>
            <p className="text-sm bg-background border border-border rounded-sm px-3 py-2 whitespace-pre-wrap line-through decoration-destructive/50">{impact.currentStoredText}</p>
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1">New (will be stored)</p>
            <p className="text-sm bg-background border border-primary/40 rounded-sm px-3 py-2 whitespace-pre-wrap">{impact.normalizedProposedText}</p>
          </div>
        </div>

        {/* consequences */}
        <div className="rounded-sm border border-destructive/30 bg-destructive/5 p-3 space-y-1.5">
          {consequences.map((c, i) => (
            <p key={i} className="text-xs text-foreground flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" /> {c}
            </p>
          ))}
        </div>

        {/* phrase + reason */}
        <label className="text-sm text-foreground flex flex-col gap-1">
          <span>Type <code className="font-mono text-destructive">{APPROVED_FACT_TEXT_EDIT_PHRASE}</code> to confirm</span>
          <input
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-sm font-mono focus:outline-none focus:border-destructive"
            data-testid="approved-fact-text-edit-phrase"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="text-sm text-foreground flex flex-col gap-1">
          <span>Reason <span className="text-xs text-muted-foreground">(required, {FACT_TEXT_EDIT_REASON_MIN}–{FACT_TEXT_EDIT_REASON_MAX} chars — recorded in the audit log)</span></span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={FACT_TEXT_EDIT_REASON_MAX}
            placeholder="e.g. the approved wording contained a factual error that must be corrected"
            className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-sm resize-y focus:outline-none focus:border-primary"
            data-testid="approved-fact-text-edit-reason"
          />
        </label>

        {error && <p className="text-xs text-destructive" data-testid="approved-fact-text-edit-error">{error}</p>}

        <div className="flex gap-3">
          <Button
            variant="danger"
            onClick={() => onConfirm({ phrase: APPROVED_FACT_TEXT_EDIT_PHRASE, reason: reason.trim(), expectedOldTextHash: impact.expectedOldTextHash })}
            disabled={!canConfirm}
            isLoading={busy}
            className="flex-1"
            data-testid="approved-fact-text-edit-confirm"
          >
            Change the text
          </Button>
          <Button variant="outline" onClick={onCancel} disabled={busy} className="flex-1">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
