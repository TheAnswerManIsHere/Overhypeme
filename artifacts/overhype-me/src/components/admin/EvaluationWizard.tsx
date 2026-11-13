/**
 * @purpose The Eval page's wizard: choose facts by search, then engines (or one engine's wording versions), photo types and looks, describe it, see the image count and worst-case cost, and press Generate Images once.
 * @subsystem visual-pipeline
 *
 * Plan `docs/plans/PLAN_EVAL_PAGE.md`, B and C. One wizard serves both tabs:
 * `kind` "engine" compares engines, "prompt" compares wording versions on one
 * engine. Nothing is saved until Generate Images; the request carries a token
 * generated for this wizard so a repeated press returns the same evaluation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Loader2, Search, Sparkles, X } from "lucide-react";
import {
  EVALUATION_CANDIDATE_FAMILIES,
  EVALUATION_PHOTO_TYPES,
  type EvaluationSelection,
} from "@workspace/api-zod";
import { readError } from "@/components/admin/readError";
import { RECIPES_CHANGED_EVENT } from "@/components/admin/promoteRecipeVersion";

export type EvaluationKind = "engine" | "prompt";

const ENGINE_LABELS: Record<string, string> = {
  "gpt-image-2-6": "GPT Image 2.6",
  "nano-banana-2-1": "Nano Banana 2.1",
  "muse-image": "Muse",
};
export const engineLabel = (family: string) => ENGINE_LABELS[family] ?? family;

interface FactHit { id: number; text: string }
interface Estimate { panels: number; images: number; totalBoundUsd: number | null; preparationBoundUsd: number | null; renderBoundUsd: number; warning: boolean; refusal: string | null }
interface RecipeFamily { family: string; liveVersionId: number | null; versions: Array<{ id: number; number: number; note: string }> }

const STEPS = ["Facts", "Engines", "Photo types", "Looks", "Describe and generate"] as const;
const PROMPT_STEPS = ["Facts", "Wording", "Photo types", "Look", "Describe and generate"] as const;

const usd = (n: number | null) => (n == null ? "unknown" : `$${n.toFixed(2)}`);
const newToken = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * Each tab keeps its own wizard mounted for the page visit (PR #931 round 1),
 * so its draft, step and request token survive a tab switch; an inactive
 * wizard renders nothing.
 */
