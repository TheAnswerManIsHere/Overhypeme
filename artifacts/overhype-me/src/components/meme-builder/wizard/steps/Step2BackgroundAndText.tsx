/**
 * Step 2 of the MBFO wizard: background + text.
 *
 * Placeholder. MBFO-3 (image path) and MBFO-4 (video path) re-host the
 * existing Phase-3 builder pieces here — source picker, name/pronoun fields,
 * stylize toggle, live preview, framing drag, text-split slider — and split
 * by `artifactType`.
 */

import type { ArtifactType } from "../state/wizardStorage";

interface Props {
  artifactType: ArtifactType | null;
}

export function Step2BackgroundAndText({ artifactType }: Props) {
  return (
    <div className="flex flex-col gap-6 px-5 pt-20 pb-32 max-w-md mx-auto">
      <header className="text-center">
        <h1 className="text-white text-3xl font-[Bebas_Neue,sans-serif] tracking-wide uppercase">
          Build your meme
        </h1>
        <p className="text-white/60 text-sm mt-2">
          {artifactType === "video"
            ? "Pick a photo, add your name. The motion runs on render."
            : "Pick a photo, add your name. Tweak the placement."}
        </p>
      </header>

      <div className="rounded-2xl border-2 border-dashed border-white/15 bg-white/[0.02] p-8 text-center">
        <div className="text-white/40 text-sm">
          Step 2 controls land in the next MBFO session.
        </div>
        <div className="text-white/30 text-xs mt-2">
          Source picker · name · pronouns · live preview · framing · text split
        </div>
      </div>
    </div>
  );
}
