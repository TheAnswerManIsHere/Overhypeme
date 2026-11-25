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
 *   Gags                — the Gags step's `GagsPanel`, editing the fact's draft
 *                         (its working copy, which members never see).
 *   Renders             — the Test Renders step's `GagsPanel`, drawing and
 *                         approving the draft's pictures.
 *   History             — every admin action on the fact, newest first (3C).
 *
 * Increment 3.2 (plan 3B): the footer carries Publish changes and Discard
 * changes whenever the draft differs from the published set, and Deactivate
 * or Reactivate. Leaving the sheet or a tab with an unsaved Humor Note or gag
 * asks first, and the hashtags' save state lives here, so it survives a tab
 * switch (both owed from 3.1).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Eye, EyeOff, Loader2, Save, Send, Trash2, Undo2, X } from "lucide-react";
import { HUMOR_NOTE_MAX_CHARS, KIND_LABEL, joinWithAnd, type FactGagsView } from "@workspace/api-zod";
import { Button } from "@/components/ui/Button";
import { ReadingResearch } from "@/components/admin/ReadingStep";
import { FactTaxonomyPanel } from "@/components/admin/FactTaxonomyPanel";
import { FinalHashtagsEditor } from "@/components/admin/FinalHashtagsEditor";
import { GagsPanel } from "@/components/admin/gags/GagsPanel";
import { DEFAULT_SUBJECT_EXAMPLE_NAMES } from "@/components/admin/subjectExampleNames";
import {
  ATTENTION_WORDS,
  knownReasons,
  loadFactHistory,
  loadFactSheet,
  runFactAction,
  saveHashtags,
  saveHumorNote,
  type FactLifecycleAction,
  type FactSheetView,
} from "./factSheetView";
import { describeHistory, type FactHistoryEntry } from "./historyWords";

export const FACT_SHEET_TABS = [
  { id: "overview", label: "Overview" },
  { id: "reading", label: "Reading and taxonomy" },
  { id: "gags", label: "Gags" },
  { id: "renders", label: "Renders" },
  { id: "history", label: "History" },
] as const;
export type FactSheetTab = (typeof FACT_SHEET_TABS)[number]["id"];

const SUBJECT_NAMES = [...DEFAULT_SUBJECT_EXAMPLE_NAMES];

/** What the Gags and Renders tabs say about the draft (both are the moderation steps' `GagsPanel`). */
const GAG_TAB_NOTES = {
  gags: "Changes here go into a draft. Members keep seeing the published gags until you publish the changes.",
  renders: "Draw and approve each gag's male, female and pet pictures. Approvals are part of the draft until you publish the changes.",
} as const;

/** The draft differs from the published set, as a gags view reads it. */
export function viewHasDraftChanges(view: FactGagsView): boolean {
  return view.gags.some((g) => g.pendingContent != null || g.draftRemoved);
}

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

/**
 * The hashtags' at-once save, held by the sheet rather than the Overview tab,
 * so a save in flight and the list it answers survive a tab round-trip
 * (Issue #1018, the 3.2 inputs from 3.1). One save is in flight at a time: a
 * change made meanwhile waits in `queued`, and only the latest is sent when
 * that save returns. `chosen` is the list the admin last made; a response is
 * shown, and "Saved" said, only when it answers that list (PR #1217 round 1:
 * a response must never replace what the admin entered after it was sent).
 */
function useHashtagSaver(factId: number, initial: string[] | undefined, onSaved: (tags: string[]) => void) {
  const [tags, setTags] = useState<string[] | null>(null);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const inFlight = useRef(false);
  const queued = useRef<string[] | null>(null);
  const chosen = useRef<string[] | null>(null);

  // The first load seeds the list; later reloads never replace the admin's.
  useEffect(() => {
    if (initial && chosen.current == null) { chosen.current = initial; setTags(initial); }
  }, [initial]);

  const send = useCallback(async (list: string[]): Promise<void> => {
    inFlight.current = true;
    setState({ kind: "saving" });
    let saved: string[] | null = null;
    let failure: string | null = null;
    try {
      saved = await saveHashtags(factId, list);
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
    onSaved(saved);
    setState({ kind: "saved" });
  }, [factId, onSaved]);

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

  return { tags: tags ?? initial ?? [], state, change };
}

type HashtagSaver = ReturnType<typeof useHashtagSaver>;

function OverviewTab({ fact, hashtags }: { fact: FactSheetView; hashtags: HashtagSaver }) {
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
          <Field label="Approved comments" mono>{fact.commentCount}</Field>
          <Field label="All comments, any status" mono>{fact.usage.comments}</Field>
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
          <FinalHashtagsEditor finalHashtags={hashtags.tags} onFinalHashtagsChange={hashtags.change} context="live" />
          <div className="min-h-4" data-testid="sheet-hashtags-status"><SaveStatus state={hashtags.state} /></div>
        </div>
      </Group>
    </div>
  );
}