export function EvaluationWizard({ kind, active = true, onGenerated }: { kind: EvaluationKind; active?: boolean; onGenerated: (setId: number) => void }) {
  const steps = kind === "prompt" ? PROMPT_STEPS : STEPS;
  const [step, setStep] = useState(0);
  const [facts, setFacts] = useState<FactHit[]>([]);
  const [engines, setEngines] = useState<Set<string>>(new Set());
  const [tuneFamily, setTuneFamily] = useState<string>(EVALUATION_CANDIDATE_FAMILIES[0]);
  /** Chosen versions, "0" being the baseline. */
  const [versions, setVersions] = useState<Set<string>>(new Set());
  const [photoTypes, setPhotoTypes] = useState<Set<string>>(new Set(["i2i_male_default"]));
  const [looks, setLooks] = useState<Set<string>>(new Set(["none"]));
  const [description, setDescription] = useState("");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const token = useRef(newToken());

  // Catalogues: the active looks, and (prompts tab) each candidate's wording versions.
  const [lookCatalogue, setLookCatalogue] = useState<Array<{ id: string; label: string }>>([]);
  const [families, setFamilies] = useState<RecipeFamily[] | null>(null);
  useEffect(() => {
    void fetch("/api/look-styles", { credentials: "include" }).then(async (r) => {
      const body = r.ok ? ((await r.json()) as Array<{ id: string; label: string }>) : [];
      setLookCatalogue(body.filter((l) => l.id !== "none"));
    }).catch(() => setLookCatalogue([]));
  }, []);
  const loadFamilies = useCallback(async () => {
    const r = await fetch("/api/admin/prompt-recipes", { credentials: "include" }).catch(() => null);
    if (!r || !r.ok) return;
    setFamilies(((await r.json()) as { families: RecipeFamily[] }).families);
  }, []);
  useEffect(() => {
    if (kind !== "prompt") return;
    void loadFamilies();
    const onChanged = () => { void loadFamilies(); };
    window.addEventListener(RECIPES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(RECIPES_CHANGED_EVENT, onChanged);
  }, [kind, loadFamilies]);
  const family = families?.find((f) => f.family === tuneFamily) ?? null;
  // Pre-tick the live version and the newest when an engine's versions first show.
  const prefilled = useRef<string | null>(null);
  useEffect(() => {
    if (!family || prefilled.current === family.family) return;
    prefilled.current = family.family;
    const live = String(family.liveVersionId ?? 0);
    const newest = family.versions[0] ? String(family.versions[0].id) : null;
    setVersions(new Set(newest && newest !== live ? [live, newest] : [live]));
  }, [family]);

  const selection: EvaluationSelection | null = useMemo(() => {
    if (!facts.length || !photoTypes.size || !looks.size) return null;
    if (kind === "prompt") {
      if (versions.size < 2 || versions.size > 4 || looks.size !== 1) return null;
      return {
        kind, factIds: facts.map((f) => f.id), engineFamilies: [tuneFamily as (typeof EVALUATION_CANDIDATE_FAMILIES)[number]],
        scenarioKeys: EVALUATION_PHOTO_TYPES.filter((t) => photoTypes.has(t.scenarioKey)).map((t) => t.scenarioKey),
        lookStyleIds: [...looks], recipeVersionIds: [...versions].map((v) => (v === "0" ? null : Number(v))),
      };
    }
    if (!engines.size) return null;
    return {
      kind, factIds: facts.map((f) => f.id),
      engineFamilies: EVALUATION_CANDIDATE_FAMILIES.filter((f) => engines.has(f)),
      scenarioKeys: EVALUATION_PHOTO_TYPES.filter((t) => photoTypes.has(t.scenarioKey)).map((t) => t.scenarioKey),
      lookStyleIds: [...looks],
    };
  }, [kind, facts, engines, tuneFamily, versions, photoTypes, looks]);

  const stepValid = [
    facts.length > 0,
    kind === "prompt" ? versions.size >= 2 && versions.size <= 4 : engines.size > 0,
    photoTypes.size > 0,
    kind === "prompt" ? looks.size === 1 : looks.size > 0,
    !!selection && description.trim().length > 0,
  ];

  // The count and worst case, read-only, whenever the last step shows.
  useEffect(() => {
    if (!active || step !== steps.length - 1 || !selection) return;
    let cancelled = false;
    setEstimate(null);
    void fetch("/api/admin/comparison/evaluations/estimate", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(selection),
    }).then(async (r) => {
      if (cancelled) return;
      if (!r.ok) { setError(await readError(r)); return; }
      setEstimate((await r.json()) as Estimate);
    }).catch(() => { if (!cancelled) setError("Could not work out the cost."); });
    return () => { cancelled = true; };
  }, [active, step, selection, steps.length]);

  /**
   * A Generate whose outcome is unknown (no answer, or a server error): the
   * evaluation may exist under this token. Until the admin chooses, the
   * wizard is locked to what was submitted, so a retry can only repeat that
   * request, and changing the choices means deliberately starting a new
   * evaluation under a new token (PR #931 round 2).
   */
  const [uncertain, setUncertain] = useState<{ selection: EvaluationSelection; description: string } | null>(null);

  const submit = async (sel: EvaluationSelection, desc: string) => {
    setGenerating(true);
    setError("");
    const r = await fetch("/api/admin/comparison/evaluations", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestToken: token.current, description: desc, selection: sel }),
    }).catch(() => null);
    setGenerating(false);
    if (!r || r.status >= 500) { setUncertain({ selection: sel, description: desc }); return; }
    // A refusal (4xx) created nothing: the choices can be corrected and sent again.
    if (!r.ok) { setError(await readError(r)); return; }
    setUncertain(null);
    const body = (await r.json()) as { setId: number };
    // A fresh wizard: a new token, the same choices kept for a similar evaluation.
    token.current = newToken();
    setStep(0);
    setDescription("");
    onGenerated(body.setId);
  };
  const generate = async () => { if (selection) await submit(selection, description.trim()); };
  const startOver = () => { token.current = newToken(); setUncertain(null); setError(""); };

  const toggle = (set: Set<string>, value: string, max = Infinity) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value); else if (next.size < max) next.add(value);
    return next;
  };

  if (!active) return null;
  if (uncertain) {
    return (
      <div className="rounded-sm border border-amber-500 bg-background p-3 space-y-3" data-testid={`wizard-${kind}`}>
        <p className="text-sm font-bold text-foreground flex items-center gap-1.5" data-testid="wizard-uncertain"><AlertTriangle className="w-4 h-4 text-amber-600" /> The last Generate Images did not get an answer, so it may or may not have started.</p>
        <p className="text-sm text-foreground">It was: <strong>{uncertain.description}</strong> — {uncertain.selection.factIds.length} fact{uncertain.selection.factIds.length === 1 ? "" : "s"}. Retrying it is safe: if it went through, you get that same evaluation, never a second one.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void submit(uncertain.selection, uncertain.description)} disabled={generating} data-testid="wizard-retry-same" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold rounded-sm bg-primary text-white hover:opacity-90 disabled:opacity-40">
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Retry that evaluation
          </button>
          <button type="button" onClick={startOver} disabled={generating} data-testid="wizard-start-over" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-sm border border-border hover:bg-muted disabled:opacity-40">
            Change the choices instead
          </button>
        </div>
        <p className="text-xs text-muted-foreground">Changing the choices starts a new evaluation. If the first one did go through, it will appear in the list below as well.</p>
      </div>
    );
  }
  return (
    <div className="rounded-sm border border-border bg-background p-3 space-y-3" data-testid={`wizard-${kind}`}>
      <ol className="flex flex-wrap gap-1 text-xs" aria-label="Steps">
        {steps.map((label, i) => (
          <li key={label} className={`px-2 py-0.5 rounded-sm border ${i === step ? "border-primary text-foreground font-bold" : i < step ? "border-border text-foreground" : "border-border text-muted-foreground"}`} aria-current={i === step ? "step" : undefined}>
            {i < step ? <Check className="inline w-3 h-3 mr-0.5" /> : `${i + 1}. `}{label}
          </li>
        ))}
      </ol>

      {step === 0 && <FactPicker chosen={facts} onChange={setFacts} />}

      {step === 1 && kind === "engine" && (
        <fieldset className="space-y-1" data-testid="wizard-engines">
          <legend className="text-sm font-bold text-foreground">Which engines?</legend>
          {EVALUATION_CANDIDATE_FAMILIES.map((f) => (
            <label key={f} className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={engines.has(f)} onChange={() => setEngines(toggle(engines, f))} data-testid={`wizard-engine-${f}`} />
              {engineLabel(f)}
            </label>
          ))}
        </fieldset>
      )}

      {step === 1 && kind === "prompt" && (
        <div className="space-y-2" data-testid="wizard-wording">
          <label className="text-sm text-foreground space-y-1 block">
            <span className="block font-bold">Engine</span>
            <select value={tuneFamily} onChange={(e) => { setTuneFamily(e.target.value); prefilled.current = null; }} data-testid="wizard-tune-family" className="rounded-sm border border-border bg-background px-2 py-1 text-sm">
              {EVALUATION_CANDIDATE_FAMILIES.map((f) => <option key={f} value={f}>{engineLabel(f)}</option>)}
            </select>
          </label>
          <fieldset className="space-y-1">
            <legend className="text-sm font-bold text-foreground">Wordings to compare (two to four)</legend>
            {!family && <p className="text-xs text-muted-foreground">Loading versions…</p>}
            {family && [...family.versions.map((v) => ({ value: String(v.id), label: `Version ${v.number} — ${v.note}` })), { value: "0", label: "Baseline (today's wording)" }].map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm text-foreground">
                <input type="checkbox" checked={versions.has(o.value)} onChange={() => setVersions(toggle(versions, o.value, 4))} data-testid={`wizard-version-${o.value}`} />
                {o.label}{String(family.liveVersionId ?? 0) === o.value ? " · live" : ""}
              </label>
            ))}
          </fieldset>
        </div>
      )}

      {step === 2 && (
        <fieldset className="space-y-1" data-testid="wizard-photo-types">
          <legend className="text-sm font-bold text-foreground">Which photo types?</legend>
          {EVALUATION_PHOTO_TYPES.map((t) => (
            <label key={t.scenarioKey} className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={photoTypes.has(t.scenarioKey)} onChange={() => setPhotoTypes(toggle(photoTypes, t.scenarioKey))} data-testid={`wizard-photo-${t.scenarioKey}`} />
              {t.label}
            </label>
          ))}
        </fieldset>
      )}

      {step === 3 && (
        <fieldset className="space-y-1" data-testid="wizard-looks">
          <legend className="text-sm font-bold text-foreground">{kind === "prompt" ? "Which look? (one)" : "Which looks?"}</legend>
          {[{ id: "none", label: "No look (photoreal)" }, ...lookCatalogue].map((l) => (
            <label key={l.id} className="flex items-center gap-2 text-sm text-foreground">
              <input
                type={kind === "prompt" ? "radio" : "checkbox"}
                name={`look-${kind}`}
                checked={looks.has(l.id)}
                onChange={() => setLooks(kind === "prompt" ? new Set([l.id]) : toggle(looks, l.id))}
                data-testid={`wizard-look-${l.id}`}
              />
              {l.label}
            </label>
          ))}
        </fieldset>
      )}

      {step === 4 && (
        <div className="space-y-2" data-testid="wizard-confirm">
          <label className="text-sm text-foreground space-y-1 block">
            <span className="block font-bold">Description</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder={kind === "prompt" ? "e.g. Lean wording vs today's on GPT Image 2.6" : "e.g. GPT Image 2.6 vs. Nano Banana 2.1"} data-testid="wizard-description" className="w-full rounded-sm border border-border bg-background px-2 py-1 text-sm" />
          </label>
          {selection && (
            <p className="text-sm text-foreground" data-testid="wizard-count">
              {facts.length} fact{facts.length === 1 ? "" : "s"} × {kind === "prompt" ? `${versions.size} wordings` : `${engines.size} engine${engines.size === 1 ? "" : "s"}`} × {photoTypes.size} photo type{photoTypes.size === 1 ? "" : "s"} × {looks.size} look{looks.size === 1 ? "" : "s"}
              {estimate ? <> = <strong>{estimate.images} images</strong>, at most <strong>{usd(estimate.totalBoundUsd)}</strong> (scenes {usd(estimate.preparationBoundUsd)}, pictures {usd(estimate.renderBoundUsd)})</> : <> = <Loader2 className="inline w-3 h-3 animate-spin" /></>}
            </p>
          )}
          {estimate?.warning && (
            <p className="text-sm font-bold text-amber-600 dark:text-amber-400 flex items-center gap-1.5" data-testid="wizard-warning">
              <AlertTriangle className="w-4 h-4" /> That's {estimate.images} images. Check this is what you meant before generating.
            </p>
          )}
          {estimate?.refusal && <p className="text-sm text-destructive" data-testid="wizard-refusal">{estimate.refusal}</p>}
          <p className="text-xs text-muted-foreground">Every picture is drawn at about 1 megapixel and judged blind. Generating prepares each scene and draws its pictures on its own; keep this page open until it finishes.</p>
        </div>
      )}

      {error && <p className="text-sm text-destructive flex items-center gap-1.5" data-testid="wizard-error"><AlertTriangle className="w-4 h-4" /> {error}</p>}

      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={() => { setError(""); setStep((s) => Math.max(0, s - 1)); }} disabled={step === 0 || generating} data-testid="wizard-back" className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-sm border border-border hover:bg-muted disabled:opacity-40">
          <ChevronLeft className="w-4 h-4" /> Back
        </button>
        {step < steps.length - 1 ? (
          <button type="button" onClick={() => { setError(""); setStep((s) => s + 1); }} disabled={!stepValid[step]} data-testid="wizard-next" className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-bold rounded-sm bg-primary text-white hover:opacity-90 disabled:opacity-40">
            Next <ChevronRight className="w-4 h-4" />
          </button>
        ) : (
          <button type="button" onClick={() => void generate()} disabled={!stepValid[step] || generating || !estimate || !!estimate.refusal} data-testid="wizard-generate" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold rounded-sm bg-primary text-white hover:opacity-90 disabled:opacity-40">
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Generate Images
          </button>
        )}
      </div>
    </div>
  );
}

