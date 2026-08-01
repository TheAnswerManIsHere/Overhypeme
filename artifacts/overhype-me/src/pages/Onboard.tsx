import { useEffect, useRef, useState } from "react";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import { useLocation } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { Camera, Upload, Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cropToSquareJpeg, uploadUserImage } from "@/lib/image-upload";
import { getSafeReturnTo } from "@/lib/safe-return-to";

const HCAPTCHA_SITE_KEY =
  import.meta.env.VITE_HCAPTCHA_SITE_KEY || "10000000-ffff-ffff-ffff-000000000001";

const BASE_URL = import.meta.env.BASE_URL ?? "/";

type Step = "captcha" | "photo";

export default function Onboard() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading } = useAuth();
  const captchaRef = useRef<HCaptcha>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("captcha");
  const [captchaToken, setCaptchaToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string>("");
  const [photoError, setPhotoError] = useState("");
  const [photoUploading, setPhotoUploading] = useState(false);

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

  async function handleVerify() {
    if (!captchaToken) {
      setError("Please complete the CAPTCHA challenge.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/users/me/complete-onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ captchaToken }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error || "Verification failed. Please try again.");
        captchaRef.current?.resetCaptcha();
        setCaptchaToken("");
      } else {
        setStep("photo");
      }
    } catch {
      setError("Network error. Please try again.");
      captchaRef.current?.resetCaptcha();
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

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    setLocation("/");
    return null;
  }

  if (step === "photo") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-card border border-border rounded-xl p-8 shadow-lg space-y-6">
          <div className="text-center space-y-2">
            <div className="text-5xl">📸</div>
            <h1 className="text-2xl font-bold text-foreground">
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

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-card border border-border rounded-xl p-8 shadow-lg space-y-6 text-center">
        <div className="text-5xl">🥊</div>
        <div>
          <h1 className="text-2xl font-bold text-foreground mb-2">
            Welcome to Overhype.me
          </h1>
          <p className="text-muted-foreground text-sm">
            Before you can submit facts or leave comments, we need to confirm
            you're a human — not a robot.
          </p>
        </div>

        <div className="flex justify-center">
          <HCaptcha
            ref={captchaRef}
            sitekey={HCAPTCHA_SITE_KEY}
            theme="dark"
            onVerify={setCaptchaToken}
            onExpire={() => setCaptchaToken("")}
          />
        </div>

        {error && (
          <p className="text-destructive text-sm font-medium">{error}</p>
        )}

        <Button
          onClick={handleVerify}
          disabled={!captchaToken || submitting}
          className="w-full"
        >
          {submitting ? "Verifying…" : "I'm Human — Let Me In"}
        </Button>

        <button
          onClick={() => setLocation("/")}
          className="text-xs text-muted-foreground hover:text-foreground underline transition-colors"
        >
          Skip for now (browse-only mode)
        </button>
      </div>
    </div>
  );
}
