import { useCallback, useEffect, useRef, useState } from "react";
import { getHeroFact, type FactSummary } from "@workspace/api-client-react";

const STORAGE_KEY_RECENT = "overhype_hero_seen";
const SESSION_KEY_PICK   = "overhype_hero_pick";
const RECENT_CAP         = 20;

function readRecent(): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_RECENT);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((n) => typeof n === "number").slice(0, RECENT_CAP);
  } catch {
    return [];
  }
}

function pushRecent(id: number) {
  try {
    const next = [id, ...readRecent().filter((n) => n !== id)].slice(0, RECENT_CAP);
    localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(next));
  } catch { /* ignore */ }
}

function readSessionPick(): FactSummary | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY_PICK);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "id" in parsed) return parsed as FactSummary;
    return null;
  } catch {
    return null;
  }
}

function writeSessionPick(fact: FactSummary | null) {
  try {
    if (fact) sessionStorage.setItem(SESSION_KEY_PICK, JSON.stringify(fact));
    else      sessionStorage.removeItem(SESSION_KEY_PICK);
  } catch { /* ignore */ }
}

interface UseHeroFactReturn {
  fact:      FactSummary | null;
  isLoading: boolean;
  error:     string | null;
  /** Pick a brand-new hero (excluding the current pick + recent history). */
  shuffle:   () => void;
}

/**
 * Pulls a weighted-random hero fact from the API and remembers the pick for
 * the lifetime of the browser tab via sessionStorage (so the home page hero
 * doesn't reshuffle every render or every navigation back to /).
 *
 * Across visits/tabs we keep a localStorage list of the last ~20 hero IDs
 * we've shown; those get sent to the server as `?exclude=` so the rotator
 * doesn't repeat itself on this device until the pool wraps.
 */
export function useHeroFact(): UseHeroFactReturn {
  const [fact, setFact]           = useState<FactSummary | null>(() => readSessionPick());
  const [isLoading, setLoading]   = useState<boolean>(() => readSessionPick() === null);
  const [error, setError]         = useState<string | null>(null);
  const inflightRef               = useRef<AbortController | null>(null);

  const fetchHero = useCallback(async (extraExclude: number[] = []) => {
    inflightRef.current?.abort();
    const ctrl = new AbortController();
    inflightRef.current = ctrl;
    setLoading(true);
    setError(null);

    const exclude = Array.from(new Set([...readRecent(), ...extraExclude]))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, 50);

    try {
      const res = await getHeroFact(
        exclude.length > 0 ? { exclude: exclude.join(",") } : {},
        { signal: ctrl.signal },
      );
      if (ctrl.signal.aborted) return;
      setFact(res.fact);
      writeSessionPick(res.fact);
      pushRecent(res.fact.id);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      setError((err as Error)?.message ?? "Failed to load hero fact");
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  // First mount: only fetch when we don't already have a sticky session pick.
  useEffect(() => {
    if (fact) {
      setLoading(false);
      return;
    }
    void fetchHero();
    return () => inflightRef.current?.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shuffle = useCallback(() => {
    void fetchHero(fact ? [fact.id] : []);
  }, [fact, fetchHero]);

  return { fact, isLoading, error, shuffle };
}
