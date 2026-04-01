import { useState, useRef, useEffect } from "react";
import { Pencil, Check, X } from "lucide-react";
import { usePersonName } from "@/hooks/use-person-name";
import { useAuth } from "@workspace/replit-auth-web";
import { useLocation } from "wouter";
import { PRONOUN_PRESETS, displayPronouns, isCustomPronouns } from "@/lib/pronouns";

export function NameTag() {
  const { name, pronouns, pronounSubject, pronounObject, setName, setPronouns } = usePersonName();
  const { user, isAuthenticated, isLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [editing, setEditing] = useState(false);
  const [draftName,    setDraftName]    = useState(name);
  const [draftSubject, setDraftSubject] = useState(pronounSubject);
  const [draftObject,  setDraftObject]  = useState(pronounObject);
  const nameRef = useRef<HTMLInputElement>(null);

  function handleOpen() {
    if (isAuthenticated) {
      setLocation("/profile");
      return;
    }
    setDraftName(name);
    setDraftSubject(pronounSubject);
    setDraftObject(pronounObject);
    setEditing(true);
  }

  function save() {
    setName(draftName);
    const sub = draftSubject.trim() || "he";
    const obj = draftObject.trim()  || "him";
    setPronouns(`${sub}/${obj}`);
    setEditing(false);
  }

  function cancel() {
    setEditing(false);
  }

  function selectPreset(preset: string) {
    const [s = "he", o = "him"] = preset.split("/");
    setDraftSubject(s);
    setDraftObject(o);
  }

  useEffect(() => {
    if (editing) nameRef.current?.focus();
  }, [editing]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") save();
    if (e.key === "Escape") cancel();
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 bg-secondary border border-border rounded-sm px-3 py-1.5 opacity-0 pointer-events-none">
        <span className="text-xs font-medium uppercase tracking-wide hidden sm:block">As:</span>
        <span className="text-sm font-bold font-display">···</span>
      </div>
    );
  }

  if (isAuthenticated && user) {
    const displayName = user.firstName || user.email || "User";
    const pronounsStr = user.pronouns ? displayPronouns(user.pronouns) : null;

    return (
      <button
        onClick={() => setLocation("/profile")}
        className="group flex items-center gap-1.5 bg-secondary hover:bg-secondary/80 border border-border hover:border-primary/40 rounded-sm px-3 py-1.5 transition-all"
        title="Edit your profile"
      >
        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide hidden sm:block">As:</span>
        <span className="text-sm font-bold text-foreground font-display">{displayName}</span>
        {pronounsStr && (
          <span className="text-xs text-muted-foreground">({pronounsStr})</span>
        )}
        <Pencil className="w-3 h-3 text-muted-foreground group-hover:text-primary transition-colors" />
      </button>
    );
  }

  if (editing) {
    const activePreset = PRONOUN_PRESETS.find((p) => p === `${draftSubject}/${draftObject}`) ?? null;

    return (
      <div className="flex flex-col gap-1.5 bg-secondary border border-primary/40 rounded-sm px-2 py-1.5 min-w-[180px]">
        {/* Name row */}
        <div className="flex items-center gap-1.5">
          <input
            ref={nameRef}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Your name"
            className="flex-1 bg-transparent text-sm font-bold text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button onClick={save}   className="p-0.5 text-primary hover:text-primary/80 transition-colors" title="Save">
            <Check className="w-3.5 h-3.5" />
          </button>
          <button onClick={cancel} className="p-0.5 text-muted-foreground hover:text-foreground transition-colors" title="Cancel">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        {/* Pronoun row: 3 chips + custom subject/object inputs */}
        <div className="flex items-center gap-1 flex-wrap">
          {PRONOUN_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => selectPreset(p)}
              className={`px-2 py-0.5 rounded-sm border text-[11px] font-medium transition-colors ${
                activePreset === p
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
        {/* Custom subject / object (for any set not in the 3 presets) */}
        {!activePreset && (
          <div className="flex items-center gap-1 text-[11px]">
            <input
              value={draftSubject}
              onChange={(e) => setDraftSubject(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="subj"
              title="Subject pronoun"
              className="w-9 bg-transparent font-bold outline-none placeholder:text-muted-foreground/50 text-center text-muted-foreground border-b border-border"
              maxLength={12}
            />
            <span className="text-border select-none">/</span>
            <input
              value={draftObject}
              onChange={(e) => setDraftObject(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="obj"
              title="Object pronoun"
              className="w-9 bg-transparent font-bold outline-none placeholder:text-muted-foreground/50 text-center text-muted-foreground border-b border-border"
              maxLength={12}
            />
          </div>
        )}
      </div>
    );
  }

  const displayPron = isCustomPronouns(pronouns)
    ? displayPronouns(pronouns)
    : `${pronounSubject}/${pronounObject}`;

  return (
    <button
      onClick={handleOpen}
      className="group flex items-center gap-1.5 bg-secondary hover:bg-secondary/80 border border-border hover:border-primary/40 rounded-sm px-3 py-1.5 transition-all"
      title="Change name & pronouns"
    >
      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide hidden sm:block">As:</span>
      <span className="text-sm font-bold text-foreground font-display">{name}</span>
      <span className="text-xs text-muted-foreground">({displayPron})</span>
      <Pencil className="w-3 h-3 text-muted-foreground group-hover:text-primary transition-colors" />
    </button>
  );
}
