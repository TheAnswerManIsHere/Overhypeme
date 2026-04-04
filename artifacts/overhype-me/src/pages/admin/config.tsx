import { useEffect, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Settings, Clock, Check, AlertCircle, Loader2, Palette } from "lucide-react";
import { IMAGE_STYLES } from "@/config/imageStyles";

interface ConfigRow {
  key: string;
  value: string;
  dataType: string;
  label: string;
  description: string | null;
  minValue: number | null;
  maxValue: number | null;
  isPublic: boolean;
  updatedAt: string;
}

interface EditState {
  value: string;
  saving: boolean;
  error: string | null;
  saved: boolean;
}

const STYLE_OPTIONS = IMAGE_STYLES.filter((s) => s.id !== "none");

export default function AdminConfig() {
  const [rows, setRows] = useState<ConfigRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState<Record<string, EditState>>({});
  const [selectedStyleId, setSelectedStyleId] = useState<string>(STYLE_OPTIONS[0]?.id ?? "");

  useEffect(() => {
    fetch("/api/admin/config", { credentials: "include" })
      .then((r) => r.json())
      .then((data: unknown) => {
        if (!Array.isArray(data)) return;
        const rows = data as ConfigRow[];
        setRows(rows);
        const initial: Record<string, EditState> = {};
        for (const row of rows) {
          initial[row.key] = { value: row.value, saving: false, error: null, saved: false };
        }
        setEdits(initial);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function handleChange(key: string, val: string) {
    setEdits((prev) => ({
      ...prev,
      [key]: { ...prev[key]!, value: val, error: null, saved: false },
    }));
  }

  async function handleSave(key: string) {
    const edit = edits[key];
    if (!edit) return;
    setEdits((prev) => ({ ...prev, [key]: { ...prev[key]!, saving: true, error: null, saved: false } }));

    try {
      const res = await fetch(`/api/admin/config/${key}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: edit.value }),
      });
      const data = (await res.json()) as { error?: string; value?: string };
      if (!res.ok) {
        setEdits((prev) => ({ ...prev, [key]: { ...prev[key]!, saving: false, error: data.error ?? "Save failed" } }));
      } else {
        setEdits((prev) => ({ ...prev, [key]: { ...prev[key]!, saving: false, saved: true } }));
        setRows((prev) => prev.map((r) => (r.key === key ? { ...r, value: data.value ?? edit.value, updatedAt: new Date().toISOString() } : r)));
        setTimeout(() => {
          setEdits((prev) => ({ ...prev, [key]: { ...prev[key]!, saved: false } }));
        }, 2500);
      }
    } catch {
      setEdits((prev) => ({ ...prev, [key]: { ...prev[key]!, saving: false, error: "Network error" } }));
    }
  }

  function isDirtyKey(key: string) {
    const row = rows.find((r) => r.key === key);
    return row ? edits[key]?.value !== row.value : false;
  }

  function isDirty(row: ConfigRow) {
    return edits[row.key]?.value !== row.value;
  }

  const standardKey = `style_suffix_${selectedStyleId}`;
  const referenceKey = `style_suffix_ref_${selectedStyleId}`;
  const standardEdit = edits[standardKey];
  const referenceEdit = edits[referenceKey];
  const selectedStyleDef = STYLE_OPTIONS.find((s) => s.id === selectedStyleId);

  const genericRows = rows.filter((r) => !r.key.startsWith("style_suffix_"));

  function SaveButton({ configKey }: { configKey: string }) {
    const edit = edits[configKey];
    const dirty = isDirtyKey(configKey);
    return (
      <button
        onClick={() => void handleSave(configKey)}
        disabled={!edit || edit.saving || !dirty}
        className="px-4 py-1.5 rounded text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
      >
        {edit?.saving ? (
          <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>
        ) : edit?.saved ? (
          <><Check className="w-3.5 h-3.5" /> Saved</>
        ) : (
          "Save"
        )}
      </button>
    );
  }

  return (
    <AdminLayout title="Configuration">
      <div className="max-w-3xl space-y-4">
        <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2">
          <Settings className="w-4 h-4" />
          <span>Changes take effect within 60 seconds — no restart required.</span>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-8">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Loading configuration…</span>
          </div>
        ) : (
          <div className="space-y-3">

            {/* ── Image Style Suffixes ───────────────────────────────────────── */}
            <div className="bg-card border border-border rounded-lg p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Palette className="w-4 h-4 text-muted-foreground" />
                <h3 className="font-semibold text-foreground">Image Style Suffixes</h3>
              </div>
              <p className="text-sm text-muted-foreground -mt-2">
                Text appended to the scene prompt when a style is selected. "Standard" is used for generic AI generation; "Reference" is used when the user uploads a photo.
              </p>

              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5">
                  Style
                </label>
                <select
                  value={selectedStyleId}
                  onChange={(e) => setSelectedStyleId(e.target.value)}
                  className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {STYLE_OPTIONS.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>

              {selectedStyleDef && (
                <div className="space-y-4 pt-1">
                  {/* Standard Suffix */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Standard Suffix
                      </label>
                      <code className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{standardKey}</code>
                    </div>
                    <textarea
                      rows={3}
                      value={standardEdit?.value ?? ""}
                      onChange={(e) => handleChange(standardKey, e.target.value)}
                      className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-y"
                    />
                    <div className="flex items-center gap-3">
                      <SaveButton configKey={standardKey} />
                      {standardEdit?.error && (
                        <div className="flex items-center gap-1 text-destructive text-sm">
                          <AlertCircle className="w-3.5 h-3.5" />
                          <span>{standardEdit.error}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Reference Suffix */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Reference Photo Suffix
                      </label>
                      <code className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{referenceKey}</code>
                    </div>
                    <textarea
                      rows={3}
                      value={referenceEdit?.value ?? ""}
                      onChange={(e) => handleChange(referenceKey, e.target.value)}
                      className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-y"
                    />
                    <div className="flex items-center gap-3">
                      <SaveButton configKey={referenceKey} />
                      {referenceEdit?.error && (
                        <div className="flex items-center gap-1 text-destructive text-sm">
                          <AlertCircle className="w-3.5 h-3.5" />
                          <span>{referenceEdit.error}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* ── Generic config rows (style_suffix_ rows excluded) ─────────── */}
            {genericRows.map((row) => {
              const edit = edits[row.key];
              if (!edit) return null;
              return (
                <div key={row.key} className="bg-card border border-border rounded-lg p-5 space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold text-foreground">{row.label}</h3>
                        {row.isPublic && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                            public
                          </span>
                        )}
                      </div>
                      {row.description && (
                        <p className="text-sm text-muted-foreground mt-0.5">{row.description}</p>
                      )}
                      <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                        <Clock className="w-3 h-3" />
                        <span>
                          Last updated{" "}
                          {new Date(row.updatedAt).toLocaleString(undefined, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </span>
                      </div>
                    </div>

                    <code className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded shrink-0">
                      {row.key}
                    </code>
                  </div>

                  <div className={row.dataType === "text" ? "space-y-2" : "flex items-center gap-3"}>
                    {row.dataType === "text" ? (
                      <>
                        <textarea
                          rows={4}
                          value={edit.value}
                          onChange={(e) => handleChange(row.key, e.target.value)}
                          className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-y"
                        />
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => void handleSave(row.key)}
                            disabled={edit.saving || !isDirty(row)}
                            className="px-4 py-1.5 rounded text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                          >
                            {edit.saving ? (
                              <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>
                            ) : edit.saved ? (
                              <><Check className="w-3.5 h-3.5" /> Saved</>
                            ) : (
                              "Save"
                            )}
                          </button>
                          {edit.error && (
                            <div className="flex items-center gap-1 text-destructive text-sm">
                              <AlertCircle className="w-3.5 h-3.5" />
                              <span>{edit.error}</span>
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        <input
                          type={row.dataType === "integer" ? "number" : "text"}
                          min={row.minValue ?? undefined}
                          max={row.maxValue ?? undefined}
                          value={edit.value}
                          onChange={(e) => handleChange(row.key, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && isDirty(row)) void handleSave(row.key);
                          }}
                          className="w-36 bg-background border border-border rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                        {row.minValue !== null && row.maxValue !== null && (
                          <span className="text-xs text-muted-foreground">
                            {row.minValue} – {row.maxValue}
                          </span>
                        )}
                        <button
                          onClick={() => void handleSave(row.key)}
                          disabled={edit.saving || !isDirty(row)}
                          className="px-4 py-1.5 rounded text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                        >
                          {edit.saving ? (
                            <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>
                          ) : edit.saved ? (
                            <><Check className="w-3.5 h-3.5" /> Saved</>
                          ) : (
                            "Save"
                          )}
                        </button>
                        {edit.error && (
                          <div className="flex items-center gap-1 text-destructive text-sm">
                            <AlertCircle className="w-3.5 h-3.5" />
                            <span>{edit.error}</span>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
