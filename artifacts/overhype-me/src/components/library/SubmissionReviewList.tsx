/**
 * @purpose The submitter's own not-yet-live submissions in their Library: those still in moderation under Under Review, and declined ones under Declined with the reason's readable label and the moderator's note, the details the rejection email carries.
 * @subsystem public-site
 */
import { useId } from "react";
import { Clock, XCircle } from "lucide-react";
import type { PendingSubmission } from "@workspace/api-client-react";
import { REJECTION_REASON_LABELS, type RejectionReason } from "@workspace/api-zod";

function reasonLabel(reason: string): string {
  return REJECTION_REASON_LABELS[reason as RejectionReason] ?? reason;
}

function SubmissionCard({ sub }: { sub: PendingSubmission }) {
  const declined = sub.status === "rejected";
  return (
    <div className={`bg-card border-2 rounded-sm p-4 space-y-2 ${declined ? "border-destructive/40" : "border-border"}`}>
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-sm border ${
          sub.status === "pending"
            ? "bg-amber-500/10 text-amber-400 border-amber-500/40"
            : declined
            ? "bg-destructive/10 text-destructive border-destructive/40"
            : "bg-green-500/10 text-green-400 border-green-500/40"
        }`}>
          {sub.status === "pending" ? "Pending Review" : declined ? "Declined" : sub.status}
        </span>
        <span className="text-xs text-muted-foreground">{new Date(sub.createdAt).toLocaleDateString()}</span>
      </div>
      <p className="text-foreground text-sm leading-relaxed">{sub.text}</p>
      {sub.hashtags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {sub.hashtags.map((tag) => (
            <span key={tag} className="text-[10px] text-primary/70 font-bold uppercase tracking-wider">#{tag}</span>
          ))}
        </div>
      )}
      {declined && (sub.reason || sub.adminNote) && (
        <div className="text-xs text-muted-foreground border-t border-border/50 pt-2 mt-2 space-y-1">
          {sub.reason && (
            <p>
              <span className="font-bold text-destructive/80">Reason:</span> <span>{reasonLabel(sub.reason)}</span>
            </p>
          )}
          {sub.adminNote && (
            <p className="whitespace-pre-line">
              <span className="font-bold text-destructive/80">Note from the team:</span> <span>{sub.adminNote}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, icon, submissions }: { title: string; icon: React.ReactNode; submissions: PendingSubmission[] }) {
  const headingId = useId();
  if (submissions.length === 0) return null;
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className="font-display text-base uppercase tracking-wider text-muted-foreground mb-4 flex items-center gap-2">
        {icon} {title}
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {submissions.map((sub) => <SubmissionCard key={sub.id} sub={sub} />)}
      </div>
    </section>
  );
}

export function SubmissionReviewList({ submissions }: { submissions: PendingSubmission[] }) {
  const declined = submissions.filter((s) => s.status === "rejected");
  const inReview = submissions.filter((s) => s.status !== "rejected");
  return (
    <>
      <Section title="Under Review" icon={<Clock className="w-4 h-4" />} submissions={inReview} />
      <Section title="Declined" icon={<XCircle className="w-4 h-4 text-destructive" />} submissions={declined} />
    </>
  );
}
