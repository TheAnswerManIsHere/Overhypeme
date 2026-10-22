import { X } from "lucide-react";

interface Props {
  onClose: () => void;
}

export function WizardTopBar({ onClose }: Props) {
  return (
    <div className="fixed inset-x-0 top-0 z-10 bg-[#111]">
      <div className="flex items-center justify-end h-12 px-3 pt-[env(safe-area-inset-top)]">
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
