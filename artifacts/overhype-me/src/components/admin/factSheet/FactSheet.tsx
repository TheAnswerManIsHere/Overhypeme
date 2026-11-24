/**
 * @purpose The fact sheet: one approved fact in a modal (full screen on a phone), its data in tabs that reuse the moderation steps' own components.
 * @subsystem moderation
 *
 * Plan docs/plans/PLAN_FACT_LIFECYCLE_REBUILD.md, items 19–20 and design 3A;
 * Issue #1018, the increment 3.1 outline. The one editor for a fact's data
 * (must-not-change: no second set of edit forms):
 *
 *   Overview            — collapsible groups, read-only except the hashtags,
 *                         which save at once.
 *   Reading and taxonomy — the Humor Note (saves at once), the research it was
 *                         written from (the Reading step's `ReadingResearch`),
 *                         and the stored taxonomy with its history and Re-run
 *                         (`FactTaxonomyPanel`).
 *   Gags                — the Gags step's `GagsPanel`, read-only until Publish
 *                         changes arrives (3.2).
 *   Renders             — the Test Renders step's `GagsPanel`, read-only.
 *
 * History, Publish, Discard, Reactivate and delete are 3.2's. Deactivate stays
 * here, as the old editor had it, so nothing that worked is lost meanwhile.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, EyeOff, Loader2, Save, X } from "lucide-react";
import { HUMOR_NOTE_MAX_CHARS, KIND_LABEL, joinWithAnd } from "@workspace/api-zod";
import { Button } from "@/components/ui/Button";
import { ReadingResearch } from "@/components/admin/ReadingStep";
import { FactTaxonomyPanel } from "@/components/admin/FactTaxonomyPanel";
import { FinalHashtagsEditor } from "@/components/admin/FinalHashtagsEditor";
import { GagsPanel } from "@/components/admin/gags/GagsPanel";
import { DEFAULT_SUBJECT_EXAMPLE_NAMES } from "@/components/admin/subjectExampleNames";
import {
  ATTENTION_WORDS,
  knownReasons,
  loadFactSheet,
  saveHashtags,
  saveHumorNote,
  type FactSheetView,
} from "./factSheetView";

export const FACT_SHEET_TABS = [
  { id: "overview", label: "Overview" },
  { id: "reading", label: "Reading and taxonomy" },
  { id: "gags", label: "Gags" },
  { id: "renders", label: "Renders" },
] as const;
export type FactSheetTab = (typeof FACT_SHEET_TABS)[number]["id"];

const SUBJECT_NAMES = [...DEFAULT_SUBJECT_EXAMPLE_NAMES];

/** What the Gags and Renders tabs say about being read-only (both are the moderation steps' `GagsPanel`). */
const GAG_TAB_NOTES = {
  gags: 'The gags members are offered. Changing them arrives with "Publish changes".',
  renders: "Each gag's male, female and pet pictures. Drawing new ones arrives with \"Publish changes\".",
} as const;

