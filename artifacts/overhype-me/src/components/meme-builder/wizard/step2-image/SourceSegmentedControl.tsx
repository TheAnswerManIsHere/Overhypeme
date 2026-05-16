import type { Tier } from "../../types";

export type SourceTab = "stock" | "self-upload" | "ai-you";

interface Props {
  active: SourceTab;
  tier: Tier;
  onSelect: (tab: SourceTab) => void;
  onRequestSignup: () => void;
  onRequestUpgrade: () => void;
}

interface TabSpec {
  id: SourceTab;
  label: string;
  /** When set, the tab is locked and tapping triggers `lock.onClick()`. */
  lock?: {
    badge: "LEGEND" | "SIGN UP";
    onClick: () => void;
  };
}

/**
 * Three pills: AI you | Your photo | Stock. AI leads because it's the hero
 * experience for legendary subscribers. Tier rules:
 *
 *   unregistered: stock unlocked; self-upload locked (signup); ai-you locked (upgrade)
 *   registered:   stock + self-upload unlocked; ai-you locked (upgrade)
 *   legendary:    all three unlocked
 *
 * Locked tabs are dimmed but tappable so the user can discover the upsell.
 * Design-system rule: no emoji decoration — locked tabs show a small typeset
 * "LEGEND" or "SIGN UP" badge instead.
 */
export function SourceSegmentedControl({
  active,
  tier,
  onSelect,
  onRequestSignup,
  onRequestUpgrade,
}: Props) {
  const tabs: TabSpec[] = [
    {
      id: "ai-you",
      label: "AI you",
      ...(tier === "legendary"
        ? {}
        : { lock: { badge: "LEGEND" as const, onClick: onRequestUpgrade } }),
    },
    {
      id: "self-upload",
      label: "Your photo",
      ...(tier === "unregistered"
        ? { lock: { badge: "SIGN UP" as const, onClick: onRequestSignup } }
        : {}),
    },
    { id: "stock", label: "Stock" },
  ];

  return (
    <div
      role="tablist"
      aria-label="Source"
      className="flex w-full gap-1 rounded-full bg-white/5 p-1"
    >
      {tabs.map((tab) => {
        const isActive = active === tab.id && !tab.lock;
        const isLocked = !!tab.lock;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-disabled={isLocked}
            data-testid={`source-tab-${tab.id}`}
            onClick={() => {
              if (tab.lock) tab.lock.onClick();
              else onSelect(tab.id);
            }}
            className={[
              "relative flex flex-1 items-center justify-center gap-2 rounded-full px-3 py-2 text-sm transition-colors",
              isActive
                ? "bg-[#ff6b35] text-white"
                : "text-white/80 hover:text-white",
              isLocked ? "opacity-60" : "",
            ].join(" ")}
          >
            <span>{tab.label}</span>
            {tab.lock && (
              <span
                aria-hidden
                className="rounded-sm border border-[#ff6b35]/70 px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[#ff6b35]"
              >
                {tab.lock.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Picks the source tab to show on entry per the tier × photo-on-file matrix.
 *   unregistered                  → stock
 *   registered + primary photo    → self-upload
 *   registered without photo      → stock
 *   legendary + primary photo     → ai-you
 *   legendary without photo       → stock
 */
export function pickDefaultSourceTab(
  tier: Tier,
  hasPrimaryPhoto: boolean,
): SourceTab {
  if (tier === "legendary") return hasPrimaryPhoto ? "ai-you" : "stock";
  if (tier === "registered") return hasPrimaryPhoto ? "self-upload" : "stock";
  return "stock";
}
