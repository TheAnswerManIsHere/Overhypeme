import { type ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  getFieldDoc,
  type FieldDocKey,
} from "./fieldDocs";
import type { FieldDoc, FieldEffectClass, StaleBehavior, WorkedExample } from "./fieldDocs/types";

/**
 * The admin field-documentation surface: an Info icon beside a field label that
 * opens a PERSISTENT, SCROLLABLE popover (tap-to-open — David reviews on iPad,
 * so hover-only is useless) with the field's full documentation from the
 * fieldDocs registry: what it is, how the AI derives it, how it affects the
 * render, every dropdown value's meaning, and worked examples.
 *
 * Layering: the review modal is a fixed z-50 overlay, so the portaled popover
 * content uses z-[70]. Outside-tap on the modal's dark backdrop must close ONLY
 * the popover — the backdrop's own onClick would also close the whole modal, so
 * we stop the outside-pointerdown event from reaching it.
 */

// Label styling — single home for the admin field-label classes (moved from
// EnrichmentEditor's local LABEL_CLASS so FieldLabel and legacy sites share it).
export const ADMIN_LABEL_CLASS_NO_MB =
  "block text-xs font-bold text-muted-foreground uppercase tracking-wide";
export const ADMIN_LABEL_CLASS = `${ADMIN_LABEL_CLASS_NO_MB} mb-1`;

/**
 * When a Radix outside-pointerdown that dismisses the popover lands on the
 * review modal's dark backdrop, close ONLY the popover — the backdrop's own
 * onClick={onClose} would otherwise also close the whole modal. We can't stop
 * the pointerdown (the closing click is a separate later event), so we install
 * a one-shot capture-phase click swallow.
 *
 * The check is `matches`, NOT `closest`: the modal card (and every control in
 * it) is a DESCENDANT of the overlay div, so `closest` would also swallow the
 * click of any in-modal control tapped to dismiss the popover — forcing a
 * double-tap. Only a tap on the backdrop element itself (the dark area around
 * the card) arms the swallow. Exported so the behavior is unit-testable without
 * relying on Radix's (jsdom-unsupported) synthetic outside-pointerdown detection.
 */
export function guardModalOverlayDismiss(target: Element | null | undefined): void {
  if (target?.matches?.("[data-modal-overlay]")) {
    window.addEventListener("click", (ce) => ce.stopPropagation(), { capture: true, once: true });
  }
}