function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/** A collapsible group of the Overview, open to start with. */
function Group({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="rounded-sm border border-border bg-muted/20" data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left"
      >
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{title}</span>
        {open ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </section>
  );
}

/** One read-only value: a label over it. */
function Field({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className={`text-sm text-foreground break-words ${mono ? "font-mono" : ""}`}>{children}</dd>
    </div>
  );
}

function Fields({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3">{children}</dl>;
}

/** Saved / saving / error, beside an at-once edit. */
function SaveStatus({ state }: { state: SaveState }) {
  if (state.kind === "saving") return <span className="text-xs text-muted-foreground inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Saving…</span>;
  if (state.kind === "saved") return <span className="text-xs text-green-600 dark:text-green-400 inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Saved</span>;
  if (state.kind === "error") return <span className="text-xs text-destructive inline-flex items-center gap-1" role="alert"><AlertTriangle className="w-3 h-3" /> {state.message}</span>;
  return null;
}

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

function OverviewTab({ fact, onHashtags }: { fact: FactSheetView; onHashtags: (tags: string[]) => void }) {
  const [tags, setTags] = useState(fact.hashtags);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  // One save in flight for the sheet: a change made meanwhile waits in
  // `queued` and only the latest is sent when that save returns. `chosen` is
  // the list the admin last made; a response is shown, and "Saved" said, only
  // when it is the answer to that list (PR #1217 round 1: a response must
  // never replace what the admin entered after it was sent).
  const inFlight = useRef(false);
  const queued = useRef<string[] | null>(null);
  const chosen = useRef<string[]>(fact.hashtags);

  const send = useCallback(async (list: string[]): Promise<void> => {
    inFlight.current = true;
    setState({ kind: "saving" });
    let saved: string[] | null = null;
    let failure: string | null = null;
    try {
      saved = await saveHashtags(fact.id, list);
    } catch (err) {
      failure = err instanceof Error ? err.message : "Could not save the hashtags.";
    }
    inFlight.current = false;
    const next = queued.current;
    queued.current = null;
    if (next) { void send(next); return; }
    if (chosen.current !== list) return; // a newer choice is shown and is not sendable (an empty list); its warning stands
    if (failure != null || saved == null) { setState({ kind: "error", message: failure ?? "Could not save the hashtags." }); return; }
    chosen.current = saved;
    setTags(saved);
    onHashtags(saved);
    setState({ kind: "saved" });
  }, [fact.id, onHashtags]);

  // Each add or remove saves at once (plan item 20). An empty list is never
  // sent: the editor warns, and the server would refuse it.
  const change = useCallback((next: string[]) => {
    chosen.current = next;
    setTags(next);
    if (next.length === 0) {
      queued.current = null;
      setState({ kind: "error", message: "A fact needs at least one hashtag; this change isn't saved." });
      return;
    }
    if (inFlight.current) { queued.current = next; setState({ kind: "saving" }); return; }
    void send(next);
  }, [send]);

  const reasons = knownReasons(fact.attention);
  const approval = fact.approvalSource === "legacy"
    ? "Legacy (approved before approvals were recorded)"
    : `${fact.approvedByName ?? "A deleted admin"}`;

  return (
    <div className="space-y-3">
      <Group title="Identity and origin" testId="sheet-group-identity">
        <Fields>
          <Field label="Fact" mono>#{fact.id}</Field>
          <Field label="Status">{fact.isActive ? "Live" : "Deactivated"}</Field>
          <Field label="Submitted by">{fact.submittedByName ?? (fact.submittedById ? "A deleted member" : "Nobody recorded")}</Field>
          <Field label="Submitted" mono>{when(fact.createdAt)}</Field>
          <Field label="Approved by">{approval}</Field>
          <Field label="Approved" mono>{when(fact.approvedAt)}</Field>
          <Field label="Caption split" mono>{fact.splitTokenIndex ?? "auto"}</Field>
          <Field label="Moderation review" mono>{fact.reviewId != null ? `#${fact.reviewId}` : "None recorded"}</Field>
        </Fields>
        {fact.canonicalText && (
          <div className="mt-3">
            <Field label="Canonical text (the duplicate fingerprint's input)">
              <span className="italic text-muted-foreground">{fact.canonicalText}</span>
            </Field>
          </div>
        )}
      </Group>

      <Group title="Scoring" testId="sheet-group-scoring">
        <Fields>
          <Field label="Upvotes" mono>{fact.upvotes}</Field>
          <Field label="Downvotes" mono>{fact.downvotes}</Field>
          <Field label="Score" mono>{fact.score}</Field>
          <Field label="Wilson score" mono>{(fact.wilsonScore ?? 0).toFixed(3)}</Field>
        </Fields>
      </Group>

      <Group title="Usage" testId="sheet-group-usage">
        <Fields>
          <Field label="Comments" mono>{fact.commentCount}</Field>
          <Field label="Shares" mono>{fact.shareCount}</Field>
          <Field label="Member memes" mono>{fact.usage.memes}</Field>
          <Field label="Member AI pictures" mono>{fact.usage.aiPictures}</Field>
        </Fields>
      </Group>

      <Group title="Pictures" testId="sheet-group-pictures">
        {fact.pictures.length === 0 ? (
          <p className="text-sm text-muted-foreground">No published gags.</p>
        ) : (
          <ul className="space-y-1.5">
            {fact.pictures.map((g) => (
              <li key={g.gagId} className="text-sm flex items-start gap-2" data-testid={`sheet-pictures-gag-${g.slot}`}>
                {g.missingKinds.length === 0
                  ? <CheckCircle2 className="w-4 h-4 mt-0.5 text-green-600 dark:text-green-400 shrink-0" />
                  : <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600 shrink-0" />}
                <span>
                  <span className="font-semibold">Gag {g.slot}:</span>{" "}
                  {g.missingKinds.length === 0
                    ? "all three examples published."
                    : `no ${joinWithAnd(g.missingKinds.map((k) => KIND_LABEL[k].toLowerCase()))} example published.`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Needs attention</p>
          {reasons.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="sheet-no-attention">Nothing.</p>
          ) : (
            <ul className="space-y-1" data-testid="sheet-attention">
              {reasons.map((r) => (
                <li key={r} className="text-sm"><span className="font-semibold">{ATTENTION_WORDS[r].label}:</span> {ATTENTION_WORDS[r].sentence}</li>
              ))}
            </ul>
          )}
        </div>
      </Group>

      <Group title="Hashtags" testId="sheet-group-hashtags">
        <div className="space-y-2">
          <FinalHashtagsEditor finalHashtags={tags} onFinalHashtagsChange={change} aiSuggestions={fact.suggestedHashtags} />
          <div className="min-h-4" data-testid="sheet-hashtags-status"><SaveStatus state={state} /></div>
        </div>
      </Group>
    </div>
  );
}

function ReadingTab({ fact, onSaved }: { fact: FactSheetView; onSaved: () => void }) {
  const approved = fact.reading.approved;
  const [text, setText] = useState(approved?.text ?? "");
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const trimmed = text.trim();
  const changed = trimmed !== (approved?.text ?? "").trim();

  // What is in the box now, so a save's answer never replaces text typed
  // while it was in flight (PR #1217 round 1).
  const current = useRef(text);
  current.current = text;

  const save = async () => {
    const sent = trimmed;
    setState({ kind: "saving" });
    try {
      const saved = await saveHumorNote(fact.id, sent);
      onSaved();
      if (current.current.trim() !== sent) { setState({ kind: "idle" }); return; } // newer text stays, unsaved
      setText(saved.text);
      setState({ kind: "saved" });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "Could not save the humor note." });
    }
  };

  const research = fact.reading.latest;
  return (
    <div className="space-y-5">
      <section className="space-y-2" data-testid="sheet-humor-note">
        <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Humor note</p>
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setState((st) => (st.kind === "saving" ? st : { kind: "idle" })); }}
          maxLength={HUMOR_NOTE_MAX_CHARS}
          rows={4}
          aria-label="Humor note"
          className="w-full rounded-sm border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:border-primary"
        />
        <p className="text-xs text-muted-foreground">
          {approved
            ? `Approved by ${fact.reading.approvedByName ?? "a deleted admin"}, ${when(approved.approvedAt)}.`
            : "No approved note yet."}{" "}
          Saving changes the note only: the published gags stay as they are.
        </p>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={() => void save()} disabled={!changed || trimmed.length === 0 || state.kind === "saving"} data-testid="sheet-save-note">
            <Save className="w-4 h-4" /> Save note
          </Button>
          <SaveStatus state={state} />
        </div>
      </section>

      <section className="border-t border-border pt-4">
        {research?.research ? (
          <ReadingResearch reading={research} />
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="sheet-no-research">No reference research is stored for this fact.</p>
        )}
      </section>

      <section className="border-t border-border pt-4">
        <FactTaxonomyPanel factId={fact.id} initialStatus={fact.enrichmentStatus} />
      </section>
    </div>
  );
}

export function FactSheet({
  factId,
  onClose,
  onChanged,
  initialTab = "overview",
}: {
  factId: number;
  onClose: () => void;
  /** The fact changed in a way the list shows (deactivated): the list should reload. */
  onChanged: () => void;
  initialTab?: FactSheetTab;
}) {
  const [fact, setFact] = useState<FactSheetView | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<FactSheetTab>(initialTab);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [deactivateError, setDeactivateError] = useState("");

  const load = useCallback(() => {
    setError("");
    loadFactSheet(factId).then(setFact).catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load the fact."));
  }, [factId]);
  useEffect(() => { setFact(null); load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Hashtags are not on the list, so a save there leaves it alone.
  const onHashtags = useCallback((tags: string[]) => {
    setFact((f) => (f ? { ...f, hashtags: tags } : f));
  }, []);

  // Deactivate: the only removal until 3.2's (plan 1F). Members' memes,
  // pictures and comments stay.
  const deactivate = async () => {
    setDeactivating(true);
    setDeactivateError("");
    try {
      const r = await fetch(`/api/admin/facts/${factId}`, { method: "DELETE", credentials: "include" });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(body.error ?? "Could not deactivate the fact.");
      setConfirmDeactivate(false);
      onChanged();
      load();
    } catch (err) {
      setDeactivateError(err instanceof Error ? err.message : "Could not deactivate the fact.");
    } finally {
      setDeactivating(false);
    }
  };

  const reasons = knownReasons(fact?.attention);

  return (
    <div
      data-modal-overlay
      className="fixed inset-0 z-50 bg-black/60 flex items-stretch sm:items-center justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Fact #${factId}`}
        data-testid="fact-sheet"
        className="bg-card sm:border-2 border-border sm:rounded-sm w-full h-full sm:h-auto sm:max-w-4xl sm:max-h-[90vh] shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-border px-4 sm:px-6 pt-4 pb-3 shrink-0 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <h2 className="font-display font-bold uppercase tracking-wide text-foreground">Fact <span className="font-mono">#{factId}</span></h2>
              {fact && (
                <span
                  data-testid="sheet-status"
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-bold rounded-sm border ${fact.isActive ? "bg-green-500/10 text-green-600 border-green-500/30" : "bg-red-500/10 text-red-500 border-red-500/30"}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${fact.isActive ? "bg-green-500" : "bg-red-500"}`} />
                  {fact.isActive ? "Live" : "Deactivated"}
                </span>
              )}
              {reasons.map((r) => (
                <span key={r} className="px-2 py-0.5 text-xs font-semibold rounded-sm border border-amber-500/40 bg-amber-500/10 text-amber-600">{ATTENTION_WORDS[r].label}</span>
              ))}
            </div>
            <button onClick={onClose} className="flex items-center justify-center w-11 h-11 -mr-2 -mt-2 text-muted-foreground hover:text-foreground rounded-sm shrink-0" aria-label="Close the fact sheet">
              <X className="w-5 h-5" />
            </button>
          </div>
          {/* Capped at a quarter of the screen and scrolled in its own box, so a
              long fact (up to 2,000 characters) never pushes the tabs or the
              footer off a phone (PR #1217 round 1). */}
          {fact && <p className="text-sm text-foreground whitespace-pre-wrap max-h-[25dvh] overflow-y-auto" data-testid="sheet-wording">{fact.text}</p>}
          <div role="tablist" aria-label="Fact sheet" className="flex flex-wrap gap-x-1 -mb-3">
            {FACT_SHEET_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                data-testid={`sheet-tab-${t.id}`}
                onClick={() => setTab(t.id)}
                className={`px-3 py-2 text-xs font-bold uppercase tracking-wide whitespace-nowrap border-b-2 transition-colors ${tab === t.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4" role="tabpanel" data-testid={`sheet-panel-${tab}`}>
          {error ? (
            <p className="text-sm text-destructive flex items-center gap-2" role="alert"><AlertTriangle className="w-4 h-4" /> {error}</p>
          ) : !fact ? (
            <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading the fact…</p>
          ) : tab === "overview" ? (
            <OverviewTab fact={fact} onHashtags={onHashtags} />
          ) : tab === "reading" ? (
            <ReadingTab key={fact.id} fact={fact} onSaved={load} />
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground" data-testid={`sheet-${tab}-read-only`}>{GAG_TAB_NOTES[tab]}</p>
              <GagsPanel key={tab} factId={fact.id} reviewId={null} rendersEnabled={tab === "renders"} subjectNames={SUBJECT_NAMES} disabled />
            </div>
          )}
        </div>

        {fact?.isActive && (
          <footer className="border-t border-border px-4 sm:px-6 py-3 shrink-0">
            {confirmDeactivate ? (
              <div className="space-y-2" data-testid="sheet-deactivate-confirm">
                <p className="text-sm text-muted-foreground">
                  Takes the fact off the site. Members' memes, pictures and comments are kept. It can't be reactivated from the admin yet.
                </p>
                {deactivateError && <p className="text-sm text-destructive" role="alert">{deactivateError}</p>}
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void deactivate()} isLoading={deactivating} data-testid="deactivate-fact-confirm">
                    <EyeOff className="w-4 h-4" /> Deactivate
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirmDeactivate(false)} disabled={deactivating}>Cancel</Button>
                </div>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmDeactivate(true)}
                className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive/60"
                data-testid="deactivate-fact-button"
              >
                <EyeOff className="w-4 h-4" /> Deactivate fact
              </Button>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
