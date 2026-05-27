import { useState } from "react";
import {
  PRIMARY_ARCHETYPES,
  SUBTYPES_BY_ARCHETYPE,
  VISUAL_LITERALNESS_VALUES,
  VISUAL_COMPLEXITY_VALUES,
  OVERHYPE_FIT_VALUES,
  ADULT_SUITABILITY_VALUES,
  KNOWN_FACT_MODIFIERS,
  isKnownModifier,
  normalizeHashtag,
  validateEnrichment,
  type FactEnrichment,
  type PrimaryArchetype,
} from "@workspace/api-zod";
import { AlertTriangle, RefreshCw, Save, X } from "lucide-react";

/** Blank scaffold used when an admin fills enrichment manually (AI failed). */
export const EMPTY_ENRICHMENT: FactEnrichment = {
  primaryArchetype: "superhuman_physical_feat",
  subtype: "force_scaled_action",
  modifiers: [],
  visualLiteralness: "literal_dramatization",
  visualComplexity: "medium",
  overhypeFit: "strong",
  adultSuitability: "safe",
  adultSuitabilityNotes: "",
  suggestedHashtags: [],
  taxonomyConfidence: 0,
  adminReviewNotes: "",
};

const SELECT_CLASS =
  "w-full px-3 py-2 bg-background border border-border rounded-sm text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary";
const LABEL_CLASS = "block text-xs font-bold text-muted-foreground uppercase tracking-wide mb-1";

function Warnings({ e }: { e: FactEnrichment }) {
  const warnings: string[] = [];
  if (e.taxonomyConfidence < 0.75) warnings.push("Low confidence — review classification");
  if (e.overhypeFit === "questionable") warnings.push("Check Overhype fit");
  if (e.overhypeFit === "reject") warnings.push("Likely reject or rewrite");
  if (e.adultSuitability === "requires_review") warnings.push("Review adult eligibility");
  if (e.visualComplexity === "high") warnings.push("Hard to visualize");
  const customMods = e.modifiers.filter((m) => !isKnownModifier(m));
  if (customMods.length) warnings.push(`New modifier(s): ${customMods.join(", ")}`);
  if (!warnings.length) return null;
  return (
    <div className="rounded-sm border border-amber-500/40 bg-amber-500/10 p-3 space-y-1">
      {warnings.map((w) => (
        <p key={w} className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {w}
        </p>
      ))}
    </div>
  );
}

