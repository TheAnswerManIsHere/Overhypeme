/**
 * @purpose The one onboarding screen every sign-in method reaches once its email is verified (launch Phase 5, plan S8, S22): pronouns (draft, the account's stored choice, the device's choice for a new account, then the name suggestion, else blank and required), date of birth (under 13 refused, nothing stored), the marketing box with the server's default, and a Turnstile challenge; progress is saved as a draft so a reload resumes it; an adult then gets the optional profile-photo step, and everyone goes to the safe returnTo.
 * @subsystem accounts-auth
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { Camera, Upload, Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Turnstile, type TurnstileHandle } from "@/components/ui/Turnstile";
import { PronounEditor } from "@/components/ui/PronounEditor";
import { cropToSquareJpeg, uploadUserImage } from "@/lib/image-upload";
import { getSafeReturnTo } from "@/lib/safe-return-to";
import { inferPronounsFromName } from "@/lib/infer-pronouns";
import { usePersonName } from "@/hooks/use-person-name";

const BASE_URL = import.meta.env.BASE_URL ?? "/";

type Step = "loading" | "details" | "photo";

interface OnboardingDraft {
  pronouns?: string;
  dobYear?: string;
  dobMonth?: string;
  dobDay?: string;
  marketingOptIn?: boolean;
}

interface OnboardingState {
  completed: boolean;
  emailVerified: boolean;
  marketingDefault: boolean;
  marketingWordingVersion: string;
  accountPronouns: string | null;
  name: string | null;
  draft: OnboardingDraft | null;
}

/**
 * The pronouns the form starts with (plan S22): the saved draft, then the
 * account's stored choice (shown for confirmation, never assumed), then — for
 * an account with none — the device's own choice, then the name suggestion,
 * else blank and required.
 */
export function initialPronouns(
  state: Pick<OnboardingState, "draft" | "accountPronouns" | "name">,
  device: { pronouns: string; supplied: boolean },
): string {
  if (state.draft?.pronouns) return state.draft.pronouns;
  if (state.accountPronouns) return state.accountPronouns;
  if (device.supplied && device.pronouns) return device.pronouns;
  return (state.name && inferPronounsFromName(state.name)) || "";
}

/** Whole years from three typed parts, or null until all three make a real date. */
export function ageFromParts(y: string, m: string, d: string, now: Date = new Date()): number | null {
  const [yy, mm, dd] = [Number(y), Number(m), Number(d)];
  if (!y || !m || !d || !Number.isInteger(yy) || !Number.isInteger(mm) || !Number.isInteger(dd)) return null;
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  if (dt.getUTCFullYear() !== yy || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd || yy < 1900 || dt > now) return null;
  let age = now.getUTCFullYear() - yy;
  if (now.getUTCMonth() + 1 < mm || (now.getUTCMonth() + 1 === mm && now.getUTCDate() < dd)) age -= 1;
  return age;
}

