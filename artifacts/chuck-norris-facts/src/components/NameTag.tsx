import { useState, useRef, useEffect } from "react";
import { Pencil, Check, X } from "lucide-react";
import { usePersonName } from "@/hooks/use-person-name";

export function NameTag() {
  const { firstName, lastName, setName } = usePersonName();
  const [editing, setEditing] = useState(false);
  const [draftFirst, setDraftFirst] = useState(firstName);
  const [draftLast,  setDraftLast]  = useState(lastName);
  const firstRef = useRef<HTMLInputElement>(null);

  function openEditor() {
    setDraftFirst(firstName);
    setDraftLast(lastName);
    setEditing(true);
  }

  function save() {
    setName(draftFirst, draftLast);
    setEditing(false);
  }

  function cancel() {
    setEditing(false);
  }

  useEffect(() => {
    if (editing) firstRef.current?.focus();
  }, [editing]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") save();
    if (e.key === "Escape") cancel();
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1 bg-secondary border border-primary/40 rounded-sm px-2 py-1">
        <input
          ref={firstRef}
          value={draftFirst}
          onChange={(e) => setDraftFirst(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="First"
          className="w-20 bg-transparent text-sm font-bold text-foreground outline-none placeholder:text-muted-foreground"
        />
        <span className="text-muted-foreground text-xs">·</span>
        <input
          value={draftLast}
          onChange={(e) => setDraftLast(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Last"
          className="w-20 bg-transparent text-sm font-bold text-foreground outline-none placeholder:text-muted-foreground"
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
      <span className="text-sm font-bold text-foreground font-display">
        {firstName} {lastName}
      </span>
      <Pencil className="w-3 h-3 text-muted-foreground group-hover:text-primary transition-colors" />
    </button>
  );
}
