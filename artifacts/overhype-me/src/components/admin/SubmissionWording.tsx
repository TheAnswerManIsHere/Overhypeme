/**
 * @purpose A submission's wording on the moderation screen: editable at triage, locked from acceptance on, with Withdraw for a submission whose wording needs replacing.
 * @subsystem moderation
 *
 * Plan docs/plans/PLAN_THREE_GAGS.md, increment 3, section G (David,
 * 2026-11-14, Q5 and Q6). At triage the moderator may correct the wording
 * before it is accepted; acceptance locks it for good. Past triage, a
 * first-time submission whose wording needs replacing is withdrawn, and the
 * corrected wording is submitted as a new fact.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Lock } from "lucide-react";
import { SUBMISSION_TEXT_MAX_CHARS } from "@workspace/api-zod";
import type { DuplicateView } from "./DuplicateVerdict";

export interface WordingSaved {
  submittedText: string;
  submittedTextOriginal: string | null;
  /** The new wording's duplicate verdict, replaced with the wording. */
  duplicate: DuplicateView;
}

interface Props {
  reviewId: number;
  text: string;
  /** The wording as the submitter sent it, when a moderator has since edited it. */
  originalText: string | null;
  /** At triage, before acceptance: the wording may still change. */
  editable: boolean;
  /** Past triage, before production approval, first-time only. */
  withdrawable: boolean;
  label: string;
  onSaved: (saved: WordingSaved) => void;
  /** An unsaved wording edit is in the box: acceptance waits for it. */
  onDirtyChange: (dirty: boolean) => void;
  /** Withdraw resolved the review; the caller closes the screen. */
  onWithdrawn: () => void;
}

async function post(url: string, body: unknown): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  try {
    const r = await fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    return r.ok ? { ok: true, data } : { ok: false, message: data.error ?? `Request failed (${r.status})` };
  } catch {
    return { ok: false, message: "Network error — could not reach the server." };
  }
}

export function SubmissionWording({ reviewId, text, originalText, editable, withdrawable, label, onSaved, onDirtyChange, onWithdrawn }: Props) {
  const [value, setValue] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmingWithdraw, setConfirmingWithdraw] = useState(false);
  const [withdrawNote, setWithdrawNote] = useState("");
  const changed = editable && value.trim() !== text;
  useEffect(() => { onDirtyChange(changed); }, [changed, onDirtyChange]);

  const save = async () => {
    setBusy(true); setError("");
    const r = await post(`/api/admin/reviews/${reviewId}/wording`, { text: value });
    setBusy(false);
    if (!r.ok) { setError(r.message); return; }
    const saved = r.data as WordingSaved;
    setValue(saved.submittedText);
    onSaved(saved);
  };

  const withdraw = async () => {
    setBusy(true); setError("");
    const r = await post(`/api/admin/reviews/${reviewId}/withdraw`, { note: withdrawNote.trim() || undefined });
    setBusy(false);
    if (!r.ok) { setError(r.message); return; }
    onWithdrawn();
  };

  return (
    <div className="bg-background border-2 border-border rounded-sm p-4 space-y-3" data-testid="submission-wording">
      <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">{label}</p>
      {editable ? (
        <>
          <textarea
            data-testid="submission-wording-input"
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(""); }}
            // Locked while a save is in flight, so nothing typed meanwhile is
            // overwritten by the saved wording.
            readOnly={busy}
            aria-busy={busy}
            rows={3}
            maxLength={SUBMISSION_TEXT_MAX_CHARS}
            className="w-full px-3 py-2 bg-background border border-border rounded-sm text-base italic text-foreground focus:outline-none focus:ring-2 focus:ring-primary resize-none"
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Correct the wording here before accepting it. Once accepted, the wording is locked for good.
            </p>
            <div className="flex gap-2 shrink-0">
              <button
                type="button"
                disabled={!changed || busy}
                onClick={() => { setValue(text); setError(""); }}
                className="text-xs px-3 py-1.5 rounded-sm border border-border disabled:opacity-40"
              >
                Undo
              </button>
              <button
                type="button"
                data-testid="submission-wording-save"
                disabled={!changed || busy}
                onClick={() => void save()}
                className="text-xs px-3 py-1.5 rounded-sm bg-primary text-primary-foreground font-semibold disabled:opacity-40 flex items-center gap-1"
              >
                {busy && <Loader2 className="w-3 h-3 animate-spin" />} Save wording
              </button>
            </div>
          </div>
          {changed && (
            <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="submission-wording-unsaved">
              Unsaved wording — save or undo it before accepting.
            </p>
          )}
        </>
      ) : (
        <>
          <p className="text-base italic text-foreground leading-relaxed">"{text}"</p>
          <p className="text-xs text-muted-foreground flex items-center gap-1.5" data-testid="submission-wording-locked">
            <Lock className="w-3 h-3 shrink-0" /> The wording can only be changed at triage, before a submission is accepted.
            {withdrawable && " If it needs replacing, withdraw the submission and submit the corrected wording as a new fact."}
          </p>
        </>
      )}
      {originalText != null && originalText !== text && (
        <p className="text-xs text-muted-foreground" data-testid="submission-wording-original">
          As submitted: <span className="italic">"{originalText}"</span>
        </p>
      )}

      {withdrawable && !editable && (
        confirmingWithdraw ? (
          <div className="rounded-sm border border-destructive/40 bg-destructive/5 p-3 space-y-2" data-testid="submission-withdraw-confirm">
            <p className="text-xs text-destructive flex items-center gap-1.5 font-semibold">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> This ends the submission for good. It can't be resubmitted; the corrected wording is submitted as a new fact.
            </p>
            <textarea
              value={withdrawNote}
              onChange={(e) => setWithdrawNote(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="What needs replacing (optional, internal)"
              className="w-full px-3 py-2 bg-background border border-border rounded-sm text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none"
            />
            <div className="flex gap-2 justify-end">
              <button type="button" disabled={busy} onClick={() => setConfirmingWithdraw(false)} className="text-xs px-3 py-1.5 rounded-sm border border-border">
                Cancel
              </button>
              <button
                type="button"
                data-testid="submission-withdraw-confirm-button"
                disabled={busy}
                onClick={() => void withdraw()}
                className="text-xs px-3 py-1.5 rounded-sm bg-destructive text-destructive-foreground font-semibold disabled:opacity-40 flex items-center gap-1"
              >
                {busy && <Loader2 className="w-3 h-3 animate-spin" />} Withdraw for good
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            data-testid="submission-withdraw"
            onClick={() => setConfirmingWithdraw(true)}
            className="text-xs px-3 py-1.5 rounded-sm border border-destructive/50 text-destructive hover:bg-destructive/10"
          >
            Withdraw: wording needs replacing
          </button>
        )
      )}
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    </div>
  );
}
