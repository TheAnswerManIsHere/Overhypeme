import { AlertTriangle, Check, Loader2, Undo2 } from "lucide-react";
import { OVERRIDABLE_PATHS, type OverridablePath } from "@workspace/api-zod";

export interface OverrideMarkProps {
  path: OverridablePath;
  /** The current AI baseline value for this field (aiDerived[field]). */
  aiNow: unknown;
  /** The stored override record, when this path is overridden. */
  override?: { value: unknown; overriddenFrom: unknown } | undefined;
  /** True when the AI baseline has changed since the override was created. */
  baselineChanged: boolean;
  /** "full" = AI-vs-Active decoration; "light" = notes (revert only). */
  decoration: "full" | "light";
  /** Live per-field save status (rule: async writes show their own state). */
  status?: "saving" | "error";
  /** Reset this field back to the AI baseline (DELETE the override). */
  onReset: () => void;
  /** Accept the current AI baseline as the new comparison point (keep override). */
  onAcknowledge: () => void;
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length ? `${v.length} item${v.length === 1 ? "" : "s"}` : "(empty)";
  if (typeof v === "object") return "(object)";
  return String(v);
}

/**
 * "Highlight the change, don't show everything twice." Renders nothing when the
 * field is not overridden. When overridden it surfaces the AI value, a revert
 * action, and — when the AI baseline has since changed — a review warning.
 */
export function OverrideMark(props: OverrideMarkProps) {
  const { path, aiNow, override, baselineChanged, decoration, status } = props;
  if (!override) {
    // Not overridden → only ever show a transient save indicator.
    if (status === "saving") return <SaveDot status={status} />;
    return null;
  }

  const isLargeField = Array.isArray(aiNow);

  return (
    <div className="mt-1.5 space-y-1 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center px-1.5 py-0.5 rounded-full font-semibold bg-primary/10 text-primary border border-primary/30">
          overridden
        </span>
        {baselineChanged && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full font-semibold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30">
            <AlertTriangle className="w-3 h-3" /> review — AI changed
          </span>
        )}
        <SaveDot status={status} />
      </div>

      {decoration === "full" && !baselineChanged && (
        <div className="text-muted-foreground">
          {isLargeField ? "AI list differs from the active value." : <>AI: <span className="font-mono">{fmt(aiNow)}</span></>}
        </div>
      )}

      {decoration === "full" && baselineChanged && (
        <div className="text-muted-foreground space-y-0.5">
          <div>AI was: <span className="font-mono">{fmt(override.overriddenFrom)}</span></div>
          <div>AI now: <span className="font-mono text-amber-600 dark:text-amber-400">{fmt(aiNow)}</span></div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button type="button" onClick={props.onReset} className="inline-flex items-center gap-1 text-primary hover:underline">
          <Undo2 className="w-3 h-3" /> Revert to AI
        </button>
        {baselineChanged && (
          <button type="button" onClick={props.onAcknowledge} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline">
            <Check className="w-3 h-3" /> Keep override
          </button>
        )}
        <span className="sr-only">{OVERRIDABLE_PATHS[path].label}</span>
      </div>
    </div>
  );
}

function SaveDot({ status }: { status?: "saving" | "error" }) {
  if (status === "saving") {
    return <span className="inline-flex items-center gap-1 text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" /> saving…</span>;
  }
  if (status === "error") {
    return <span className="inline-flex items-center gap-1 text-destructive"><AlertTriangle className="w-3 h-3" /> save failed</span>;
  }
  return null;
}