function ReadingTab({ fact, onSaved, onDirtyChange }: { fact: FactSheetView; onSaved: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const approved = fact.reading.approved;
  const [text, setText] = useState(approved?.text ?? "");
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const trimmed = text.trim();
  const changed = trimmed !== (approved?.text ?? "").trim();

  // The sheet asks before a tab switch, Escape or a click outside would lose
  // an unsaved note (Issue #1018, the 3.2 inputs from 3.1). A save in flight
  // is not lost by leaving, so it does not count.
  const dirty = changed && state.kind !== "saving";
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

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

/** Every admin action on the fact, newest first (plan 3C, oracle item 22). */
function HistoryTab({ factId }: { factId: number }) {
  const [entries, setEntries] = useState<FactHistoryEntry[] | null>(null);
  const [limit, setLimit] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    loadFactHistory(factId)
      .then((r) => { if (live) { setEntries(r.history); setLimit(r.limit); } })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : "Could not load the history."); });
    return () => { live = false; };
  }, [factId]);

  if (error) return <p className="text-sm text-destructive flex items-center gap-2" role="alert"><AlertTriangle className="w-4 h-4" /> {error}</p>;
  if (!entries) return <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading the history…</p>;
  if (entries.length === 0) return <p className="text-sm text-muted-foreground" data-testid="sheet-history-empty">No admin actions are recorded for this fact.</p>;
  return (
    <div className="space-y-2">
      <ol className="divide-y divide-border border border-border rounded-sm" data-testid="sheet-history">
        {entries.map((e) => {
          const { title, detail } = describeHistory(e);
          return (
            <li key={e.id} className="px-3 py-2.5" data-testid="sheet-history-entry">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="text-sm font-semibold text-foreground">{title}</span>
                <span className="text-xs font-mono text-muted-foreground">{when(e.createdAt)}</span>
              </div>
              {detail && <p className="text-sm text-muted-foreground break-words">{detail}</p>}
              <p className="text-xs text-muted-foreground">
                {/* A missing name says only that the admin cannot be named (a deleted account clears actor_id), never who or what acted. */}
                {e.actorName ?? "No admin on record"}
                {e.reviewId != null && <span className="font-mono"> · review #{e.reviewId}</span>}
              </p>
            </li>
          );
        })}
      </ol>
      {entries.length >= limit && limit > 0 && (
        <p className="text-xs text-muted-foreground">Showing the latest {limit} actions.</p>
      )}
    </div>
  );
}

/** What the footer is asking the admin to confirm. */
type Confirming = "deactivate" | "discard" | "delete" | null;

const CONFIRM = {
  deactivate: {
    testId: "deactivate",
    confirmTestId: "deactivate-fact-confirm",
    text: "Takes the fact off the site. Members' memes, pictures and comments are kept, and so are any unpublished changes. It can be reactivated later.",
    label: "Deactivate",
    icon: EyeOff,
  },
  discard: {
    testId: "discard",
    confirmTestId: "discard-changes-confirm",
    text: "Throws away every unpublished change to the gags and their pictures. Gags that were never published are removed. Members' view doesn't change.",
    label: "Discard changes",
    icon: Undo2,
  },
} as const;

