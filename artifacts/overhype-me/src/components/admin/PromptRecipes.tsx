/**
 * The prompt tuner's recipe editor (part 2; plan
 * `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed Design* A and D). For one
 * engine family at a time: every piece of global prompt wording, editable;
 * save as a new version with a note; preview the wording on a fact's stored
 * render plan; and promote a version (or restore the baseline) live.
 *
 * Saving and previewing change nothing live. Promoting changes the wording
 * that family's engines are sent from then on, never which engine draws; a
 * version that changes a policy line asks a second, separate confirmation.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { readError } from "@/components/admin/readError";
import { announceRecipesChanged, promoteRecipeVersion } from "@/components/admin/promoteRecipeVersion";

export interface PieceDef { key: string; label: string; group: string; when: string; slots: string[]; policy: boolean; baseline: string }
export interface FamilyVersion { id: number; number: number; note: string; createdBy: string | null; createdAt: string; pieces: Record<string, string> }
export interface RecipeFamily {
  family: string;
  engines: Array<{ id: string; label: string; imageMode: string | null; retired: boolean }>;
  liveVersionId: number | null;
  versions: FamilyVersion[];
  promotions: Array<{ id: number; versionId: number | null; promotedBy: string | null; promotedAt: string }>;
}
interface Listing { pieces: PieceDef[]; families: RecipeFamily[] }
interface Segment { text: string; piece: string | null }
interface Preview { prompt: string; length: number; overflowBy: number; problems: string[]; sections: Array<{ id: string; label: string; status: string; text: string; segments?: Segment[] }> }

const GROUP_LABEL: Record<string, string> = {
  labels: "Section labels", identity: "Identity", binding: "Subject binding", constraints: "Do-nots and failure guards",
  composition: "Composition", style: "Style", text: "Text in the picture", violence: "Violence", bubbles: "Speech and thought balloons", notes: "Engine notes",
};

/** The families the engines were settled on come first (David, 2026-11-11). */
const PREFERRED = ["gpt-image-2-6", "nano-banana-2-1"];

const MODES = [
  { value: "human_identity_i2i", label: "A person's photo" },
  { value: "nonhuman_subject_i2i", label: "A pet's or object's photo" },
  { value: "t2i_fallback", label: "No photo" },
] as const;

const versionName = (v: FamilyVersion | undefined | null) => (v ? `Version ${v.number}` : "Baseline (today's wording)");

