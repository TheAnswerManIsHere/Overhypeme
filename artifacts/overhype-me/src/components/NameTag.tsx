import { useState, useRef, useEffect, useCallback } from "react";
import { Pencil, Loader2 } from "lucide-react";
import { usePersonName } from "@/hooks/use-person-name";
import { useAuth } from "@workspace/replit-auth-web";
import { useLocation } from "wouter";
import {
  displayPronouns,
  PRONOUN_PRESETS,
  DEFAULT_PRONOUNS,
  isCustomPronouns,
  parseCustom,
} from "@/lib/pronouns";
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function canApply(draftPronouns: string): boolean {
  if (!isCustomPronouns(draftPronouns)) return true;
  const p = parseCustom(draftPronouns);
  if (!p) return false;
  return !!(p.subj.trim() && p.obj.trim() && p.poss.trim() && p.possPro.trim() && p.refl.trim());
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

  const userChosenRef       = useRef(false);   // in-session: abort ongoing suggestion if user clicks
  const hasOverriddenRef    = useRef(false);   // persistent: user overrode AI; only cleared on name change
  const draftPronounsRef    = useRef(draftPronouns);
  const debounceTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef  = useRef<AbortController | null>(null);
  const nameRef             = useRef<HTMLInputElement>(null);
  const panelRef            = useRef<HTMLDivElement>(null);

  draftPronounsRef.current = draftPronouns;

  const applyEnabled = canApply(draftPronouns);

  // ── AI suggestion (defined early so effects below can reference it) ──────────

  const triggerSuggestion = useCallback((nameValue: string) => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    if (!nameValue.trim()) {
      abortControllerRef.current?.abort();
      setAiLoading(false);
      return;
    }

    debounceTimerRef.current = setTimeout(async () => {
      // Don't override pronouns the user has explicitly clicked in this session
      if (userChosenRef.current) return;

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

  // ── Open / save / cancel ────────────────────────────────────────────────────

  function handleOpen() {
    if (isAuthenticated) {
      setLocation("/profile");
      return;
    }
    setDraftName(name);
    setDraftPronouns(pronouns);
    userChosenRef.current = false;
    // hasOverriddenRef intentionally NOT reset here — persists across opens
    setEditing(true);
  }

  function save() {
    if (!applyEnabled) return;
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

  // ── Sync logged-in user's display name into the persona context ─────────────

  useEffect(() => {
    if (!isAuthenticated || !user) return;
    const userDisplayName = (user as { displayName?: string }).displayName;
    const userPronouns    = (user as { pronouns?: string }).pronouns;
    if (userDisplayName) setName(userDisplayName);
    if (userPronouns)    setPronouns(userPronouns);
  // We only want to run this when the auth user object changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, user]);

  // ── Effects ─────────────────────────────────────────────────────────────────

  // Close on outside click
  useEffect(() => {
    if (!editing) return;
    function onMouseDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) cancel();
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [editing]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    abortControllerRef.current?.abort();
  }, []);

  // On panel open: focus the input and fire AI suggestion for the existing name
  // (skipped if user has already overridden AI for this name)
  useEffect(() => {
    if (!editing) return;
    nameRef.current?.focus();
    if (!hasOverriddenRef.current) {
      triggerSuggestion(draftName);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // ── Event handlers ──────────────────────────────────────────────────────────

  function handlePronounsChange(val: string) {
    userChosenRef.current    = true;  // abort any in-flight suggestion this session
    hasOverriddenRef.current = true;  // persist: don't re-suggest on next open
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    abortControllerRef.current?.abort();
    setAiLoading(false);
    setDraftPronouns(val);
  }

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setDraftName(val);
    hasOverriddenRef.current = false; // name changed → lift override so AI can suggest again
    triggerSuggestion(val);
  }

  function onNameKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") cancel();
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 bg-secondary border border-border rounded-sm px-3 py-1.5 opacity-0 pointer-events-none">
        <span className="text-xs font-medium uppercase tracking-wide hidden sm:block">As:</span>
        <span className="text-sm font-bold font-display">···</span>
      </div>
    );
  }

  if (isAuthenticated && user) {
    const displayName = (user as { displayName?: string }).displayName
      || name
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
      {/* Trigger button */}
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

      {/* Dropdown panel */}
      {editing && (
        <div
          ref={panelRef}
          className="absolute top-full left-0 mt-1 z-50 bg-background border border-border rounded-sm shadow-lg p-3 w-72"
        >
          {/* Name field */}
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
          </div>

          {/* Pronouns */}
          <div className="mb-3">
            <div className="flex items-center gap-2 mb-1.5">
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Pronouns</p>
              {aiLoading && (
                <span className="text-[10px] text-muted-foreground italic">suggesting…</span>
              )}
            </div>
            <PronounEditor value={draftPronouns} onChange={handlePronounsChange} />
          </div>

          {/* Action buttons */}
          <div className="flex gap-2 pt-1 border-t border-border mt-1">
            <button
              onClick={save}
              disabled={!applyEnabled}
              className={`flex-1 py-1.5 rounded-sm text-sm font-bold transition-colors ${
                applyEnabled
                  ? "bg-green-600 hover:bg-green-700 text-white cursor-pointer"
                  : "bg-green-600/30 text-green-600/50 cursor-not-allowed"
              }`}
            >
              Apply
            </button>
            <button
              onClick={cancel}
              className="flex-1 py-1.5 rounded-sm text-sm font-bold bg-destructive/10 hover:bg-destructive/20 text-destructive transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
