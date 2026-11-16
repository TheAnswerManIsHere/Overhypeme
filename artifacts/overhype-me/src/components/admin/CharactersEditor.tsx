/**
 * The fact's Characters (PLAN_BUBBLE_SPEAKERS.md, D): every person or animal
 * the fact names besides the subject — the speaker choices in each gag's
 * bubble editor. A moderator corrects the list here; the correction is one
 * whole-list override that re-enrichment keeps.
 *
 * Edits are held locally until the whole list is valid (a label, unique, not a
 * token or "subject"), then committed — so a half-typed row never reaches the
 * server as an invalid override. Errors show on the row they belong to.
 */
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import {
  FACT_CHARACTER_KIND_VALUES,
  factCharactersSchema,
  BUBBLE_ENTITY_MAX_CHARS,
  type FactCharacter,
  type FactCharacterKind,
} from "@workspace/api-zod";
import { FieldLabel } from "./FieldInfo";
import { characterDisplayName } from "./speakerOptions";

const INPUT_CLASS =
  "w-full px-3 py-2 bg-background border border-border rounded-sm text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary";

type Row = FactCharacter;

/** Row index → the first validation message for that row ("" when fine). */
export function characterRowErrors(rows: readonly Row[]): string[] {
  const errors = rows.map(() => "");
  const parsed = factCharactersSchema.safeParse(rows);
  if (parsed.success) return errors;
  for (const issue of parsed.error.issues) {
    const i = typeof issue.path[0] === "number" ? issue.path[0] : -1;
    if (i >= 0 && i < errors.length && !errors[i]) {
      errors[i] = issue.code === "too_small" ? "Give the character a label, e.g. \"mom\"." : issue.message;
    }
  }
  return errors;
}

export function CharactersEditor({
  characters,
  onChange,
  disabled = false,
}: {
  characters: readonly FactCharacter[];
  onChange: (next: FactCharacter[]) => void;
  disabled?: boolean;
}) {
  const [rows, setRows] = useState<Row[]>(() => characters.map((c) => ({ ...c })));
  const incomingKey = JSON.stringify(characters);
  useEffect(() => {
    setRows(characters.map((c) => ({ ...c })));
    // Re-sync only when the stored list itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingKey]);

  const errors = useMemo(() => characterRowErrors(rows), [rows]);

  const commit = (next: Row[]) => {
    setRows(next);
    const trimmed = next.map((r) => ({ ...r, label: r.label.trim() }));
    if (characterRowErrors(trimmed).every((e) => !e) && JSON.stringify(trimmed) !== incomingKey) {
      onChange(trimmed);
    }
  };
  const patch = (i: number, p: Partial<Row>, commitNow: boolean) => {
    const next = rows.slice();
    next[i] = { ...next[i]!, ...p };
    if (commitNow) commit(next);
    else setRows(next);
  };

  return (
    <div className="space-y-2" data-testid="characters-editor">
      <div className="flex items-center justify-between">
        <FieldLabel docKey="characters" className="mb-0" />
        <button
          type="button"
          disabled={disabled}
          onClick={() => setRows([...rows, { label: "", kind: "person", ofSubject: false }])}
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
          data-testid="character-add"
        >
          <Plus className="w-3 h-3" /> Add character
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No characters besides the subject. Add one when the fact names someone — a relative, a pet, a referee — who could speak or think in a bubble.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((c, i) => (
            <div key={i} data-testid="character-row">
              <div className="flex gap-2 items-center">
                <input
                  className={`${INPUT_CLASS} max-w-[12rem]`}
                  data-testid="character-label"
                  aria-label={`Character ${i + 1} label`}
                  value={c.label}
                  placeholder='e.g. "mom"'
                  maxLength={BUBBLE_ENTITY_MAX_CHARS}
                  disabled={disabled}
                  onChange={(ev) => patch(i, { label: ev.target.value }, false)}
                  onBlur={() => commit(rows)}
                />
                <select
                  className={`${INPUT_CLASS} max-w-[7rem]`}
                  data-testid="character-kind"
                  aria-label={`Character ${i + 1} kind`}
                  value={c.kind}
                  disabled={disabled}
                  onChange={(ev) => patch(i, { kind: ev.target.value as FactCharacterKind }, true)}
                >
                  {FACT_CHARACTER_KIND_VALUES.map((k) => (
                    <option key={k} value={k}>{k === "animal" ? "pet / animal" : "person"}</option>
                  ))}
                </select>
                <label className="inline-flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                  <input
                    type="checkbox"
                    data-testid="character-of-subject"
                    checked={c.ofSubject}
                    disabled={disabled}
                    onChange={(ev) => patch(i, { ofSubject: ev.target.checked }, true)}
                  />
                  relation of the subject
                </label>
                <span className="text-xs text-muted-foreground truncate" data-testid="character-display">
                  {c.label.trim() ? `shows as “${characterDisplayName({ ...c, label: c.label.trim() })}”` : ""}
                </span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => commit(rows.filter((_, idx) => idx !== i))}
                  className="ml-auto px-2 py-1 border border-border rounded-sm hover:bg-muted text-muted-foreground disabled:opacity-50"
                  aria-label={`Remove character ${i + 1}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              {errors[i] && (
                <p className="text-xs text-destructive flex items-start gap-1 mt-0.5" data-testid="character-error">
                  <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {errors[i]}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        Renaming or removing a character never changes a bubble already saved; that bubble keeps its speaker and shows it as not in this list.
      </p>
    </div>
  );
}
