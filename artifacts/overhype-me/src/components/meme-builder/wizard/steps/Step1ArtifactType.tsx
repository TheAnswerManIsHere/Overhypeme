/**
 * Step 1 of the MBFO wizard: image or video?
 *
 * This is the placeholder that MBFO-2 fills in. The current implementation
 * renders two big cards. Tier gating on the video card (upgrade modal for
 * free/anonymous users) is wired in MBFO-2 alongside the unified upgrade modal.
 */

import { Image as ImageIcon, Video } from "lucide-react";
import type { ArtifactType } from "../state/wizardStorage";

interface Props {
  selected: ArtifactType | null;
  onSelect: (type: ArtifactType) => void;
}

export function Step1ArtifactType({ selected, onSelect }: Props) {
  return (
    <div className="flex flex-col gap-6 px-5 pt-20 pb-10 max-w-md mx-auto">
      <header className="text-center">
        <h1 className="text-white text-3xl font-[Bebas_Neue,sans-serif] tracking-wide uppercase">
          What are we making?
        </h1>
        <p className="text-white/60 text-sm mt-2">Pick a format to start.</p>
      </header>

      <div className="flex flex-col gap-4">
        <ArtifactCard
          icon={<ImageIcon className="w-8 h-8" />}
          title="Image"
          subtitle="A still meme with your name on it."
          isSelected={selected === "image"}
          onClick={() => onSelect("image")}
        />
        <ArtifactCard
          icon={<Video className="w-8 h-8" />}
          title="Video"
          subtitle="Animated, with audio and captions."
          isSelected={selected === "video"}
          onClick={() => onSelect("video")}
        />
      </div>
    </div>
  );
}

interface ArtifactCardProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  isSelected: boolean;
  onClick: () => void;
}

function ArtifactCard({ icon, title, subtitle, isSelected, onClick }: ArtifactCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={title}
      aria-pressed={isSelected}
      className={`flex items-center gap-4 p-5 rounded-2xl border-2 text-left transition-colors ${
        isSelected
          ? "border-[#ff6b35] bg-[#ff6b35]/10"
          : "border-white/15 bg-white/[0.03] hover:border-white/30"
      }`}
    >
      <div
        className={`flex-shrink-0 w-14 h-14 rounded-xl flex items-center justify-center ${
          isSelected ? "bg-[#ff6b35] text-white" : "bg-white/5 text-white/70"
        }`}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-white text-lg font-semibold">{title}</div>
        <div className="text-white/60 text-sm mt-0.5">{subtitle}</div>
      </div>
    </button>
  );
}
