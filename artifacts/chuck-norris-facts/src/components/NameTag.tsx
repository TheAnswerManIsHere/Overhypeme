import { useState, useRef, useEffect } from "react";
import { Pencil, Check, X } from "lucide-react";
import { usePersonName } from "@/hooks/use-person-name";

export function NameTag() {
  const { name, setName } = usePersonName();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  function openEditor() {
    setDraft(name);
    setEditing(true);
  }

  function save() {
    setName(draft);
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
      <div className="flex items-center gap-1 bg-secondary border border-primary/40 rounded-sm px-2 py-1">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Your name"
          className="w-36 bg-transparent text-sm font-bold text-foreground outline-none placeholder:text-muted-foreground"
        />
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
      title="Change name"
    >
      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide hidden sm:block">As:</span>
      <span className="text-sm font-bold text-foreground font-display">{name}</span>
      <Pencil className="w-3 h-3 text-muted-foreground group-hover:text-primary transition-colors" />
    </button>
  );
}
