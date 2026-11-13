/**
 * @purpose The Eval page (/admin/eval): two tabs, Evaluate Models and Evaluate Prompts, each a wizard that sets up an evaluation and a list of evaluations to judge; the prompt wording editor sits in the prompts tab.
 * @subsystem visual-pipeline
 *
 * Plan `docs/plans/PLAN_EVAL_PAGE.md` (approved by David 2026-11-13). The
 * selected tab lives in the URL (`?tab=models|prompts`), so a link and the
 * back button land on it.
 */
import { useCallback, useEffect, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { EvaluationWizard, type EvaluationKind } from "@/components/admin/EvaluationWizard";
import { EvaluationsList } from "@/components/admin/EvaluationsList";
import { PromptRecipes } from "@/components/admin/PromptRecipes";

type Tab = "models" | "prompts";

function tabFromUrl(): Tab {
  return new URLSearchParams(window.location.search).get("tab") === "prompts" ? "prompts" : "models";
}

const TABS: Array<{ id: Tab; label: string; kind: EvaluationKind; blurb: string }> = [
  { id: "models", label: "Evaluate Models", kind: "engine", blurb: "Draw the same facts with several engines and judge them blind, to choose which engine draws best." },
  { id: "prompts", label: "Evaluate Prompts", kind: "prompt", blurb: "Draw the same facts on one engine with different prompt wordings and judge them blind, then promote the winner." },
];

export default function EvalDashboard() {
  const [tab, setTab] = useState<Tab>(tabFromUrl);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const onPop = () => setTab(tabFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const choose = useCallback((next: Tab) => {
    if (next === tab) return;
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.pushState(null, "", url);
    setTab(next);
  }, [tab]);

  const current = TABS.find((t) => t.id === tab)!;
  return (
    <AdminLayout title="Eval">
      <div className="max-w-5xl mx-auto p-4 space-y-4">
        <div role="tablist" aria-label="Eval" className="flex gap-1 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              onClick={() => choose(t.id)}
              data-testid={`eval-tab-${t.id}`}
              className={`px-4 py-2 text-sm font-bold -mb-px border-b-2 ${tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div role="tabpanel" className="space-y-4" data-testid={`eval-panel-${tab}`}>
          <p className="text-sm text-muted-foreground">{current.blurb}</p>
          {/* Both tabs stay mounted for the page visit: each keeps its own draft and request token, and each list keeps polling its own kind. */}
          {TABS.map((t) => (
            <div key={t.id} className="space-y-4">
              <EvaluationWizard kind={t.kind} active={tab === t.id} onGenerated={() => setRefresh((n) => n + 1)} />
              <EvaluationsList kind={t.kind} active={tab === t.id} refreshKey={refresh} />
            </div>
          ))}
          {/* Kept mounted like the wizards, so unsaved wording survives a tab switch. */}
          <details hidden={tab !== "prompts"} className="rounded-sm border border-border p-3" data-testid="eval-wording-editor">
            <summary className="cursor-pointer text-sm font-bold text-foreground">Edit prompt wording</summary>
            <div className="pt-3"><PromptRecipes /></div>
          </details>
        </div>
      </div>
    </AdminLayout>
  );
}
