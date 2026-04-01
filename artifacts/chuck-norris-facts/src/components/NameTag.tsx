import { useState, useRef, useEffect } from "react";
import { Pencil, Check, X } from "lucide-react";
import { usePersonName } from "@/hooks/use-person-name";
import type { PronounSet } from "@/lib/render-fact";

const PRONOUN_OPTIONS: { value: PronounSet; label: string }[] = [
  { value: "he/him",   label: "he/him"   },
  { value: "she/her",  label: "she/her"  },
  { value: "they/them", label: "they/them" },
];

export function NameTag() {
  const { name, pronouns, setName, setPronouns } = usePersonName();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const [draftPronouns, setDraftPronouns] = useState<PronounSet>(pronouns);
  const inputRef = useRef<HTMLInputElement>(null);

  function openEditor() {
    setDraftName(name);
    setDraftPronouns(pronouns);
    setEditing(true);
  }

  function save() {
    setName(draftName);
    setPronouns(draftPronouns);
    setEditing(false);
  }

  function cancel() {
    setEditing(false);
  }

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") save();
    if (e.key === "Escape") cancel();
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 bg-secondary border border-primary/40 rounded-sm px-2 py-1">
        <input
          ref={inputRef}
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Your name"
          className="w-32 bg-transparent text-sm font-bold text-foreground outline-none placeholder:text-muted-foreground"
        />
        <span className="text-border text-xs">·</span>
        <select
          value={draftPronouns}
          onChange={(e) => setDraftPronouns(e.target.value as PronounSet)}
          className="bg-transparent text-xs font-bold text-muted-foreground outline-none cursor-pointer hover:text-foreground transition-colors"
        >
          {PRONOUN_OPTIONS.map((o) => (
            <option key={o.value} value={o.value} className="bg-background">
              {o.label}
            </option>
          ))}
        </select>
        <button onClick={save} className="p-0.5 text-primary hover:text-primary/80 transition-colors" title="Save">
          <Check className="w-3.5 h-3.5" />
        </button>
        <button onClick={cancel} className="p-0.5 text-muted-foreground hover:text-foreground transition-colors" title="Cancel">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={openEditor}
      className="group flex items-center gap-1.5 bg-secondary hover:bg-secondary/80 border border-border hover:border-primary/40 rounded-sm px-3 py-1.5 transition-all"
      title="Change name & pronouns"
    >
      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide hidden sm:block">As:</span>
      <span className="text-sm font-bold text-foreground font-display">{name}</span>
      <span className="text-xs text-muted-foreground hidden lg:block">({pronouns})</span>
      <Pencil className="w-3 h-3 text-muted-foreground group-hover:text-primary transition-colors" />
    </button>
  );
}
