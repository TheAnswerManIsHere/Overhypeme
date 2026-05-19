interface Props {
  onUseStock: () => void;
}

/**
 * Shown in the "Your photo" tab when the viewer is unregistered.
 * Prompts them to sign up to use their own photo, with a graceful
 * escape hatch to the Stock tab.
 */
export function GuestPhotoSignupPanel({ onUseStock }: Props) {
  const handleSignup = () => {
    window.location.href = `/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  };

  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-white/10 bg-white/5 px-6 py-8 text-center">
      <p className="text-base font-semibold text-white leading-snug">
        Sign up to create a meme using your photo
      </p>
      <p className="text-sm text-white/60">
        Free accounts can use any stock photo — sign up to add your own.
      </p>
      <button
        type="button"
        onClick={handleSignup}
        className="w-full rounded-full bg-[#ff6b35] px-6 py-3 text-sm font-bold uppercase tracking-widest text-white transition-opacity hover:opacity-90 active:opacity-80"
      >
        Sign up
      </button>
      <button
        type="button"
        onClick={onUseStock}
        className="text-sm text-white/50 underline underline-offset-2 hover:text-white/80 transition-colors"
      >
        Maybe later, for now let&apos;s use a stock photo
      </button>
    </div>
  );
}
