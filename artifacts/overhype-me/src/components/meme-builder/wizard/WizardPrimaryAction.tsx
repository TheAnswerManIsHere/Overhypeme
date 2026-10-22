import { type ReactNode } from "react";

interface Props {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  /** Optional sub-text under the button (e.g. cost estimate). */
  subText?: ReactNode;
  /**
   * Optional content rendered inside the fixed action bar, above the button —
   * for a choice that belongs to the act of committing (e.g. meme visibility)
   * rather than to the scrollable controls. Every pixel used here is viewport
   * taken from the controls panel, so keep it to a single compact row.
   */
  aboveAction?: ReactNode;
}

const BRAND_ORANGE = "#ff6b35";

export function WizardPrimaryAction({
  label,
  onClick,
  disabled,
  loading,
  subText,
  aboveAction,
}: Props) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 bg-gradient-to-t from-[#111] via-[#111] to-transparent pt-6 pb-[max(env(safe-area-inset-bottom),16px)] px-4"
      data-testid="wizard-primary-action"
    >
      {aboveAction && <div className="mb-3">{aboveAction}</div>}
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || loading}
        className="w-full h-14 rounded-full text-white font-bold text-base tracking-wide shadow-[0_0_25px_rgba(255,107,53,0.45)] disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none transition-opacity"
        style={{ backgroundColor: BRAND_ORANGE }}
      >
        {loading ? "Working…" : label}
      </button>
      {subText && (
        <div className="text-center text-xs text-white/60 mt-2">{subText}</div>
      )}
    </div>
  );
}
