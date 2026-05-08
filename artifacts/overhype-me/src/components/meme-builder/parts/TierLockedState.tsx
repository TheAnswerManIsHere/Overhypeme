import { Button } from "@/components/ui/Button";
import { TIER_LOCK_COPY } from "../copy";
import type { Tier } from "../types";

interface Props {
  upgradeTo: Tier;
  reason: string;
  onUpgrade: () => void;
  onCancel: () => void;
}

export function TierLockedState({ upgradeTo, reason, onUpgrade, onCancel }: Props) {
  const copy = upgradeTo === "registered" ? TIER_LOCK_COPY.registered : TIER_LOCK_COPY.legendary;
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
      <p className="font-mono text-xs uppercase tracking-widest text-primary">{copy.title}</p>
      <p className="font-display text-2xl uppercase">{reason}</p>
      <div className="flex gap-2">
        <Button type="button" onClick={onUpgrade}>{copy.actionLabel}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
