/**
 * Shown in the image step when the viewer is unregistered: their own photo is
 * the only source (stock photos went with Pexels, launch Phase 4, removal 6),
 * so the step invites them to sign in, or to sign up if they have no account
 * (Issue #880). The one button goes to `/login`, which opens on sign-in and
 * offers sign-up, carrying `from` so either path returns them to the builder.
 */
export function GuestPhotoSignupPanel() {
  const goToSignIn = () => {
    window.location.href = `/login?from=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  };

  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-white/10 bg-white/5 px-6 py-8 text-center">
      <p className="text-base font-semibold text-white leading-snug">
        Sign up or sign in to make a meme with your photo
      </p>
      <p className="text-sm text-white/70 leading-snug">
        Already have an account? Just sign in. New here? Sign up first.
      </p>
      <button
        type="button"
        onClick={goToSignIn}
        className="w-full rounded-full bg-[#ff6b35] px-6 py-3 text-sm font-bold uppercase tracking-widest text-white transition-opacity hover:opacity-90 active:opacity-80"
      >
        Sign up or sign in
      </button>
    </div>
  );
}
