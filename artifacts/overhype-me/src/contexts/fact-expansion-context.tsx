import { createContext, useCallback, useContext, useRef, useState } from "react";

interface FactExpansionContextValue {
  isExpanded: (factId: number) => boolean;
  toggle: (factId: number) => void;
  collapse: (factId: number) => void;
  getDraft: (factId: number) => string;
  setDraft: (factId: number, text: string) => void;
}

const FactExpansionContext = createContext<FactExpansionContextValue | null>(null);

export function FactExpansionProvider({ children }: { children: React.ReactNode }) {
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  /**
   * Draft texts are stored in a plain ref — no re-render needed on change.
   * The value is only consumed as the initial `draft` prop when FactCardComments
   * mounts (or remounts), so it just has to be up-to-date at that point.
   */
  const draftsRef = useRef<Map<number, string>>(new Map());

  const isExpanded = useCallback(
    (factId: number) => expandedIds.has(factId),
    [expandedIds]
  );

  const toggle = useCallback((factId: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(factId)) {
        next.delete(factId);
      } else {
        next.add(factId);
      }
      return next;
    });
  }, []);

  const collapse = useCallback((factId: number) => {
    setExpandedIds((prev) => {
      if (!prev.has(factId)) return prev;
      const next = new Set(prev);
      next.delete(factId);
      return next;
    });
  }, []);

  const getDraft = useCallback(
    (factId: number) => draftsRef.current.get(factId) ?? "",
    []
  );

  const setDraft = useCallback((factId: number, text: string) => {
    if (text) {
      draftsRef.current.set(factId, text);
    } else {
      draftsRef.current.delete(factId);
    }
  }, []);

  return (
    <FactExpansionContext.Provider
      value={{ isExpanded, toggle, collapse, getDraft, setDraft }}
    >
      {children}
    </FactExpansionContext.Provider>
  );
}

export function useFactExpansion() {
  const ctx = useContext(FactExpansionContext);
  if (!ctx) {
    throw new Error("useFactExpansion must be used within FactExpansionProvider");
  }
  return ctx;
}
