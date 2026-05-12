import { ArrowLeft, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WizardStep } from "./state/wizardStorage";

interface Props {
  currentStep: WizardStep;
  onBack: () => void;
  onClose: () => void;
}

const STEP_COUNT = 2;
const BRAND_ORANGE = "#ff6b35";

export function WizardTopBar({ currentStep, onBack, onClose }: Props) {
  const progressPct = (currentStep / STEP_COUNT) * 100;
  const showBack = currentStep > 1;

  return (
    <div className="fixed inset-x-0 top-0 z-10 bg-[#111]">
      <div
        className="h-[3px] bg-white/10"
        role="progressbar"
        aria-valuenow={currentStep}
        aria-valuemin={1}
        aria-valuemax={STEP_COUNT}
        aria-label="Meme builder progress"
      >
        <div
          className="h-full transition-[width] duration-300 ease-out"
          style={{ width: `${progressPct}%`, backgroundColor: BRAND_ORANGE }}
        />
      </div>
      <div className="flex items-center justify-between h-12 px-3 pt-[env(safe-area-inset-top)]">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className={cn(
            "flex items-center justify-center w-10 h-10 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition-colors",
            !showBack && "invisible pointer-events-none",
          )}
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close meme builder"
          className="flex items-center justify-center w-10 h-10 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