/** Search eligible facts by keyword; click a result to add it, click a chip to remove it. */
function FactPicker({ chosen, onChange }: { chosen: FactHit[]; onChange: (facts: FactHit[]) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<FactHit[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      void fetch(`/api/admin/comparison/eligible-facts?q=${encodeURIComponent(q)}`, { credentials: "include" }).then(async (r) => {
        if (cancelled) return;
        const body = r.ok ? ((await r.json()) as { facts: FactHit[]; eligibleTotal: number }) : { facts: [], eligibleTotal: 0 };
        setHits(body.facts);
        setTotal(body.eligibleTotal);
      }).catch(() => undefined).finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [q]);
  const chosenIds = new Set(chosen.map((f) => f.id));
  return (
    <div className="space-y-2" data-testid="wizard-facts">
      <p className="text-sm font-bold text-foreground">Which facts?</p>
      {chosen.length > 0 && (
        <ul className="flex flex-wrap gap-1" data-testid="wizard-chosen-facts">
          {chosen.map((f) => (
            <li key={f.id}>
              <button type="button" onClick={() => onChange(chosen.filter((c) => c.id !== f.id))} data-testid={`wizard-chip-${f.id}`} title="Remove" className="inline-flex items-center gap-1 max-w-xs px-2 py-0.5 text-xs rounded-sm bg-muted text-foreground border border-border">
                <span className="truncate">#{f.id} {f.text}</span> <X className="w-3 h-3 shrink-0" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="flex items-center gap-2 rounded-sm border border-border px-2 py-1">
        <Search className="w-4 h-4 text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type keywords to find facts" data-testid="wizard-fact-search" className="flex-1 bg-transparent text-sm text-foreground outline-none" />
        {loading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
      </label>
      {total != null && <p className="text-xs text-muted-foreground" data-testid="wizard-fact-total">{total} fact{total === 1 ? " is" : "s are"} ready to evaluate. Only active facts with complete enrichment are listed.</p>}
      <ul className="max-h-64 overflow-auto divide-y divide-border rounded-sm border border-border" data-testid="wizard-fact-results">
        {hits.length === 0 && !loading && <li className="p-2 text-xs text-muted-foreground">No matching facts.</li>}
        {hits.map((f) => (
          <li key={f.id}>
            <button type="button" disabled={chosenIds.has(f.id)} onClick={() => onChange([...chosen, f])} data-testid={`wizard-fact-${f.id}`} className="w-full text-left p-2 text-sm text-foreground hover:bg-muted disabled:opacity-50">
              <span className="text-muted-foreground">#{f.id}</span> {f.text}{chosenIds.has(f.id) ? " — added" : ""}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