export function PromptRecipes() {
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [family, setFamily] = useState("");
  /** The version the editor starts from: null is the baseline. */
  const [baseId, setBaseId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "preview" | "promote">("");
  const [problems, setProblems] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [factId, setFactId] = useState("");
  const [mode, setMode] = useState<(typeof MODES)[number]["value"]>("human_identity_i2i");
  const [preview, setPreview] = useState<Preview | null>(null);

  const load = useCallback(async (): Promise<Listing | null> => {
    const r = await fetch("/api/admin/prompt-recipes", { credentials: "include" }).catch(() => null);
    if (!r || !r.ok) { setError(r ? await readError(r) : "Could not load the prompt recipes."); return null; }
    const body = (await r.json()) as Listing;
    setData(body);
    return body;
  }, []);

  useEffect(() => {
    void load().then((body) => {
      if (!body || body.families.length === 0) return;
      const first = PREFERRED.find((f) => body.families.some((x) => x.family === f)) ?? body.families[0]!.family;
      setFamily(first);
      setBaseId(body.families.find((x) => x.family === first)?.liveVersionId ?? null);
    });
  }, [load]);

  const fam = data?.families.find((f) => f.family === family) ?? null;
  const baseVersion = fam?.versions.find((v) => v.id === baseId) ?? null;
  const basePieces = useMemo(() => {
    const out: Record<string, string> = {};
    for (const p of data?.pieces ?? []) out[p.key] = baseVersion?.pieces[p.key] ?? p.baseline;
    return out;
  }, [data, baseVersion]);
  const changed = useMemo(() => Object.keys(draft).filter((k) => draft[k] !== basePieces[k]), [draft, basePieces]);
  const changedSet = useMemo(() => new Set(changed), [changed]);
  const pieceLabel = (key: string) => data?.pieces.find((p) => p.key === key)?.label ?? key;
  const changedPolicy = changed.filter((k) => data?.pieces.find((p) => p.key === k)?.policy);

  const pickFamily = (f: string) => {
    setFamily(f);
    setBaseId(data?.families.find((x) => x.family === f)?.liveVersionId ?? null);
    setDraft({});
    setPreview(null);
    setProblems([]);
    setNotice("");
  };
  const pickBase = (id: number | null) => { setBaseId(id); setDraft({}); setPreview(null); setProblems([]); };

  const edits = () => Object.fromEntries(changed.map((k) => [k, draft[k]!]));

  const save = async () => {
    if (!fam || changed.length === 0 || !note.trim()) return;
    // The editor stays locked until the saved version and the refreshed list are
    // applied, so nothing typed or chosen meanwhile is overwritten (Codex, PR #926).
    setBusy("save"); setProblems([]); setNotice("");
    const r = await fetch(`/api/admin/prompt-recipes/${fam.family}/versions`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pieces: edits(), note: note.trim(), basedOnVersionId: baseId }),
    }).catch(() => null);
    if (!r) { setBusy(""); setProblems(["The request failed."]); return; }
    const body = await r.json().catch(() => ({})) as { version?: { id: number; number: number }; problems?: string[]; refusal?: string };
    if (!r.ok) { setBusy(""); setProblems(body.problems?.length ? body.problems : [body.refusal ?? `Not saved (${r.status}).`]); return; }
    await load();
    announceRecipesChanged();
    setBaseId(body.version!.id);
    setDraft({});
    setNote("");
    setNotice(`Saved as version ${body.version!.number}. Nothing live has changed.`);
    setBusy("");
  };

  const runPreview = async () => {
    if (!fam || !/^\d+$/.test(factId.trim())) { setProblems(["Enter a fact number to preview on."]); return; }
    setBusy("preview"); setProblems([]); setPreview(null);
    const r = await fetch(`/api/admin/prompt-recipes/${fam.family}/preview`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pieces: edits(), basedOnVersionId: baseId, factId: Number(factId.trim()), subjectRenderMode: mode }),
    }).catch(() => null);
    setBusy("");
    if (!r) { setProblems(["The request failed."]); return; }
    const body = await r.json().catch(() => ({})) as Preview & { refusal?: string };
    if (!r.ok) { setProblems([body.refusal ?? `No preview (${r.status}).`, ...(body.problems ?? [])]); return; }
    setPreview(body);
    setProblems(body.problems ?? []);
  };

  const promote = async (versionId: number | null) => {
    if (!fam) return;
    const name = versionName(fam.versions.find((v) => v.id === versionId));
    setBusy("promote"); setProblems([]); setNotice("");
    const result = await promoteRecipeVersion({
      family: fam.family, versionId, name,
      labelFor: (k) => data?.pieces.find((p) => p.key === k)?.label ?? k,
    });
    setBusy("");
    if (!result) return;
    if (!result.ok) { setProblems([result.message]); return; }
    setNotice(result.message);
    await load();
  };

  const groups = useMemo(() => {
    const out = new Map<string, PieceDef[]>();
    for (const p of data?.pieces ?? []) out.set(p.group, [...(out.get(p.group) ?? []), p]);
    return [...out];
  }, [data]);

  if (error) return <p className="text-sm text-destructive flex items-center gap-1.5" data-testid="recipes-error"><AlertTriangle className="w-4 h-4" /> {error}</p>;
  if (!data) return <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />;
  if (data.families.length === 0) return <p className="text-sm text-muted-foreground">No image engines are set up.</p>;

  const live = fam?.versions.find((v) => v.id === fam.liveVersionId) ?? null;

  return (
    <section className="space-y-3" data-testid="prompt-recipes">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Prompt wording</h2>
          <p className="text-xs text-muted-foreground">The wording every fact's prompt shares, per engine. Saving makes a new version and changes nothing live.</p>
        </div>
        <label className="text-xs text-muted-foreground space-y-1">
          <span className="block">Engine</span>
          <select value={family} disabled={busy !== ""} onChange={(e) => pickFamily(e.target.value)} data-testid="recipes-family" className="rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground">
            {data.families.map((f) => <option key={f.family} value={f.family}>{f.family}</option>)}
          </select>
        </label>
        {fam && <p className="text-xs text-foreground" data-testid="recipes-live">Live: <strong>{versionName(live)}</strong></p>}
      </div>

      {fam && (
        <div className="rounded-sm border border-border bg-background p-3 space-y-2" data-testid="recipes-versions">
          <p className="text-xs font-bold text-foreground">Versions</p>
          <ul className="text-xs space-y-1">
            {[...fam.versions, null].map((v) => {
              const id = v?.id ?? null;
              const isLive = fam.liveVersionId === id;
              return (
                <li key={id ?? "baseline"} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-foreground">{versionName(v)}</span>
                  {v && <span className="text-muted-foreground">— {v.note} · {new Date(v.createdAt).toLocaleString()}</span>}
                  {isLive && <span className="inline-flex items-center gap-1 text-green-600"><CheckCircle2 className="w-3 h-3" /> live</span>}
                  <button type="button" disabled={busy !== ""} onClick={() => pickBase(id)} className="underline text-primary disabled:opacity-40" data-testid={`recipes-edit-${id ?? "baseline"}`}>edit from this</button>
                  {!isLive && (
                    <button type="button" disabled={busy !== ""} onClick={() => void promote(id)} className="px-2 py-0.5 rounded-sm border border-border hover:bg-muted disabled:opacity-40" data-testid={`recipes-promote-${id ?? "baseline"}`}>
                      {id == null ? "Restore baseline" : "Promote"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {fam && (
        <div className="rounded-sm border border-border bg-background p-3 space-y-3" data-testid="recipes-editor">
          <p className="text-xs text-foreground">Editing from <strong>{versionName(baseVersion)}</strong>{changed.length > 0 ? ` · ${changed.length} piece${changed.length === 1 ? "" : "s"} changed` : ""}{changedPolicy.length > 0 ? " · includes a policy line" : ""}</p>
          {groups.map(([group, defs]) => (
            <details key={group} className="rounded-sm border border-dashed border-border p-2" open={defs.some((d) => changed.includes(d.key))}>
              <summary className="cursor-pointer text-xs font-bold text-foreground">{GROUP_LABEL[group] ?? group}</summary>
              <div className="mt-2 space-y-3">
                {defs.map((d) => {
                  const value = draft[d.key] ?? basePieces[d.key] ?? "";
                  const isChanged = changed.includes(d.key);
                  return (
                    <label key={d.key} className="block space-y-1">
                      <span className="flex flex-wrap items-center gap-2 text-xs">
                        <span className={`font-semibold ${isChanged ? "text-primary" : "text-foreground"}`}>{d.label}</span>
                        {d.policy && <span className="px-1 rounded-sm bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 text-[10px] font-bold uppercase">policy</span>}
                        {d.slots.length > 0 && <span className="font-mono text-muted-foreground">must keep {d.slots.map((s) => `{${s}}`).join(" ")}</span>}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">{d.when}</span>
                      <textarea
                        value={value}
                        readOnly={busy === "save"}
                        onChange={(e) => setDraft((prev) => ({ ...prev, [d.key]: e.target.value }))}
                        rows={d.group === "labels" ? 1 : Math.min(6, Math.max(2, Math.ceil(value.length / 90)))}
                        data-testid={`recipes-piece-${d.key}`}
                        className={`w-full rounded-sm border bg-background px-2 py-1 text-sm text-foreground ${isChanged ? "border-primary" : "border-border"}`}
                      />
                    </label>
                  );
                })}
              </div>
            </details>
          ))}

          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-muted-foreground space-y-1 grow">
              <span className="block">What changed, and why</span>
              <input value={note} readOnly={busy === "save"} onChange={(e) => setNote(e.target.value)} data-testid="recipes-note" className="w-full rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground" />
            </label>
            <button type="button" onClick={() => void save()} disabled={busy !== "" || changed.length === 0 || !note.trim()} data-testid="recipes-save" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-bold rounded-sm bg-primary text-white hover:opacity-90 disabled:opacity-40">
              {busy === "save" && <Loader2 className="w-4 h-4 animate-spin" />} Save as a new version
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-2 border-t border-border pt-2">
            <label className="text-xs text-muted-foreground space-y-1">
              <span className="block">Preview on fact #</span>
              <input value={factId} onChange={(e) => setFactId(e.target.value)} inputMode="numeric" data-testid="recipes-preview-fact" className="w-28 rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground" />
            </label>
            <label className="text-xs text-muted-foreground space-y-1">
              <span className="block">Photo</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} data-testid="recipes-preview-mode" className="rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground">
                {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => void runPreview()} disabled={busy !== ""} data-testid="recipes-preview" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-sm border border-border hover:bg-muted disabled:opacity-40">
              {busy === "preview" && <Loader2 className="w-4 h-4 animate-spin" />} Preview the whole prompt
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">The preview uses the fact's most recent stored render plan for that kind of photo, compiled with this wording. It makes no AI call and costs nothing.</p>

          {problems.length > 0 && (
            <ul className="text-sm text-destructive space-y-0.5" data-testid="recipes-problems">
              {problems.map((p) => <li key={p} className="flex items-start gap-1.5"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {p}</li>)}
            </ul>
          )}
          {notice && <p className="text-sm text-foreground" data-testid="recipes-notice">{notice}</p>}

          {preview && (
            <div className="space-y-1" data-testid="recipes-preview-result">
              <p className="text-xs text-muted-foreground">{preview.length.toLocaleString()} characters{preview.overflowBy > 0 ? `, ${preview.overflowBy} over the limit` : ""}</p>
              <p className="text-xs text-muted-foreground" data-testid="recipes-preview-legend">
                <mark className="bg-amber-200 dark:bg-amber-700 text-foreground px-0.5 rounded-sm">Your changes</mark>{" "}
                <span className="text-sky-700 dark:text-sky-300 underline decoration-dotted">Shared wording</span>{" "}
                · plain text is written for this fact.
              </p>
              <div className="rounded-sm border border-border p-2 space-y-1 text-xs font-mono text-foreground whitespace-pre-wrap break-words">
                {preview.sections.filter((s) => s.text).map((s) => (
                  <p key={s.id} className={s.status === "compressed" ? "opacity-80" : ""} title={s.status === "compressed" ? "Shortened to fit the prompt" : undefined}>
                    {(s.segments ?? [{ text: s.text, piece: null }]).map((g, i) => g.piece == null
                      ? <span key={i}>{g.text}</span>
                      : changedSet.has(g.piece)
                        ? <mark key={i} data-piece={g.piece} data-changed="true" title={pieceLabel(g.piece)} className="bg-amber-200 dark:bg-amber-700 text-foreground rounded-sm">{g.text}</mark>
                        : <span key={i} data-piece={g.piece} title={pieceLabel(g.piece)} className="text-sky-700 dark:text-sky-300 underline decoration-dotted">{g.text}</span>)}
                    {s.status === "compressed" && <span className="text-amber-600 dark:text-amber-400"> (shortened to fit)</span>}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
