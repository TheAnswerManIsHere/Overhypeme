export type SourceTab = "stock" | "self-upload";

interface Props {
  active: SourceTab;
  onSelect: (tab: SourceTab) => void;
}

interface TabSpec {
  id: SourceTab;
  label: string;
}

/**
 * Two pills: Your photo | Stock. Your photo leads, so entry lands there (an
 * unregistered viewer sees the sign-up panel in it, a level up). The "AI you"
 * tab went with PuLID (launch Phase 4, removal 3; `docs/retired/README.md`),
 * and with it the only locked tab, so nothing here upsells.
 */
export function SourceSegmentedControl({ active, onSelect }: Props) {
  const tabs: TabSpec[] = [
    { id: "self-upload", label: "Your photo" },
    { id: "stock", label: "Stock" },
  ];

  return (
    <div
      role="tablist"
      aria-label="Source"
      className="flex w-full gap-1 rounded-full bg-white/5 p-1"
    >
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-testid={`source-tab-${tab.id}`}
            onClick={() => onSelect(tab.id)}
            className={[
              "relative flex flex-1 items-center justify-center gap-2 rounded-full px-3 py-2 text-sm transition-colors",
              isActive
                ? "bg-[#ff6b35] text-white"
                : "text-white/80 hover:text-white",
            ].join(" ")}
          >
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
