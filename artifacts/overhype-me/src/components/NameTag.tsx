import { useState, useRef, useEffect, useCallback } from "react";
import { Pencil, Check, X, Loader2 } from "lucide-react";
import { usePersonName, DEFAULT_PRONOUN_SUBJECT, DEFAULT_PRONOUN_OBJECT } from "@/hooks/use-person-name";
import { useAuth } from "@workspace/replit-auth-web";
import { useLocation } from "wouter";

async function fetchSuggestedPronouns(
  name: string,
  signal: AbortSignal,
): Promise<{ subject: string; object: string } | null> {
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
      return { subject: data.subject, object: data.object };
    }
    return null;
  } catch {
    return null;
  }
}

export function NameTag() {
  const { name, pronounSubject, pronounObject, setName, setPronouns } = usePersonName();
  const { user, isAuthenticated, isLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [editing, setEditing] = useState(false);
  const [draftName,    setDraftName]    = useState(name);
  const [draftSubject, setDraftSubject] = useState(pronounSubject);
  const [draftObject,  setDraftObject]  = useState(pronounObject);
  const [pronounsLoading, setPronounsLoading] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const pronounsManuallyEditedRef = useRef(false);
  const initialSubjectRef = useRef(pronounSubject);
  const initialObjectRef = useRef(pronounObject);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  function openEditor() {
    if (isAuthenticated) {
      setLocation("/profile");
      return;
    }
    initialSubjectRef.current = pronounSubject;
    initialObjectRef.current  = pronounObject;
    setDraftName(name);
    setDraftSubject(pronounSubject);
    setDraftObject(pronounObject);
    pronounsManuallyEditedRef.current = false;
    setEditing(true);
  }

  function save() {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setPronounsLoading(false);
    setName(draftName);
    setPronouns(draftSubject, draftObject);
    setEditing(false);
  }

  function cancel() {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    abortControllerRef.current?.abort();
    setPronounsLoading(false);
    setEditing(false);
  }

  useEffect(() => {
    if (editing) nameRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      abortControllerRef.current?.abort();
    };
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") save();
    if (e.key === "Escape") cancel();
  }

  const triggerPronounSuggestion = useCallback((nameValue: string) => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    if (!nameValue.trim()) {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      setPronounsLoading(false);
      return;
    }

    debounceTimerRef.current = setTimeout(async () => {
      if (pronounsManuallyEditedRef.current) return;

      const initSubject = initialSubjectRef.current;
      const initObject  = initialObjectRef.current;
      const pronounsAreDefault =
        initSubject === DEFAULT_PRONOUN_SUBJECT && initObject === DEFAULT_PRONOUN_OBJECT;

      if (!pronounsAreDefault) return;

      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setPronounsLoading(true);
      const suggestion = await fetchSuggestedPronouns(nameValue.trim(), controller.signal);
      if (controller.signal.aborted) return;
      setPronounsLoading(false);

      if (suggestion && !pronounsManuallyEditedRef.current) {
        setDraftSubject(suggestion.subject);
        setDraftObject(suggestion.object);
      }
    }, 400);
  }, []);

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value;
    setDraftName(value);
    triggerPronounSuggestion(value);
  }

  function handleSubjectChange(e: React.ChangeEvent<HTMLInputElement>) {
    pronounsManuallyEditedRef.current = true;
    setDraftSubject(e.target.value);
  }

  function handleObjectChange(e: React.ChangeEvent<HTMLInputElement>) {
    pronounsManuallyEditedRef.current = true;
    setDraftObject(e.target.value);
  }

  // While auth state is loading, render nothing to avoid flash of editable state
  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 bg-secondary border border-border rounded-sm px-3 py-1.5 opacity-0 pointer-events-none">
        <span className="text-xs font-medium uppercase tracking-wide hidden sm:block">As:</span>
        <span className="text-sm font-bold font-display">···</span>
      </div>
    );
  }

  // When authenticated, show account name with pencil that navigates to profile
  if (isAuthenticated && user) {
    const displayName = user.firstName || user.email || "User";
    const pronounsDisplay = user.pronouns || null;

    return (
      <button
        onClick={() => setLocation("/profile")}
        className="group flex items-center gap-1.5 bg-secondary hover:bg-secondary/80 border border-border hover:border-primary/40 rounded-sm px-3 py-1.5 transition-all"
        title="Edit your profile"
      >
        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide hidden sm:block">As:</span>
        <span className="text-sm font-bold text-foreground font-display">{displayName}</span>
        {pronounsDisplay && (
          <span className="text-xs text-muted-foreground">({pronounsDisplay})</span>
        )}
        <Pencil className="w-3 h-3 text-muted-foreground group-hover:text-primary transition-colors" />
      </button>
    );
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 bg-secondary border border-primary/40 rounded-sm px-2 py-1">
        <input
          ref={nameRef}
          value={draftName}
          onChange={handleNameChange}
          onKeyDown={onKeyDown}
          placeholder="Your name"
          className="w-28 bg-transparent text-sm font-bold text-foreground outline-none placeholder:text-muted-foreground"
        />
        <span className="text-border text-xs select-none">·</span>
        {pronounsLoading ? (
          <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin shrink-0" />
        ) : null}
        <input
          value={draftSubject}
          onChange={handleSubjectChange}
          onKeyDown={onKeyDown}
          placeholder="he"
          title="Subject pronoun (he, she, they…)"
          className={`w-9 bg-transparent text-xs font-bold outline-none placeholder:text-muted-foreground/50 text-center transition-opacity ${pronounsLoading ? "text-muted-foreground/50" : "text-muted-foreground"}`}
        />
        <span className="text-border text-xs select-none">/</span>
        <input
          value={draftObject}
          onChange={handleObjectChange}
          onKeyDown={onKeyDown}
          placeholder="him"
          title="Object pronoun (him, her, them…)"
          className={`w-9 bg-transparent text-xs font-bold outline-none placeholder:text-muted-foreground/50 text-center transition-opacity ${pronounsLoading ? "text-muted-foreground/50" : "text-muted-foreground"}`}
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
      title="Change name & pronouns"
    >
      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide hidden sm:block">As:</span>
      <span className="text-sm font-bold text-foreground font-display">{name}</span>
      <span className="text-xs text-muted-foreground">({pronounSubject}/{pronounObject})</span>
      <Pencil className="w-3 h-3 text-muted-foreground group-hover:text-primary transition-colors" />
    </button>
  );
}
