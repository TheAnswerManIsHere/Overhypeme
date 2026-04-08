import { AdminLayout } from "@/components/admin/AdminLayout";
import { Settings, Loader2 } from "lucide-react";
import {
  ConfigPageContext,
  ConfigPageCtx,
  ConfigCard,
  MODEL_CONFIG_KEYS,
  useConfigPageState,
} from "./_configShared";

export default function AdminConfig() {
  const state = useConfigPageState();
  const {
    rows, loading,
    stdEdits, dbgEdits, setStdEdits, setDbgEdits,
    debugActive,
    saveStd, saveDbg, stdDirty, dbgDirty,
  } = state;

  const genericRows = rows.filter((r) =>
    !r.key.startsWith("style_suffix_") &&
    r.key !== "debug_mode_active" &&
    !MODEL_CONFIG_KEYS.has(r.key)
  );

  const ctxValue: ConfigPageCtx = {
    rows, stdEdits, dbgEdits, debugActive,
    setStdEdits, setDbgEdits,
    saveStd, saveDbg, stdDirty, dbgDirty,
  };

  return (
    <AdminLayout title="Configuration">
      <ConfigPageContext.Provider value={ctxValue}>
        <div className="max-w-5xl space-y-4">

          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Settings className="w-4 h-4" />
            <span>Changes take effect within 60 seconds — no restart required.</span>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-8">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Loading configuration…</span>
            </div>
          ) : genericRows.length === 0 ? (
            <div className="text-muted-foreground text-sm py-8">
              No non-AI configuration keys found.
            </div>
          ) : (
            <div className="space-y-3">
              {genericRows.map((row) => <ConfigCard key={row.key} row={row} />)}
            </div>
          )}
        </div>
      </ConfigPageContext.Provider>
    </AdminLayout>
  );
}