function Chips({
  items,
  onRemove,
  known,
}: {
  items: string[];
  onRemove: (item: string) => void;
  known?: (item: string) => boolean;
}) {
  if (!items.length) return <p className="text-xs text-muted-foreground italic">None</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => {
        const isCustom = known ? !known(item) : false;
        return (
          <span
            key={item}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${
              isCustom
                ? "bg-amber-500/15 border-amber-500/40 text-amber-600 dark:text-amber-400"
                : "bg-primary/15 border-primary/40 text-primary"
            }`}
          >
            {item}
            <button type="button" onClick={() => onRemove(item)} className="hover:opacity-70">
              <X className="w-3 h-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** Compact read-only view for already-decided reviews. */
export function EnrichmentSummary({ e }: { e: FactEnrichment }) {
  const rows: [string, string][] = [
    ["Archetype", e.primaryArchetype],
    ["Subtype", e.subtype],
    ["Literalness", e.visualLiteralness],
    ["Complexity", e.visualComplexity],
    ["Overhype fit", e.overhypeFit],
    ["Adult", e.adultSuitability],
    ["Confidence", e.taxonomyConfidence.toFixed(2)],
  ];
  return (
    <div className="rounded-sm border border-border bg-muted/40 p-4 space-y-2">
      <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">Visual Taxonomy Enrichment</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <div key={k}><span className="text-muted-foreground">{k}: </span><span className="text-foreground font-medium">{v}</span></div>
        ))}
      </div>
      {e.modifiers.length > 0 && (
        <p className="text-xs text-muted-foreground">Modifiers: <span className="text-foreground">{e.modifiers.join(", ")}</span></p>
      )}
      {e.suggestedHashtags.length > 0 && (
        <p className="text-xs text-muted-foreground">Hashtags: <span className="text-foreground">{e.suggestedHashtags.join(", ")}</span></p>
      )}
    </div>
  );
}

export function EnrichmentEditor({
  value,
  status,
  onChange,
  onSave,
  onRerun,
  busy = false,
}: {
  value: FactEnrichment | null;
  status: string | null;
  onChange: (next: FactEnrichment) => void;
  onSave?: () => void;
  onRerun?: () => void;
  busy?: boolean;
}) {
  const e = value ?? EMPTY_ENRICHMENT;
  const [modifierInput, setModifierInput] = useState("");
  const [hashtagInput, setHashtagInput] = useState("");

  const update = (patch: Partial<FactEnrichment>) => onChange({ ...e, ...patch });

  const setArchetype = (archetype: PrimaryArchetype) => {
    const allowed = SUBTYPES_BY_ARCHETYPE[archetype];
    const nextSubtype = (allowed as readonly string[]).includes(e.subtype) ? e.subtype : allowed[0];
    onChange({ ...e, primaryArchetype: archetype, subtype: nextSubtype });
  };

  const addModifier = () => {
    const m = modifierInput.trim();
    if (m && !e.modifiers.includes(m)) update({ modifiers: [...e.modifiers, m] });
    setModifierInput("");
  };
  const addHashtag = () => {
    const h = normalizeHashtag(hashtagInput);
    if (h && !e.suggestedHashtags.includes(h)) update({ suggestedHashtags: [...e.suggestedHashtags, h] });
    setHashtagInput("");
  };

  const validity = validateEnrichment(e);
  const subtypeOptions = SUBTYPES_BY_ARCHETYPE[e.primaryArchetype] as readonly string[];

  return (
    <div className="rounded-sm border-2 border-border bg-background p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-foreground uppercase tracking-wide">Visual Taxonomy Enrichment</p>
        <div className="flex items-center gap-2">
          {status && (
            <span className="text-xs text-muted-foreground">
              status: <strong className={status === "failed" ? "text-destructive" : "text-foreground"}>{status}</strong>
            </span>
          )}
          {onRerun && (
            <button
              type="button"
              onClick={onRerun}
              disabled={busy}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
            >
              <RefreshCw className="w-3 h-3" /> Re-run AI
            </button>
          )}
        </div>
      </div>

      {!value && status !== "ok" && (
        <div className="rounded-sm border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          {status === "pending"
            ? "AI enrichment is still running — refresh in a moment, or fill the fields below manually."
            : "No AI enrichment available. Re-run it, or fill the fields below manually before approving."}
        </div>
      )}

      <Warnings e={e} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={LABEL_CLASS}>Primary Archetype</label>
          <select className={SELECT_CLASS} value={e.primaryArchetype} onChange={(ev) => setArchetype(ev.target.value as PrimaryArchetype)}>
            {PRIMARY_ARCHETYPES.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div>
          <label className={LABEL_CLASS}>Subtype</label>
          <select className={SELECT_CLASS} value={e.subtype} onChange={(ev) => update({ subtype: ev.target.value as FactEnrichment["subtype"] })}>
            {subtypeOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className={LABEL_CLASS}>Visual Literalness</label>
          <select className={SELECT_CLASS} value={e.visualLiteralness} onChange={(ev) => update({ visualLiteralness: ev.target.value as FactEnrichment["visualLiteralness"] })}>
            {VISUAL_LITERALNESS_VALUES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className={LABEL_CLASS}>Visual Complexity</label>
          <select className={SELECT_CLASS} value={e.visualComplexity} onChange={(ev) => update({ visualComplexity: ev.target.value as FactEnrichment["visualComplexity"] })}>
            {VISUAL_COMPLEXITY_VALUES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className={LABEL_CLASS}>Overhype Fit</label>
          <select className={SELECT_CLASS} value={e.overhypeFit} onChange={(ev) => update({ overhypeFit: ev.target.value as FactEnrichment["overhypeFit"] })}>
            {OVERHYPE_FIT_VALUES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className={LABEL_CLASS}>Adult Suitability</label>
          <select className={SELECT_CLASS} value={e.adultSuitability} onChange={(ev) => update({ adultSuitability: ev.target.value as FactEnrichment["adultSuitability"] })}>
            {ADULT_SUITABILITY_VALUES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className={LABEL_CLASS}>Adult Suitability Notes</label>
        <textarea
          className={`${SELECT_CLASS} resize-none`}
          rows={2}
          maxLength={500}
          value={e.adultSuitabilityNotes}
          onChange={(ev) => update({ adultSuitabilityNotes: ev.target.value })}
        />
      </div>

      <div>
        <label className={LABEL_CLASS}>Modifiers</label>
        <Chips items={e.modifiers} known={isKnownModifier} onRemove={(m) => update({ modifiers: e.modifiers.filter((x) => x !== m) })} />
        <div className="flex gap-2 mt-2">
          <input
            list="known-modifiers"
            className={SELECT_CLASS}
            placeholder="Add modifier…"
            value={modifierInput}
            onChange={(ev) => setModifierInput(ev.target.value)}
            onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); addModifier(); } }}
          />
          <datalist id="known-modifiers">
            {KNOWN_FACT_MODIFIERS.map((m) => <option key={m} value={m} />)}
          </datalist>
          <button type="button" onClick={addModifier} className="px-3 py-1.5 text-sm border border-border rounded-sm hover:bg-muted text-foreground">Add</button>
        </div>
      </div>

      <div>
        <label className={LABEL_CLASS}>Suggested Hashtags (3–8)</label>
        <Chips items={e.suggestedHashtags} onRemove={(h) => update({ suggestedHashtags: e.suggestedHashtags.filter((x) => x !== h) })} />
        <div className="flex gap-2 mt-2">
          <input
            className={SELECT_CLASS}
            placeholder="Add hashtag…"
            value={hashtagInput}
            onChange={(ev) => setHashtagInput(ev.target.value)}
            onKeyDown={(ev) => { if (ev.key === "Enter") { ev.preventDefault(); addHashtag(); } }}
          />
          <button type="button" onClick={addHashtag} className="px-3 py-1.5 text-sm border border-border rounded-sm hover:bg-muted text-foreground">Add</button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={LABEL_CLASS}>Taxonomy Confidence</label>
          <p className="text-sm text-foreground">{e.taxonomyConfidence.toFixed(2)}</p>
        </div>
      </div>

      <div>
        <label className={LABEL_CLASS}>Admin Review Notes</label>
        <textarea
          className={`${SELECT_CLASS} resize-none`}
          rows={2}
          maxLength={800}
          value={e.adminReviewNotes}
          onChange={(ev) => update({ adminReviewNotes: ev.target.value })}
        />
      </div>

      {!validity.ok && (
        <p className="text-xs text-destructive flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {validity.error}
        </p>
      )}

      {onSave && (
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !validity.ok}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-border rounded-sm hover:bg-muted text-foreground disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" /> Save enrichment
        </button>
      )}
    </div>
  );
}