const EFFECT_BADGE: Record<FieldEffectClass, { text: string; cls: string }> = {
  "render-affecting": {
    text: "Feeds the render pipeline",
    cls: "bg-primary/10 text-primary",
  },
  "advisory-only": {
    text: "Advisory to the AI planner — no fixed directive",
    cls: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  },
  "gating-only": {
    text: "Gating only — never rendered",
    cls: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  "product-metadata": {
    text: "Ships with the fact — no render effect",
    cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  "human-only": {
    text: "Admin-only — never leaves this screen",
    cls: "bg-muted text-muted-foreground",
  },
};

const STALE_BADGE: Record<StaleBehavior, string | null> = {
  "marks-render-stale": "Editing re-flags test renders as stale",
  "does-not-mark-render-stale": "Editing does NOT re-flag test renders",
  "not-applicable": null,
};

function Paragraphs({ heading, paras }: { heading: string; paras: string[] }) {
  if (paras.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{heading}</p>
      {paras.map((p, i) => (
        <p key={i} className="text-xs leading-relaxed text-foreground">
          {p}
        </p>
      ))}
    </div>
  );
}

function Examples({ examples }: { examples: WorkedExample[] }) {
  if (examples.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Examples</p>
      {examples.map((ex, i) => (
        <div key={i} className="rounded-sm border border-border bg-muted/30 p-2 space-y-0.5">
          <p className="text-[11px] text-foreground">{ex.scenario}</p>
          <p className="text-[11px] font-mono text-primary break-words">{ex.input}</p>
          <p className="text-[11px] text-muted-foreground">{ex.outcome}</p>
        </div>
      ))}
    </div>
  );
}

function Values({ doc }: { doc: FieldDoc }) {
  if (!doc.values || doc.values.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
        Values ({doc.values.length})
      </p>
      <dl className="space-y-2">
        {doc.values.map(({ value, doc: v }) => (
          <div key={value} className="border-l-2 border-border pl-2 space-y-0.5">
            <dt className="text-[11px] font-mono font-semibold text-foreground">
              {value}
              {v.authoredStatus === "authored-needs-david-review" && (
                <span className="ml-1.5 rounded-sm bg-amber-500/15 px-1 py-px text-[9px] font-sans font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                  authored — verify
                </span>
              )}
            </dt>
            <dd className="text-[11px] leading-snug text-foreground">{v.meaning}</dd>
            <dd className="text-[11px] leading-snug text-muted-foreground">
              <span className="font-semibold">Render:</span> {v.renderImpact}
            </dd>
            <dd className="text-[11px] leading-snug text-muted-foreground italic">{v.example}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function FieldInfo({ docKey, className }: { docKey: FieldDocKey; className?: string }) {
  const doc = getFieldDoc(docKey);
  const effect = EFFECT_BADGE[doc.effect];
  const stale = STALE_BADGE[doc.staleBehavior];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`About ${doc.label}`}
          data-testid={`field-info-${docKey}`}
          // p-1 -m-1 grows the tap target without shifting layout (iPad).
          className={cn(
            "p-1 -m-1 text-muted-foreground hover:text-foreground focus-visible:text-foreground shrink-0",
            className,
          )}
        >
          <Info className="w-3.5 h-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        collisionPadding={12}
        // z-[70]: above the review modal's fixed z-50 overlay. Scrollable +
        // persistent: stays open until Escape / outside tap / trigger re-tap.
        className="z-[70] w-96 max-w-[90vw] max-h-[70vh] overflow-y-auto"
        data-testid={`field-info-content-${docKey}`}
        // Close only the popover (not the whole review modal) when the
        // dismissing tap lands on the modal backdrop — see guardModalOverlayDismiss.
        onPointerDownOutside={(e) =>
          guardModalOverlayDismiss(e.detail.originalEvent.target as Element | null)
        }
      >
        <div className="space-y-3">
          <div>
            <p className="text-sm font-bold text-foreground">
              {doc.label}
              {doc.labelSuffix && (
                <span className="ml-1 font-normal text-muted-foreground">{doc.labelSuffix}</span>
              )}
            </p>
            <p className="text-xs text-muted-foreground leading-snug">{doc.hint}</p>
          </div>

          <Paragraphs heading="What it is" paras={doc.whatItIs} />
          <Paragraphs heading="How the AI sets it" paras={doc.howDerived} />
          <Paragraphs heading="How it affects the render" paras={doc.renderImpact} />
          <Values doc={doc} />
          <Examples examples={doc.workedExamples} />

          <div className="flex flex-wrap gap-1.5 border-t border-border pt-2">
            <span className={cn("rounded-sm px-1.5 py-0.5 text-[10px] font-semibold", effect.cls)}>
              {effect.text}
            </span>
            {stale && (
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                {stale}
              </span>
            )}
            {doc.authoredStatus === "authored-needs-david-review" && (
              <span className="rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                Authored from code behavior — spot-check requested
              </span>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Label + info icon, with the label TEXT sourced from the registry (the naming
 * pass edits the registry, and every site updates). The info button is a
 * SIBLING of <label>, never a child — a button inside a label would receive
 * label-forwarded clicks and toggle the field's control.
 */
export function FieldLabel({
  docKey,
  className,
  right,
}: {
  docKey: FieldDocKey;
  className?: string;
  right?: ReactNode;
}) {
  const doc = getFieldDoc(docKey);
  return (
    <div className={cn("mb-1 flex items-center gap-1", className)}>
      <label className={ADMIN_LABEL_CLASS_NO_MB}>
        {doc.label}
        {doc.labelSuffix && <span className="normal-case font-normal"> {doc.labelSuffix}</span>}
      </label>
      <FieldInfo docKey={docKey} />
      {right != null && <div className="ml-auto">{right}</div>}
    </div>
  );
}
