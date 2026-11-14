import { useEffect, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { AlertCircle, Bot, FileText, Loader2 } from "lucide-react";

/**
 * The read-only AI settings page (David, 2026-11-14: "instead of a
 * configuration page that lets you SET the values, we should have a page that
 * SHOWS the values"). Every value comes from code; a change is a reviewed
 * code change, so the page has no controls.
 */

interface AiSettingRow {
  step: string;
  engine: string | null;
  model: string;
  parameters: Array<{ name: string; value: string }>;
  promptKey: string | null;
}

interface AiPrompt {
  key: string;
  label: string;
  description: string;
  text: string;
}

interface AiSettingsView {
  steps: AiSettingRow[];
  prompts: AiPrompt[];
}

export default function AdminAiSettings() {
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/admin/ai-settings", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not load the AI settings (HTTP ${res.status})`);
        return (await res.json()) as AiSettingsView;
      })
      .then((v) => { if (live) setView(v); })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, []);

  if (error) {
    return (
      <AdminLayout title="AI Settings">
        <div className="flex items-center gap-2 text-destructive p-4 bg-destructive/10 rounded-lg border border-destructive/20">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      </AdminLayout>
    );
  }

  if (!view) {
    return (
      <AdminLayout title="AI Settings">
        <div className="flex items-center justify-center py-20" aria-busy="true">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          <span className="sr-only">Loading the AI settings</span>
        </div>
      </AdminLayout>
    );
  }

  const promptLabel = new Map(view.prompts.map((p) => [p.key, p.label]));

  return (
    <AdminLayout title="AI Settings">
      <p className="text-sm text-muted-foreground mb-4">
        What every AI step uses, read from the code. Nothing here can be changed on this page: a change is a code change, reviewed like any other.
      </p>

      <div className="overflow-x-auto rounded-lg border border-border mb-6">
        <table className="w-full text-sm" data-testid="ai-settings-steps">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">Step</th>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Parameters as sent</th>
              <th className="px-3 py-2 font-medium">System prompt</th>
            </tr>
          </thead>
          <tbody>
            {view.steps.map((s) => (
              <tr key={s.step} className="border-t border-border align-top">
                <td className="px-3 py-2">
                  <div className="font-medium">{s.step}</div>
                  {s.engine && <div className="text-xs text-muted-foreground">{s.engine}</div>}
                </td>
                <td className="px-3 py-2 font-mono text-xs break-all">{s.model}</td>
                <td className="px-3 py-2">
                  {s.parameters.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                      {s.parameters.map((p) => (
                        <div key={p.name} className="contents">
                          <dt className="text-muted-foreground">{p.name}</dt>
                          <dd className={p.value === "not sent" ? "italic text-muted-foreground" : "font-mono text-xs"}>{p.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">{s.promptKey ? promptLabel.get(s.promptKey) ?? s.promptKey : <span className="text-muted-foreground">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="text-base font-semibold mb-2 flex items-center gap-2"><FileText className="w-4 h-4" /> System prompts</h2>
      <div className="space-y-3">
        {view.prompts.map((p) => (
          <CollapsibleSection key={p.key} title={p.label} description={p.description} icon={<Bot className="w-4 h-4" />} storageKey={`admin_ai_prompt_${p.key}`}>
            <pre className="whitespace-pre-wrap text-xs font-mono bg-muted/40 rounded p-3 max-h-[32rem] overflow-y-auto">{p.text}</pre>
          </CollapsibleSection>
        ))}
      </div>
    </AdminLayout>
  );
}
