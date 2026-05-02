import { useEffect, useState, useCallback } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { Loader2, CheckSquare, Square, AlertCircle, ToggleLeft } from "lucide-react";

interface FeatureFlag {
  key: string;
  displayName: string;
  description: string | null;
}

interface Permission {
  tier: string;
  featureKey: string;
  enabled: boolean;
}

interface MatrixState {
  features: FeatureFlag[];
  permissions: Permission[];
}

type SaveState = "idle" | "saving" | "saved" | "error";

interface CellState {
  enabled: boolean;
  saveState: SaveState;
}

const TIER_LABELS: Record<string, string> = {
  unregistered: "Unregistered",
  registered: "Registered",
  legendary: "Legendary",
  admin: "Admin",
};

const TIER_ORDER = ["unregistered", "registered", "legendary", "admin"];

export default function AdminFeatures() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [features, setFeatures] = useState<FeatureFlag[]>([]);
  const [tiers, setTiers] = useState<string[]>([]);
  const [cells, setCells] = useState<Record<string, Record<string, CellState>>>({});

  const fetchMatrix = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/feature-flags", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load feature flags");
      const data = (await res.json()) as MatrixState;

      const sortedTiers = [...new Set(data.permissions.map((p) => p.tier))].sort(
        (a, b) => {
          const ai = TIER_ORDER.indexOf(a);
          const bi = TIER_ORDER.indexOf(b);
          if (ai !== -1 && bi !== -1) return ai - bi;
          if (ai !== -1) return -1;
          if (bi !== -1) return 1;
          return a.localeCompare(b);
        },
      );

      setFeatures(data.features);
      setTiers(sortedTiers);

      const cellMap: Record<string, Record<string, CellState>> = {};
      for (const tier of sortedTiers) {
        cellMap[tier] = {};
        for (const feat of data.features) {
          const perm = data.permissions.find(
            (p) => p.tier === tier && p.featureKey === feat.key,
          );
          cellMap[tier]![feat.key] = {
            enabled: perm?.enabled ?? false,
            saveState: "idle",
          };
        }
      }
      setCells(cellMap);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMatrix();
  }, [fetchMatrix]);

  async function toggle(tier: string, featureKey: string) {
    const current = cells[tier]?.[featureKey];
    if (!current) return;

    const newEnabled = !current.enabled;

    setCells((prev) => ({
      ...prev,
      [tier]: {
        ...prev[tier],
        [featureKey]: { enabled: newEnabled, saveState: "saving" },
      },
    }));

    try {
      const res = await fetch("/api/admin/feature-flags", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier, featureKey, enabled: newEnabled }),
      });
      if (!res.ok) throw new Error("Save failed");

      setCells((prev) => ({
        ...prev,
        [tier]: {
          ...prev[tier],
          [featureKey]: { enabled: newEnabled, saveState: "saved" },
        },
      }));

      setTimeout(() => {
        setCells((prev) => ({
          ...prev,
          [tier]: {
            ...prev[tier],
            [featureKey]: { ...prev[tier]![featureKey]!, saveState: "idle" },
          },
        }));
      }, 1500);
    } catch {
      setCells((prev) => ({
        ...prev,
        [tier]: {
          ...prev[tier],
          [featureKey]: { enabled: current.enabled, saveState: "error" },
        },
      }));

      setTimeout(() => {
        setCells((prev) => ({
          ...prev,
          [tier]: {
            ...prev[tier],
            [featureKey]: { ...prev[tier]![featureKey]!, saveState: "idle" },
          },
        }));
      }, 2500);
    }
  }

  if (loading) {
    return (
      <AdminLayout title="Features">
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      </AdminLayout>
    );
  }

  if (error) {
    return (
      <AdminLayout title="Features">
        <div className="flex items-center gap-2 text-destructive p-4 bg-destructive/10 rounded-lg border border-destructive/20">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout title="Features">
      <div className="space-y-4">
        <CollapsibleSection
          title="Feature Permission Grid"
          icon={<ToggleLeft className="w-4 h-4 text-primary" />}
          description="Control which features are available to each membership tier."
          storageKey="admin_section_features_grid"
        >
          <p className="text-sm text-muted-foreground -mt-3">
            Control which features are available to each membership tier. Changes take effect immediately without redeployment.
          </p>
          <div className="flex justify-end">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted px-3 py-1.5 rounded">
              <ToggleLeft className="w-3.5 h-3.5" />
              Click a checkbox to toggle
            </span>
          </div>

          {/* Desktop matrix table — hidden on small screens */}
          <div className="hidden md:block overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-muted/60">
                  <th className="sticky left-0 z-10 bg-muted/80 backdrop-blur border-b border-r border-border px-4 py-3 text-left font-semibold text-foreground whitespace-nowrap min-w-[180px]">
                    Tier
                  </th>
                  {features.map((feat) => (
                    <th
                      key={feat.key}
                      className="border-b border-r border-border px-4 py-3 text-center font-medium text-foreground whitespace-nowrap min-w-[160px] last:border-r-0"
                      title={feat.description ?? feat.displayName}
                    >
                      <div className="space-y-0.5">
                        <div>{feat.displayName}</div>
                        <div className="font-mono text-[10px] text-muted-foreground font-normal">{feat.key}</div>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tiers.map((tier, rowIdx) => (
                  <tr
                    key={tier}
                    className={rowIdx % 2 === 0 ? "bg-card" : "bg-muted/20"}
                  >
                    <td className="sticky left-0 z-10 backdrop-blur border-b border-r border-border px-4 py-3 font-medium text-foreground whitespace-nowrap bg-inherit">
                      <div className="space-y-0.5">
                        <div>{TIER_LABELS[tier] ?? tier}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">{tier}</div>
                      </div>
                    </td>
                    {features.map((feat) => {
                      const cell = cells[tier]?.[feat.key];
                      const enabled = cell?.enabled ?? false;
                      const saveState = cell?.saveState ?? "idle";

                      return (
                        <td
                          key={feat.key}
                          className="border-b border-r border-border px-4 py-3 text-center last:border-r-0"
                        >
                          <button
                            onClick={() => toggle(tier, feat.key)}
                            disabled={saveState === "saving"}
                            title={`${enabled ? "Disable" : "Enable"} ${feat.displayName} for ${TIER_LABELS[tier] ?? tier}`}
                            className="inline-flex items-center justify-center w-8 h-8 rounded transition-colors hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1"
                          >
                            {saveState === "saving" ? (
                              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                            ) : saveState === "error" ? (
                              <AlertCircle className="w-5 h-5 text-destructive" />
                            ) : enabled ? (
                              <CheckSquare
                                className={`w-5 h-5 transition-colors ${
                                  saveState === "saved" ? "text-green-500" : "text-primary"
                                }`}
                              />
                            ) : (
                              <Square
                                className={`w-5 h-5 transition-colors ${
                                  saveState === "saved" ? "text-muted-foreground" : "text-muted-foreground/40"
                                }`}
                              />
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card stack — one card per tier, feature toggles stacked inside */}
          <div className="md:hidden space-y-3">
            {tiers.map((tier) => (
              <div key={tier} className="rounded-lg border border-border bg-card overflow-hidden">
                <div className="px-4 py-3 bg-muted/40 border-b border-border">
                  <div className="text-sm font-semibold text-foreground">{TIER_LABELS[tier] ?? tier}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{tier}</div>
                </div>
                <ul className="divide-y divide-border">
                  {features.map((feat) => {
                    const cell = cells[tier]?.[feat.key];
                    const enabled = cell?.enabled ?? false;
                    const saveState = cell?.saveState ?? "idle";
                    return (
                      <li key={feat.key}>
                        <button
                          onClick={() => toggle(tier, feat.key)}
                          disabled={saveState === "saving"}
                          aria-pressed={enabled}
                          title={`${enabled ? "Disable" : "Enable"} ${feat.displayName} for ${TIER_LABELS[tier] ?? tier}`}
                          className="w-full flex items-center gap-3 min-h-[44px] px-4 py-2.5 text-left transition-colors hover:bg-muted/30 active:bg-muted/40 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:bg-muted/30"
                        >
                          <span className="inline-flex items-center justify-center w-6 h-6 shrink-0">
                            {saveState === "saving" ? (
                              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                            ) : saveState === "error" ? (
                              <AlertCircle className="w-5 h-5 text-destructive" />
                            ) : enabled ? (
                              <CheckSquare
                                className={`w-5 h-5 transition-colors ${
                                  saveState === "saved" ? "text-green-500" : "text-primary"
                                }`}
                              />
                            ) : (
                              <Square
                                className={`w-5 h-5 transition-colors ${
                                  saveState === "saved" ? "text-muted-foreground" : "text-muted-foreground/40"
                                }`}
                              />
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-foreground truncate">{feat.displayName}</span>
                            <span className="block font-mono text-[10px] text-muted-foreground truncate">{feat.key}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            Adding a new tier or feature requires only a database record — no code changes needed.
          </p>
        </CollapsibleSection>
      </div>
    </AdminLayout>
  );
}
