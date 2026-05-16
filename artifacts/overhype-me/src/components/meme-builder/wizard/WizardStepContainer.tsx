import { type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { WizardStep } from "./state/wizardStorage";

interface Props {
  currentStep: WizardStep;
  /** "forward" = slide-left (new step in from right); "back" = slide-right. */
  direction: "forward" | "back";
  children: ReactNode;
}

const SLIDE_DURATION_SEC = 0.28;
const SLIDE_DISTANCE_PX = 32;

export function WizardStepContainer({ currentStep, direction, children }: Props) {
  const prefersReducedMotion = useReducedMotion();

  const offset = prefersReducedMotion ? 0 : SLIDE_DISTANCE_PX;
  const initialX = direction === "forward" ? offset : -offset;
  const exitX = direction === "forward" ? -offset : offset;

  return (
    <div
      className="relative w-full h-full overflow-hidden"
      data-current-step={currentStep}
      data-direction={direction}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={currentStep}
          initial={{ opacity: 0, x: initialX }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: exitX }}
          transition={{
            duration: prefersReducedMotion ? 0 : SLIDE_DURATION_SEC,
            ease: [0.2, 0.8, 0.2, 1],
          }}
          className="absolute inset-0 overflow-y-auto overscroll-y-none"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
