import type { Tier } from "../../types";

export type SourceTab = "stock" | "self-upload" | "ai-you";

interface Props {
  active: SourceTab;
  /**
   * `can("meme_pulid_stylize")` from the caller — told, not derived. This
   * used to be `tier === "legendary"`: the same PR #402 shape, on the tab
   * that leads into the PuLID flow. A grid change (granting the entitlement
   * to `registered`, or revoking it from `legendary`) wouldn't move this
   * control.
   */
  canPulidStylize: boolean;
  onSelect: (tab: SourceTab) => void;
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
 * experience for entitled accounts. Stock and Your Photo are always
 * unlocked here (self-upload's own registration requirement is enforced one
 * level up, by `resolveBehavior`'s invalid-cell case — this control never
 * renders for an unregistered viewer). "AI you" is locked exactly when
 * `canPulidStylize` is false, whatever tier the account happens to hold.
 *
 * Locked tabs are dimmed but tappable so the user can discover the upsell.
 * Design-system rule: no emoji decoration — locked tabs show a small typeset
 * "LEGEND" or "SIGN UP" badge instead.
 */
export function SourceSegmentedControl({
  active,
  canPulidStylize,
  onSelect,
  onRequestUpgrade,
}: Props) {
  const tabs: TabSpec[] = [
    {
      id: "ai-you",
      label: "AI you",
      ...(canPulidStylize
        ? {}
        : { lock: { badge: "LEGEND" as const, onClick: onRequestUpgrade } }),
    },
    {
      id: "self-upload",
      label: "Your photo",
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
 * Picks the source tab to show on entry per tier.
 *   legendary    → ai-you   (AI stylised photo is the headline feature)
 *   registered   → self-upload  (Photo tab — encourage uploading their face)
 *   unregistered → self-upload  (shows signup CTA in the panel)
 */
export function pickDefaultSourceTab(tier: Tier): SourceTab {
  if (tier === "legendary") return "ai-you";
  return "self-upload";
}
