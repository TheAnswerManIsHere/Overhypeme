/**
 * @purpose Navbar name tag where a visitor views and edits the name and pronouns their facts render with, with an in-browser pronoun suggestion; signed in, it opens Profile.
 * @subsystem public-site
 */

import { useState, useRef, useEffect } from "react";
import { Pencil } from "lucide-react";
import { usePersonName } from "@/hooks/use-person-name";
import { useAuth } from "@workspace/replit-auth-web";
import { useLocation } from "wouter";
import {
  displayPronouns,
  DEFAULT_PRONOUNS,
  isCustomPronouns,
  parseCustom,
} from "@/lib/pronouns";
import { PronounEditor } from "@/components/ui/PronounEditor";
import { inferPronounsFromName } from "@/lib/infer-pronouns";

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

  const userChosenRef       = useRef(false);   // in-session: the user picked pronouns, stop suggesting
  const hasOverriddenRef    = useRef(false);   // persistent: user overrode the suggestion; only cleared on name change
  const draftPronounsRef    = useRef(draftPronouns);
  const nameRef             = useRef<HTMLInputElement>(null);
  const panelRef            = useRef<HTMLDivElement>(null);

  draftPronounsRef.current = draftPronouns;

  const applyEnabled = canApply(draftPronouns);

  // ── Pronoun suggestion ──────────────────────────────────────────────────────
  // Local only: this editor is reachable signed out (signed in, the tag opens
  // Profile), and a signed-out visitor's name never leaves the browser (#719).

  function suggestFor(nameValue: string) {
    if (userChosenRef.current) return;
    const suggestion = inferPronounsFromName(nameValue.trim());
    if (suggestion) setDraftPronouns(suggestion);
  }

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
    setName(draftName);
    setPronouns(draftPronouns);
    setEditing(false);
  }

  function cancel() {
    setEditing(false);
  }

  // ── Sync logged-in user's display name into the persona context ─────────────
  // Authenticated users always see their own profile name, even on share links.

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

  // On panel open: focus the input and suggest pronouns for the existing name
  // (skipped if the user has already overridden the suggestion for this name)
  useEffect(() => {
    if (!editing) return;
    nameRef.current?.focus();
    if (!hasOverriddenRef.current) {
      suggestFor(draftName);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // ── Event handlers ──────────────────────────────────────────────────────────

  function handlePronounsChange(val: string) {
    userChosenRef.current    = true;  // stop suggesting this session
    hasOverriddenRef.current = true;  // persist: don't re-suggest on next open
    setDraftPronouns(val);
  }

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setDraftName(val);
    hasOverriddenRef.current = false; // name changed → lift override so it can suggest again
    suggestFor(val);
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
    // Always read displayName from PersonNameContext — synced from auth on login
    // and updated immediately after a profile save without needing a token refresh.
    const displayName = name || (user as { displayName?: string }).displayName || "User";
    // Show pronouns if: (a) user has them saved in DB (user.pronouns is set), OR
    // (b) the context value was explicitly changed away from the default this session
    // (e.g., user just saved pronouns for the first time via Profile page).
    // This avoids showing the "he/him" default for users who never set pronouns.
    const userPronounsRaw = (user as { pronouns?: string }).pronouns;
    const pronounsStr = (userPronounsRaw || pronouns !== DEFAULT_PRONOUNS)
      ? (displayPronouns(pronouns) || null)
      : null;

    return (
      <button
        onClick={() => setLocation("/profile")}
        data-action="edit-name"
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
        data-action="edit-name"
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
          </div>

          {/* Pronouns */}
          <div className="mb-3">
            <div className="flex items-center gap-2 mb-1.5">
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Pronouns</p>
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
