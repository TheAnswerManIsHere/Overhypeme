/**
 * Shown in the image step when the viewer is unregistered: their own photo is
 * the only source (stock photos went with Pexels, launch Phase 4, removal 6),
 * so the step asks them to sign up to add one.
 */
export function GuestPhotoSignupPanel() {
  const handleSignup = () => {
    window.location.href = `/login?from=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  };

  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-white/10 bg-white/5 px-6 py-8 text-center">
      <p className="text-base font-semibold text-white leading-snug">
        Sign up to create a meme using your photo
      </p>
      <button
        type="button"
        onClick={handleSignup}
        className="w-full rounded-full bg-[#ff6b35] px-6 py-3 text-sm font-bold uppercase tracking-widest text-white transition-opacity hover:opacity-90 active:opacity-80"
      >
        Sign up
      </button>
    </div>
  );
}
