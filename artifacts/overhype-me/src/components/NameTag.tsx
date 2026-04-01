import { useState, useRef, useEffect, useCallback } from "react";
import { Pencil, Check, X, Loader2 } from "lucide-react";
import { usePersonName } from "@/hooks/use-person-name";
import { useAuth } from "@workspace/replit-auth-web";
import { useLocation } from "wouter";
import { displayPronouns, PRONOUN_PRESETS, DEFAULT_PRONOUNS } from "@/lib/pronouns";
import { PronounEditor } from "@/components/ui/PronounEditor";

// ── AI pronoun suggestion ─────────────────────────────────────────────────────

async function fetchSuggestedPronouns(
  name: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetch("/api/ai/suggest-pronouns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal,
    });
    if (!res.ok) return null;
    const data = await res.json() as { subject?: string; object?: string };
    if (typeof data.subject === "string" && typeof data.object === "string") {
      // Convert subject/object to full preset string if recognised
      const preset = `${data.subject}/${data.object}`;
      if (PRONOUN_PRESETS.includes(preset as typeof PRONOUN_PRESETS[number])) {
        return preset;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function NameTag() {
  const { name, pronouns, pronounSubject, pronounObject, setName, setPronouns } = usePersonName();
  const { user, isAuthenticated, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  const [editing,       setEditing]       = useState(false);
  const [draftName,     setDraftName]     = useState(name);
  const [draftPronouns, setDraftPronouns] = useState(pronouns);
  const [aiLoading,     setAiLoading]     = useState(false);

  // Whether the user has manually selected a pronoun option — suppresses AI override
  const userChosenRef     = useRef(false);
  const draftPronounsRef  = useRef(draftPronouns);
  const debounceTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const nameRef           = useRef<HTMLInputElement>(null);
  const panelRef          = useRef<HTMLDivElement>(null);

  draftPronounsRef.current = draftPronouns;

  function handleOpen() {
    if (isAuthenticated) {
      setLocation("/profile");
      return;
    }
    setDraftName(name);
    setDraftPronouns(pronouns);
    userChosenRef.current = false;
    setEditing(true);
  }

  function save() {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    abortControllerRef.current?.abort();
    setAiLoading(false);
    setName(draftName);
    setPronouns(draftPronouns);
    setEditing(false);
  }

  function cancel() {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    abortControllerRef.current?.abort();
    setAiLoading(false);
    setEditing(false);
  }

  // Close on outside click
  useEffect(() => {
    if (!editing) return;
    function onMouseDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) cancel();
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [editing]);

  // Cleanup timers/controllers on unmount
  useEffect(() => () => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    abortControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    if (editing) nameRef.current?.focus();
  }, [editing]);

  // ── AI suggestion on name change ────────────────────────────────────────────

  const triggerSuggestion = useCallback((nameValue: string) => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    if (!nameValue.trim()) {
      abortControllerRef.current?.abort();
      setAiLoading(false);
      return;
    }

    debounceTimerRef.current = setTimeout(async () => {
      // Skip if user already manually picked pronouns
      if (userChosenRef.current) return;

      // Skip if pronouns are already non-default (user had custom set from before)
      const current = draftPronounsRef.current;
      const isDefault = current === DEFAULT_PRONOUNS || current === "";
      if (!isDefault) return;

      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setAiLoading(true);
      const suggestion = await fetchSuggestedPronouns(nameValue.trim(), controller.signal);
      if (controller.signal.aborted) return;
      setAiLoading(false);

      if (suggestion && !userChosenRef.current) {
        setDraftPronouns(suggestion);
      }
    }, 450);
  }, []);

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    setDraftName(e.target.value);
    triggerSuggestion(e.target.value);
  }

  function handlePronounsChange(val: string) {
    userChosenRef.current = true;       // user explicitly chose — don't override
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    abortControllerRef.current?.abort();
    setAiLoading(false);
    setDraftPronouns(val);
  }

  function onNameKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") cancel();
    if (e.key === "Enter") save();
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 bg-secondary border border-border rounded-sm px-3 py-1.5 opacity-0 pointer-events-none">
        <span className="text-xs font-medium uppercase tracking-wide hidden sm:block">As:</span>
        <span className="text-sm font-bold font-display">···</span>
      </div>
    );
  }

  if (isAuthenticated && user) {
    const displayName = (user as { firstName?: string }).firstName
      || (user as { email?: string }).email
      || "User";
    const rawPronouns = (user as { pronouns?: string }).pronouns;
    const pronounsStr = rawPronouns ? displayPronouns(rawPronouns) : null;

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

  const displayPron = displayPronouns(pronouns) || `${pronounSubject}/${pronounObject}`;

  return (
    <div className="relative">
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

      {editing && (
        <div
          ref={panelRef}
          className="absolute top-full left-0 mt-1 z-50 bg-background border border-border rounded-sm shadow-lg p-3 w-72"
        >
          {/* Name row */}
          <div className="flex items-center gap-2 mb-3">
            <input
              ref={nameRef}
              value={draftName}
              onChange={handleNameChange}
              onKeyDown={onNameKeyDown}
              placeholder="Your name"
              className="flex-1 bg-secondary border border-border rounded-sm px-2 py-1 text-sm font-bold text-foreground outline-none focus:border-primary transition-colors placeholder:text-muted-foreground"
            />
            {aiLoading && (
              <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin shrink-0" />
            )}
            <button onClick={save}   className="p-1 text-primary hover:text-primary/80 transition-colors" title="Save">
              <Check className="w-4 h-4" />
            </button>
            <button onClick={cancel} className="p-1 text-muted-foreground hover:text-foreground transition-colors" title="Cancel">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Pronoun section */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Pronouns</p>
              {aiLoading && (
                <span className="text-[10px] text-muted-foreground italic">suggesting…</span>
              )}
            </div>
            <PronounEditor value={draftPronouns} onChange={handlePronounsChange} />
          </div>
        </div>
      )}
    </div>
  );
}