export default function Onboard() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading, refreshUser } = useAuth();
  const device = usePersonName();
  const captchaRef = useRef<TurnstileHandle>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("loading");
  const [loadError, setLoadError] = useState("");
  const [pronouns, setPronouns] = useState("");
  const [dobYear, setDobYear] = useState("");
  const [dobMonth, setDobMonth] = useState("");
  const [dobDay, setDobDay] = useState("");
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [underAge, setUnderAge] = useState(false);

  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string>("");
  const [photoError, setPhotoError] = useState("");
  const [photoUploading, setPhotoUploading] = useState(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loaded = useRef(false);

  // Revoke any outstanding object URL on unmount to avoid memory leaks if the
  // user navigates away mid-flow.
  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  const returnTo = (() => {
    if (typeof window === "undefined") return "/";
    const params = new URLSearchParams(window.location.search);
    return getSafeReturnTo(params.get("returnTo")) ?? "/";
  })();

  function finish() {
    setLocation(returnTo);
  }

  // Load what the form starts from: the draft, the account's choice, the
  // marketing default for this visitor's country.
  useEffect(() => {
    if (isLoading || !isAuthenticated || loaded.current) return;
    loaded.current = true;
    (async () => {
      try {
        const res = await fetch(`${BASE_URL}api/auth/onboarding`, { credentials: "include" });
        if (!res.ok) throw new Error("load");
        const state = (await res.json()) as OnboardingState;
        if (state.completed) {
          finish();
          return;
        }
        if (!state.emailVerified) {
          setLocation(`/check-email?returnTo=${encodeURIComponent(returnTo)}`);
          return;
        }
        setPronouns(initialPronouns(state, { pronouns: device.pronouns, supplied: device.pronounsSupplied }));
        setDobYear(state.draft?.dobYear ?? "");
        setDobMonth(state.draft?.dobMonth ?? "");
        setDobDay(state.draft?.dobDay ?? "");
        setMarketingOptIn(state.draft?.marketingOptIn ?? state.marketingDefault);
        setStep("details");
      } catch {
        setLoadError("We couldn't load your set-up. Refresh to try again.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, isAuthenticated]);

  // Save progress a moment after each change, so a reload resumes the form.
  useEffect(() => {
    if (step !== "details") return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`${BASE_URL}api/users/me/onboarding/draft`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ pronouns, dobYear, dobMonth, dobDay, marketingOptIn }),
        });
        if (res.status === 422) setUnderAge(true);
      } catch {
        // A missed draft save loses nothing the form still holds.
      }
    }, 600);
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [step, pronouns, dobYear, dobMonth, dobDay, marketingOptIn]);

  const age = ageFromParts(dobYear, dobMonth, dobDay);
  const tooYoung = underAge || (age != null && age < 13);
  const canSubmit = !!pronouns && age != null && !tooYoung && !!captchaToken && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`${BASE_URL}api/users/me/onboarding`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ pronouns, dobYear, dobMonth, dobDay, marketingOptIn, captchaToken }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        if (data.code === "UNDER_AGE") setUnderAge(true);
        setError(data.error || "That didn't go through. Try again.");
        captchaRef.current?.reset();
        setCaptchaToken("");
        return;
      }
      device.syncFromProfile(device.name, pronouns);
      await refreshUser();
      // Photo uploads are for members 18 and over (plan S12).
      if (age != null && age >= 18) setStep("photo");
      else finish();
    } catch {
      setError("Network error. Try again.");
      captchaRef.current?.reset();
      setCaptchaToken("");
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePhotoPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPhotoError("");
    if (!file.type.startsWith("image/")) {
      setPhotoError("Please choose an image file.");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setPhotoError("Image must be under 15 MB.");
      return;
    }
    try {
      const cropped = await cropToSquareJpeg(file, 1024);
      setPhotoFile(cropped);
      if (photoPreview) URL.revokeObjectURL(photoPreview);
      setPhotoPreview(URL.createObjectURL(cropped));
    } catch {
      setPhotoError("Could not process that image. Try another one.");
    }
  }

  function clearPhoto() {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoFile(null);
    setPhotoPreview("");
    setPhotoError("");
  }

  async function handleUsePhoto() {
    if (!photoFile) return;
    setPhotoError("");
    setPhotoUploading(true);
    try {
      // photoFile was already center-cropped at pickFile() time so it could
      // drive the preview — send it through the unified upload helper as-is.
      const { objectPath } = await uploadUserImage(photoFile, {
        kind: "avatar",
        preprocess: "none",
      });

      // Task #507: re-tag the new upload as the profile photo. The endpoint
      // clears any prior is_profile tag, sets the new one, updates
      // users.profileImageUrl + avatarSource=photo, and re-asserts the
      // public ACL — all in one transaction.
      const setRes = await fetch(`${BASE_URL}api/users/me/profile-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ objectPath }),
      });
      if (!setRes.ok) {
        const data = (await setRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Could not save your photo.");
      }
      finish();
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "Photo upload failed.");
    } finally {
      setPhotoUploading(false);
    }
  }

  if (!isLoading && !isAuthenticated) {
    setLocation("/");
    return null;
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <p className="text-destructive text-sm font-medium" role="alert">{loadError}</p>
      </div>
    );
  }

  if (isLoading || step === "loading") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      </div>
    );
  }

  if (step === "photo") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-card border border-border rounded-xl p-8 shadow-lg space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-3xl font-display uppercase tracking-tight text-foreground">
              Add a real photo of you
            </h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              The meme builder uses your face so the memes actually look like{" "}
              <span className="text-foreground font-semibold">you</span>. One
              photo, reused everywhere — you can change it any time on your
              profile.
            </p>
          </div>

          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="user"
            className="hidden"
            onChange={handlePhotoPicked}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handlePhotoPicked}
          />

          {photoPreview ? (
            <div className="space-y-3">
              <div className="relative mx-auto w-48 h-48 rounded-full overflow-hidden border-2 border-primary shadow-[0_0_24px_rgba(249,115,22,0.25)]">
                <img
                  src={photoPreview}
                  alt="Selected photo"
                  className="w-full h-full object-cover"
                />
              </div>
              <p className="text-center text-xs text-muted-foreground">
                We cropped it square — that's how memes use it.
              </p>
              <div className="flex gap-2 justify-center">
                <button
                  type="button"
                  onClick={clearPhoto}
                  disabled={photoUploading}
                  className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 underline transition-colors disabled:opacity-50"
                >
                  <RotateCw className="w-3 h-3" /> Pick a different one
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => cameraInputRef.current?.click()}
                className="flex flex-col items-center justify-center gap-2 p-5 border-2 border-dashed border-border hover:border-primary hover:bg-primary/5 rounded-lg transition-colors"
              >
                <Camera className="w-7 h-7 text-primary" />
                <span className="text-sm font-bold text-foreground">Take photo</span>
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  Use camera
                </span>
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex flex-col items-center justify-center gap-2 p-5 border-2 border-dashed border-border hover:border-primary hover:bg-primary/5 rounded-lg transition-colors"
              >
                <Upload className="w-7 h-7 text-primary" />
                <span className="text-sm font-bold text-foreground">Upload</span>
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  From device
                </span>
              </button>
            </div>
          )}

          {photoError && (
            <p className="text-destructive text-sm font-medium text-center">
              {photoError}
            </p>
          )}

          <Button
            onClick={handleUsePhoto}
            disabled={!photoFile || photoUploading}
            className="w-full gap-2"
          >
            {photoUploading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Uploading…
              </>
            ) : (
              <>Use this photo</>
            )}
          </Button>

          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={finish}
              disabled={photoUploading}
              className="text-xs text-muted-foreground hover:text-foreground underline transition-colors disabled:opacity-50"
            >
              Skip for now
            </button>
            <p className="text-[10px] text-muted-foreground/70 italic">
              You can add it later on your profile.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const dobInput =
    "h-10 w-full rounded-sm border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:border-primary";

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-xl p-6 sm:p-8 shadow-lg space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-display uppercase tracking-tight text-foreground">
            One quick set-up
          </h1>
          <p className="text-muted-foreground text-sm">
            You only do this once. Then every fact is about you.
          </p>
        </div>

        <section className="space-y-2" aria-labelledby="onboard-pronouns">
          <h2 id="onboard-pronouns" className="text-sm font-semibold text-foreground">Your pronouns</h2>
          <p className="text-xs text-muted-foreground">Facts about you use these. You can change them any time.</p>
          <PronounEditor value={pronouns} onChange={setPronouns} />
        </section>

        <section className="space-y-2" aria-labelledby="onboard-dob">
          <h2 id="onboard-dob" className="text-sm font-semibold text-foreground">Date of birth</h2>
          <div className="grid grid-cols-[1fr_1fr_1.4fr] gap-2">
            <input
              aria-label="Month"
              inputMode="numeric"
              placeholder="MM"
              maxLength={2}
              value={dobMonth}
              onChange={(e) => { setUnderAge(false); setDobMonth(e.target.value.replace(/\D/g, "")); }}
              className={dobInput}
            />
            <input
              aria-label="Day"
              inputMode="numeric"
              placeholder="DD"
              maxLength={2}
              value={dobDay}
              onChange={(e) => { setUnderAge(false); setDobDay(e.target.value.replace(/\D/g, "")); }}
              className={dobInput}
            />
            <input
              aria-label="Year"
              inputMode="numeric"
              placeholder="YYYY"
              maxLength={4}
              value={dobYear}
              onChange={(e) => { setUnderAge(false); setDobYear(e.target.value.replace(/\D/g, "")); }}
              className={dobInput}
            />
          </div>
          {tooYoung && (
            <p className="text-destructive text-sm font-medium" role="alert">
              Overhype.me is for people 13 and over, so we can't set up this account.
            </p>
          )}
          {!tooYoung && dobYear.length === 4 && !!dobMonth && !!dobDay && age == null && (
            <p className="text-destructive text-sm font-medium" role="alert">That isn't a real date.</p>
          )}
        </section>

        <label className="flex items-start gap-3 text-sm text-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={marketingOptIn}
            onChange={(e) => setMarketingOptIn(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-primary"
          />
          <span>Send me emails about new features and the best new facts. Unsubscribe any time.</span>
        </label>

        <div className="flex justify-center">
          <Turnstile
            ref={captchaRef}
            theme="dark"
            onVerify={setCaptchaToken}
            onExpire={() => setCaptchaToken("")}
          />
        </div>

        {error && !tooYoung && (
          <p className="text-destructive text-sm font-medium text-center" role="alert">{error}</p>
        )}

        <Button onClick={handleSubmit} disabled={!canSubmit} className="w-full">
          {submitting ? "Saving…" : "Finish set-up"}
        </Button>
        {!pronouns && (
          <p className="text-xs text-muted-foreground text-center">Choose your pronouns to finish.</p>
        )}
      </div>
    </div>
  );
}