function ConfirmPanel({ testId, confirmTestId, text, label, icon: Icon, busy, acting, onConfirm, onCancel }: (typeof CONFIRM)[keyof typeof CONFIRM] & {
  busy: boolean; acting: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="space-y-2" data-testid={`sheet-${testId}-confirm`}>
      <p className="text-sm text-muted-foreground">{text}</p>
      <div className="flex gap-2">
        <Button size="sm" onClick={onConfirm} isLoading={acting} data-testid={confirmTestId}>
          <Icon className="w-4 h-4" /> {label}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

const ACTION_DONE: Record<FactLifecycleAction, string> = {
  publish: "Published. Members now see the new gags.",
  discard: "Changes discarded. The gags are back to what members see.",
  deactivate: "Deactivated. The fact is off the site.",
  reactivate: "Reactivated. The fact is live again.",
  delete: "Deleted.",
};

/** What members have attached to the fact, in words, or null when nothing is: a permanent delete is refused while anything is (plan 3B). */
export function attachedWords(fact: Pick<FactSheetView, "usage">): string | null {
  // usage counts every comment row, as the delete does, not the public
  // counter of approved comments (commentCount).
  const { memes, aiPictures, comments } = fact.usage;
  const parts = [
    memes ? `${memes} meme${memes === 1 ? "" : "s"}` : null,
    aiPictures ? `${aiPictures} AI picture${aiPictures === 1 ? "" : "s"}` : null,
    comments ? `${comments} comment${comments === 1 ? "" : "s"}` : null,
  ].filter((p): p is string => p != null);
  return parts.length ? joinWithAnd(parts) : null;
}

/** The permanent delete's confirmation: the fact's id typed back, so it is never one click. */
function DeletePanel({ factId, busy, acting, onConfirm, onCancel }: { factId: number; busy: boolean; acting: boolean; onConfirm: () => void; onCancel: () => void }) {
  const [typed, setTyped] = useState("");
  const ready = typed.trim() === String(factId);
  return (
    <div className="space-y-2" data-testid="sheet-delete-confirm">
      <p className="text-sm text-muted-foreground">
        Deletes the fact for good: its wording, gags, pictures, readings and history links. It can't be undone. The admin record of the delete is kept.
      </p>
      <label className="block text-sm text-foreground">
        Type <span className="font-mono font-bold">{factId}</span> to confirm
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          inputMode="numeric"
          aria-label="Type the fact's number to confirm"
          data-testid="delete-fact-typed"
          className="mt-1 block w-40 rounded-sm border border-border bg-background px-2 py-1 font-mono text-sm focus:outline-none focus:border-destructive"
        />
      </label>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={onConfirm}
          isLoading={acting}
          disabled={!ready || busy}
          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          data-testid="delete-fact-confirm"
        >
          <Trash2 className="w-4 h-4" /> Delete permanently
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
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
  /** The fact changed in a way the list shows (live or not, unpublished changes): the list should reload. Called once per change, never on a plain close. */
  onChanged: () => void;
  initialTab?: FactSheetTab;
}) {
  const [fact, setFact] = useState<FactSheetView | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<FactSheetTab>(initialTab);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [acting, setActing] = useState<FactLifecycleAction | null>(null);
  const [actionError, setActionError] = useState("");
  const [actionDone, setActionDone] = useState("");
  // The Gags and Renders tabs' latest view of the draft, and its reload key.
  const [gagView, setGagView] = useState<FactGagsView | null>(null);
  const [gagsReload, setGagsReload] = useState(0);
  // Bumped by every action, so an open History tab shows it.
  const [historyKey, setHistoryKey] = useState(0);
  // Unsaved work a tab switch or closing would lose, and the leave it holds.
  const [unsavedNote, setUnsavedNote] = useState(false);
  const [unsavedGags, setUnsavedGags] = useState<string[]>([]);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);

  const load = useCallback(() => {
    setError("");
    loadFactSheet(factId).then(setFact).catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load the fact."));
  }, [factId]);
  useEffect(() => { setFact(null); load(); }, [load]);

  // Hashtags are not on the list, so a save there leaves it alone.
  const onHashtags = useCallback((tags: string[]) => {
    setFact((f) => (f ? { ...f, hashtags: tags } : f));
  }, []);
  const hashtags = useHashtagSaver(factId, fact?.hashtags, onHashtags);

  const unsavedWhat = [
    ...(unsavedNote ? ["the Humor Note"] : []),
    ...unsavedGags,
  ];
  const hasUnsaved = unsavedWhat.length > 0;
  // Leaving a tab or the sheet with unsaved work asks first.
  const guard = useCallback((leave: () => void) => {
    if (hasUnsaved) setPendingLeave(() => leave);
    else leave();
  }, [hasUnsaved]);

  const close = useCallback(() => guard(onClose), [guard, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pendingLeave) setPendingLeave(null); // Escape on the question keeps editing
      else close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, pendingLeave]);

  const onUnsavedGags = useCallback((names: string[]) => setUnsavedGags(names), []);
  const onNoteDirty = useCallback((dirty: boolean) => setUnsavedNote(dirty), []);

  const unpublished = gagView ? viewHasDraftChanges(gagView) : fact?.hasUnpublishedChanges ?? false;

  // The list shows "Unpublished changes" too (plan 3B): it is told whenever the
  // sheet's one derived value stops matching what the list last showed, so a
  // gag saved, added, removed or re-pictured reaches it without a refetch on
  // every close (PR #1227 round 1, Codex 4685554377). The baseline is the
  // sheet's first load, which is what the list row was drawn from.
  const reportedUnpublished = useRef<boolean | null>(null);
  useEffect(() => {
    if (!fact) return;
    if (reportedUnpublished.current == null) { reportedUnpublished.current = fact.hasUnpublishedChanges; }
    if (unpublished !== reportedUnpublished.current) {
      reportedUnpublished.current = unpublished;
      onChanged();
    }
  }, [fact, unpublished, onChanged]);
  const draftReady = gagView?.draftReady ?? null;
  const publishBlocked = unsavedGags.length > 0
    ? `Save or undo ${joinWithAnd(unsavedGags)} first.`
    : draftReady && !draftReady.ok ? draftReady.reason ?? "The draft isn't ready to publish." : null;

  const act = async (action: FactLifecycleAction) => {
    setActing(action);
    setActionError("");
    setActionDone("");
    try {
      await runFactAction(factId, action);
      setConfirming(null);
      if (action === "delete") {
        // The fact is gone: the list drops it and the sheet closes, with nothing left to save.
        onChanged();
        onClose();
        return;
      }
      setActionDone(ACTION_DONE[action]);
      // Publish and Discard leave no unpublished changes: say so at once, and
      // as what the list was told, so the reload that follows is not reported
      // to it a second time.
      if (action === "publish" || action === "discard") {
        reportedUnpublished.current = false;
        setFact((f) => (f ? { ...f, hasUnpublishedChanges: false } : f));
      }
      setGagView(null);
      setGagsReload((k) => k + 1);
      setHistoryKey((k) => k + 1);
      onChanged();
      load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "That didn't work. Nothing was changed.");
    } finally {
      setActing(null);
    }
  };

  const reasons = knownReasons(fact?.attention);
  const busy = acting != null;
  const attached = fact ? attachedWords(fact) : null;

  return (
    <div
      data-modal-overlay
      className="fixed inset-0 z-50 bg-black/60 flex items-stretch sm:items-start justify-center sm:p-4 sm:pt-[5vh]"
      onClick={close}
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
              {fact && unpublished && (
                <span data-testid="sheet-unpublished" className="px-2 py-0.5 text-xs font-bold rounded-sm border border-primary/50 bg-primary/10 text-primary">
                  Unpublished changes
                </span>
              )}
              {reasons.map((r) => (
                <span key={r} className="px-2 py-0.5 text-xs font-semibold rounded-sm border border-amber-500/40 bg-amber-500/10 text-amber-600">{ATTENTION_WORDS[r].label}</span>
              ))}
            </div>
            <button onClick={close} className="flex items-center justify-center w-11 h-11 -mr-2 -mt-2 text-muted-foreground hover:text-foreground rounded-sm shrink-0" aria-label="Close the fact sheet">
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
                onClick={() => { if (t.id !== tab) guard(() => setTab(t.id)); }}
                className={`px-3 py-2 text-xs font-bold uppercase tracking-wide whitespace-nowrap border-b-2 transition-colors ${tab === t.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </header>

        {pendingLeave && (
          <div className="border-b border-amber-500/40 bg-amber-500/10 px-4 sm:px-6 py-3 shrink-0 space-y-2" role="alertdialog" aria-label="Unsaved changes" data-testid="sheet-leave-confirm">
            <p className="text-sm text-foreground">
              <AlertTriangle className="w-4 h-4 inline -mt-0.5 mr-1 text-amber-600" />
              {joinWithAnd(unsavedWhat).replace(/^./, (c) => c.toUpperCase())} {unsavedWhat.length > 1 ? "have" : "has"} changes that aren't saved. Leave without saving them?
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setPendingLeave(null)} data-testid="sheet-leave-cancel">Keep editing</Button>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive border-destructive/30 hover:bg-destructive/10"
                onClick={() => { const leave = pendingLeave; setPendingLeave(null); setUnsavedNote(false); setUnsavedGags([]); leave(); }}
                data-testid="sheet-leave-confirm-button"
              >
                Leave without saving
              </Button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4" role="tabpanel" data-testid={`sheet-panel-${tab}`}>
          {error ? (
            <p className="text-sm text-destructive flex items-center gap-2" role="alert"><AlertTriangle className="w-4 h-4" /> {error}</p>
          ) : !fact ? (
            <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading the fact…</p>
          ) : tab === "overview" ? (
            <OverviewTab fact={fact} hashtags={hashtags} />
          ) : tab === "reading" ? (
            <ReadingTab key={fact.id} fact={fact} onSaved={load} onDirtyChange={onNoteDirty} />
          ) : tab === "history" ? (
            <HistoryTab key={`${fact.id}-${fact.updatedAt}-${historyKey}`} factId={fact.id} />
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground" data-testid={`sheet-${tab}-note`}>{GAG_TAB_NOTES[tab]}</p>
              <GagsPanel
                key={tab}
                factId={fact.id}
                reviewId={null}
                rendersEnabled={tab === "renders"}
                subjectNames={SUBJECT_NAMES}
                reloadKey={gagsReload}
                onView={setGagView}
                onUnsavedChange={onUnsavedGags}
                disabled={busy}
              />
            </div>
          )}
        </div>

        {fact && (
          <footer className="border-t border-border px-4 sm:px-6 py-3 shrink-0 space-y-2" data-testid="sheet-footer">
            {actionError && <p className="text-sm text-destructive flex items-start gap-1.5" role="alert" data-testid="sheet-action-error"><AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {actionError}</p>}
            {actionDone && !actionError && <p className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1.5" data-testid="sheet-action-done"><CheckCircle2 className="w-4 h-4" /> {actionDone}</p>}

            {confirming === "delete" ? (
              <DeletePanel factId={factId} busy={busy} acting={acting === "delete"} onConfirm={() => void act("delete")} onCancel={() => setConfirming(null)} />
            ) : confirming ? (
              <ConfirmPanel
                {...CONFIRM[confirming]}
                busy={busy}
                acting={acting === confirming}
                onConfirm={() => void act(confirming)}
                onCancel={() => setConfirming(null)}
              />
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                {fact.isActive ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { setActionDone(""); setConfirming("deactivate"); }}
                    disabled={busy}
                    className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive/60"
                    data-testid="deactivate-fact-button"
                  >
                    <EyeOff className="w-4 h-4" /> Deactivate fact
                  </Button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => void act("reactivate")} isLoading={acting === "reactivate"} disabled={busy} data-testid="reactivate-fact-button">
                      <Eye className="w-4 h-4" /> Reactivate
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => { setActionDone(""); setConfirming("delete"); }}
                      disabled={busy || attached != null}
                      className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive/60"
                      data-testid="delete-fact-button"
                    >
                      <Trash2 className="w-4 h-4" /> Delete permanently
                    </Button>
                    {attached && (
                      <span className="text-xs text-muted-foreground" data-testid="sheet-delete-held">Members have {attached} on it, so it can't be deleted.</span>
                    )}
                  </div>
                )}
                {unpublished && (
                  <div className="flex flex-wrap items-center gap-2" data-testid="sheet-publish-bar">
                    <span className="text-xs text-muted-foreground">Members still see the published gags.</span>
                    <Button size="sm" variant="outline" onClick={() => { setActionDone(""); setConfirming("discard"); }} disabled={busy} data-testid="discard-changes-button">
                      <Undo2 className="w-4 h-4" /> Discard changes
                    </Button>
                    <Button size="sm" onClick={() => void act("publish")} isLoading={acting === "publish"} disabled={busy || publishBlocked != null} data-testid="publish-changes-button">
                      <Send className="w-4 h-4" /> Publish changes
                    </Button>
                  </div>
                )}
              </div>
            )}
            {unpublished && publishBlocked && !confirming && (
              <p className="text-xs text-muted-foreground text-right" data-testid="sheet-publish-blocked">{publishBlocked}</p>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
