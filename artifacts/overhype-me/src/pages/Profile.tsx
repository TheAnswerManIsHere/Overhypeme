import { useState, useEffect, useRef } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import { useGetMyProfile, getGetMyProfileQueryKey, useUpdateMyProfile } from "@workspace/api-client-react";
import { Layout } from "@/components/layout/Layout";
import { FactCard } from "@/components/facts/FactCard";
import { Button } from "@/components/ui/Button";
import { SubscriptionPanel } from "@/components/SubscriptionPanel";
import { ShieldAlert, ShieldCheck, LogOut, Clock, ThumbsUp, FileText, Hash, Star, X, Pencil, Check, Mail, AlertTriangle, CheckCircle, Camera, Loader2, Images, ImageIcon, UserCircle2, Image, Eraser, ChevronLeft, ChevronRight, KeyRound, Eye, EyeOff, Bell, Crown } from "lucide-react";
import { ImageCard } from "@/components/ui/ImageCard";
import { Link, useLocation } from "wouter";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { PronounEditor } from "@/components/ui/PronounEditor";
import { usePersonName } from "@/hooks/use-person-name";
import { AccessGate } from "@/components/AccessGate";
import { Sentry } from "@/lib/sentry";
import { AdminMediaInfo, AdminMediaInfoForUrl, getFileNameFromUrl, getMimeTypeFromUrl } from "@/components/ui/AdminMediaInfo";

const BASE_URL = import.meta.env.BASE_URL ?? "/";

/**
 * Center-crop an image to a square and re-encode as JPEG, downscaled to
 * `maxSize` on the long edge. The cropped image is the user's reusable
 * identity asset — meme overlays, AI image generation, and AI video memes
 * all consume a square face crop, so we normalise on upload.
 */
async function cropToSquareJpeg(file: File, maxSize: number): Promise<File> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result : "");
    r.onerror = () => reject(new Error("Could not read image"));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new globalThis.Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Could not decode image"));
    i.src = dataUrl;
  });
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (side <= 0) throw new Error("Image has no pixels");
  const sx = Math.floor((img.naturalWidth - side) / 2);
  const sy = Math.floor((img.naturalHeight - side) / 2);
  const out = Math.min(side, maxSize);
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.9),
  );
  if (!blob) throw new Error("Could not encode image");
  const baseName = file.name.replace(/\.[^.]+$/, "");
  return new File([blob], `${baseName}.jpg`, { type: "image/jpeg" });
}

export default function Profile() {
  const [currentPath, setLocation] = useLocation();
  const { isAuthenticated, isLoading: authLoading, login, logout, role, refreshUser } = useAuth();
  const isRealAdmin = role === "admin";
  const queryClient = useQueryClient();
  const { data: profile, isLoading } = useGetMyProfile({
    query: { queryKey: getGetMyProfileQueryKey(), enabled: isAuthenticated, retry: false }
  });

  const updateProfile = useUpdateMyProfile();
  const { setName: setPersonName, setPronouns: setPersonPronouns } = usePersonName();

  const [activeTab, setActiveTab] = useState<"submitted" | "liked" | "history" | "images" | "memes">("liked");
  const [checkoutBanner, setCheckoutBanner] = useState<"success" | "cancel" | null>(null);
  const [checkoutPolling, setCheckoutPolling] = useState(false);
  const [checkoutConfirmed, setCheckoutConfirmed] = useState(false);
  // session_id captured from the Stripe success_url redirect — used for sync confirm
  const [checkoutSessionId, setCheckoutSessionId] = useState<string | null>(null);
  const [emailVerifiedBanner, setEmailVerifiedBanner] = useState(false);

  const AVATAR_STYLES = [
    { id: "bottts",     label: "Robot" },
    { id: "pixel-art",  label: "Pixel" },
    { id: "adventurer", label: "Hero" },
    { id: "identicon",  label: "Geo" },
    { id: "shapes",     label: "Abstract" },
    { id: "thumbs",     label: "Thumbs" },
  ] as const;

  const [editing, setEditing] = useState(false);
  const [draftDisplayName, setDraftDisplayName] = useState("");
  const [draftFirstName, setDraftFirstName] = useState("");
  const [draftLastName, setDraftLastName] = useState("");
  const [draftAvatarStyle, setDraftAvatarStyle] = useState("bottts");
  const [draftPronouns, setDraftPronouns] = useState("");
  const [draftEmail, setDraftEmail] = useState("");
  const [editError, setEditError] = useState("");
  const [editSuccess, setEditSuccess] = useState("");
  const [resendStatus, setResendStatus] = useState("");

  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [tabScroll, setTabScroll] = useState({ left: false, right: false });

  const updateTabScroll = () => {
    const el = tabsRef.current;
    if (!el) return;
    setTabScroll({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  };

  useEffect(() => {
    // Safari iOS finalizes layout later than other browsers.
    // Double-rAF handles most cases; the 200 ms timeout is a reliable Safari fallback.
    let raf2: number;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(updateTabScroll);
    });
    const timer = setTimeout(updateTabScroll, 200);
    const el = tabsRef.current;
    if (!el) return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); clearTimeout(timer); };
    const ro = new ResizeObserver(updateTabScroll);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(timer);
      ro.disconnect();
    };
  }, []);
  const [avatarSourceToggling, setAvatarSourceToggling] = useState(false);
  const [forgetMeConfirm, setForgetMeConfirm] = useState(false);
  const [forgetMeLoading, setForgetMeLoading] = useState(false);

  const [showPasswordSection, setShowPasswordSection] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrentPw, setShowCurrentPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState("");
  const [passwordLoading, setPasswordLoading] = useState(false);

  const [unlinkLoading, setUnlinkLoading] = useState(false);
  const [unlinkError, setUnlinkError] = useState("");
  const [unlinkSuccess, setUnlinkSuccess] = useState("");
  const [unlinkConfirm, setUnlinkConfirm] = useState(false);

  const [notifAdminAlerts, setNotifAdminAlerts] = useState<boolean>(true);
  const [notifDisputeAlerts, setNotifDisputeAlerts] = useState<boolean>(true);
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifError, setNotifError] = useState("");
  const [notifSuccess, setNotifSuccess] = useState("");

  async function handleUnlinkGoogle() {
    setUnlinkError("");
    setUnlinkSuccess("");
    setUnlinkLoading(true);
    try {
      const res = await fetch(`${BASE_URL}api/auth/unlink-provider`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json() as { message?: string; error?: string };
      if (!res.ok) {
        setUnlinkError(data.error ?? "Failed to unlink Google account.");
        return;
      }
      setUnlinkSuccess(data.message ?? "Google account unlinked successfully.");
      setUnlinkConfirm(false);
      await queryClient.invalidateQueries({ queryKey: getGetMyProfileQueryKey() });
    } catch {
      setUnlinkError("Network error. Please try again.");
    } finally {
      setUnlinkLoading(false);
    }
  }

  async function handleSetPassword() {
    setPasswordError("");
    setPasswordSuccess("");
    if (!newPassword) { setPasswordError("New password is required."); return; }
    if (newPassword.length < 8) { setPasswordError("Password must be at least 8 characters."); return; }
    if (newPassword !== confirmPassword) { setPasswordError("Passwords do not match."); return; }
    setPasswordLoading(true);
    try {
      const body: Record<string, string> = { newPassword };
      if (profile?.hasPassword) body.currentPassword = currentPassword;
      const res = await fetch(`${BASE_URL}api/auth/set-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const data = await res.json() as { message?: string; error?: string };
      if (!res.ok) { setPasswordError(data.error ?? "Failed to update password."); return; }
      setPasswordSuccess(data.message ?? "Password updated successfully.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setShowPasswordSection(false);
      await queryClient.invalidateQueries({ queryKey: getGetMyProfileQueryKey() });
    } catch {
      setPasswordError("Network error. Please try again.");
    } finally {
      setPasswordLoading(false);
    }
  }

  async function handleForgetMe() {
    setForgetMeLoading(true);
    try {
      // Destroy the server-side session and clear the auth cookie
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      // Best-effort — continue with client wipe even if the request fails
    }
    // Wipe all client-side storage
    localStorage.clear();
    sessionStorage.clear();
    // Clear all JS-accessible cookies for this domain
    document.cookie.split(";").forEach((c) => {
      document.cookie = c
        .replace(/^ +/, "")
        .replace(/=.*/, `=;expires=${new Date(0).toUTCString()};path=/`);
    });
    // Hard reload to the homepage — no cached state
    window.location.replace("/");
  }

  interface UploadItem {
    objectPath: string;
    width: number;
    height: number;
    isLowRes: boolean;
    fileSizeBytes: number;
    createdAt: string;
  }

  const { data: uploadsData, isLoading: isUploadsLoading, isError: isUploadsError } = useQuery<{ uploads: UploadItem[] }>({
    queryKey: ["my-uploads"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/users/me/uploads`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch uploads");
      return res.json() as Promise<{ uploads: UploadItem[] }>;
    },
    enabled: isAuthenticated && activeTab === "images",
    staleTime: 30_000,
  });

  interface AiImageItem { id: number; factId: number; gender: string; storagePath: string; imageType: string; createdAt: string; }
  const { data: aiImagesData, isLoading: isAiImagesLoading } = useQuery<{ images: AiImageItem[] }>({
    queryKey: ["my-ai-images"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/users/me/ai-images?imageType=reference`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch AI images");
      return res.json() as Promise<{ images: AiImageItem[] }>;
    },
    enabled: isAuthenticated && activeTab === "images",
    staleTime: 30_000,
  });

  type MyMemeItem = {
    id: number;
    factId: number;
    templateId: string;
    imageUrl: string;
    permalinkSlug: string;
    isPublic: boolean;
    createdAt: string;
    originalWidth: number | null;
    originalHeight: number | null;
    uploadFileSizeBytes: number | null;
  };

  const { data: myMemesData, isLoading: isMyMemesLoading } = useQuery<{ memes: MyMemeItem[] }>({
    queryKey: ["profile-my-memes"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/users/me/memes`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch memes");
      return res.json() as Promise<{ memes: MyMemeItem[] }>;
    },
    enabled: isAuthenticated && activeTab === "memes",
    staleTime: 30_000,
  });


  async function deleteMemeFromProfile(slug: string) {
    const res = await fetch(`${BASE_URL}api/memes/${slug}`, { method: "DELETE", credentials: "include" });
    if (!res.ok) throw new Error("Failed to delete meme");
    await queryClient.invalidateQueries({ queryKey: ["profile-my-memes"] });
  }

  async function deleteUpload(objectPath: string) {
    const encodedPath = encodeURIComponent(objectPath);
    const res = await fetch(`${BASE_URL}api/users/me/uploads?path=${encodedPath}`, { method: "DELETE", credentials: "include" });
    if (!res.ok) {
      const body = await res.json() as { error?: string };
      throw new Error(body.error ?? "Delete failed");
    }
    await queryClient.invalidateQueries({ queryKey: ["my-uploads"] });
  }

  function dicebearUrl(style: string, seed: string) {
    return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}`;
  }

  // Computed locally from auth role; admins are treated as legendary for UI gates.
  const isLegendary = role === "legendary" || role === "admin";

  function getAvatarUrl() {
    if (profile?.profileImageUrl && (profile?.avatarSource ?? "avatar") === "photo") {
      return profile.profileImageUrl;
    }
    return dicebearUrl(profile?.avatarStyle ?? "bottts", profile?.id ?? "default");
  }

  async function toggleAvatarSource() {
    if (!profile) return;
    const next = (profile.avatarSource ?? "avatar") === "photo" ? "avatar" : "photo";
    setAvatarSourceToggling(true);
    try {
      await updateProfile.mutateAsync({ data: { avatarSource: next } });
      await queryClient.invalidateQueries({ queryKey: getGetMyProfileQueryKey() });
    } catch {
      // silently ignore
    } finally {
      setAvatarSourceToggling(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "success") {
      // Capture session_id BEFORE stripping the query string — Stripe injects it via
      // {CHECKOUT_SESSION_ID} in the success_url and we use it for synchronous confirmation.
      const sid = params.get("session_id");
      if (sid?.startsWith("cs_")) setCheckoutSessionId(sid);
      setCheckoutBanner("success");
      setLocation(currentPath, { replace: true });
    }
    if (params.get("emailVerified") === "1") {
      setEmailVerifiedBanner(true);
      setLocation(currentPath, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After checkout redirect: attempt synchronous confirmation via POST /api/stripe/checkout/confirm
  // (fast, ~500ms). Falls back to polling /api/stripe/membership if the confirm endpoint is
  // unavailable (network blip, Stripe API down) so we never strand a paying user.
  useEffect(() => {
    if (checkoutBanner !== "success") return;

    let cancelled = false;

    function sleep(ms: number) {
      return new Promise<void>(resolve => setTimeout(resolve, ms));
    }

    async function grantConfirmed() {
      if (cancelled) return;
      setCheckoutPolling(false);
      setCheckoutConfirmed(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetMyProfileQueryKey() }),
        refreshUser(),
      ]);
    }

    async function startPolling() {
      if (cancelled) return;
      setCheckoutPolling(true);
      let attempts = 0;
      const maxAttempts = 15; // ~30 seconds at 2s intervals

      const poll = setInterval(async () => {
        if (cancelled) { clearInterval(poll); return; }
        attempts++;
        try {
          const res = await fetch(`${BASE_URL}api/stripe/membership`, { credentials: "include" });
          if (!cancelled && res.ok) {
            const data = (await res.json()) as { tier?: string };
            if (data.tier === "legendary") {
              clearInterval(poll);
              await grantConfirmed();
              return;
            }
          }
        } catch {
          // Network error — keep polling
        }
        if (attempts >= maxAttempts) {
          clearInterval(poll);
          setCheckoutPolling(false);
          // checkoutConfirmed stays false — timeout banner tells user to check back
          Sentry.captureMessage("Checkout confirm and webhook polling both timed out", "warning");
        }
      }, 2000);

      return () => clearInterval(poll);
    }

    async function runConfirmFlow() {
      if (!checkoutSessionId) {
        // No session_id in URL (old in-flight checkout, or manual navigation) — fall through to polling.
        await startPolling();
        return;
      }

      // Primary: synchronous confirm with exponential-backoff retries.
      // Retry on 5xx / network errors only — 4xx means permanent rejection (wrong user, unpaid).
      const retryDelays = [0, 1000, 2000, 4000]; // attempt 1 immediate, then 1s / 2s / 4s
      let confirmedSync = false;

      for (let i = 0; i < retryDelays.length; i++) {
        if (cancelled) return;
        if (retryDelays[i] > 0) await sleep(retryDelays[i]);
        if (cancelled) return;

        try {
          const res = await fetch(`${BASE_URL}api/stripe/checkout/confirm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ sessionId: checkoutSessionId }),
          });

          if (res.ok) {
            const data = (await res.json()) as { tier?: string };
            if (data.tier === "legendary") {
              confirmedSync = true;
              await grantConfirmed();
              return;
            }
          }

          // 4xx = permanent rejection (ownership mismatch, session unpaid, bad sessionId).
          // No retry — fall through to polling as last resort.
          if (res.status >= 400 && res.status < 500) {
            Sentry.addBreadcrumb({
              category: "stripe",
              message: `checkout/confirm rejected with ${res.status}`,
              level: "warning",
            });
            break;
          }
          // 5xx = transient — will retry on next loop iteration
        } catch {
          // Network error — will retry on next loop iteration
        }
      }

      // Last-resort: webhook polling. Catches the rare case where Stripe's API is down
      // to us but their webhook delivery infrastructure is still working independently.
      if (!confirmedSync && !cancelled) {
        Sentry.addBreadcrumb({
          category: "stripe",
          message: "checkout/confirm exhausted retries — falling back to webhook polling",
          level: "warning",
        });
        await startPolling();
      }
    }

    void runConfirmFlow();

    return () => { cancelled = true; };
  }, [checkoutBanner, checkoutSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!profile || !isRealAdmin) return;
    const data = profile as unknown as Record<string, unknown>;
    if (typeof data["adminNotifications"] === "boolean") setNotifAdminAlerts(data["adminNotifications"]);
    if (typeof data["disputeNotifications"] === "boolean") setNotifDisputeAlerts(data["disputeNotifications"]);
  }, [profile, isRealAdmin]);

  async function handleToggleNotification(field: "adminNotifications" | "disputeNotifications", value: boolean) {
    setNotifError("");
    setNotifSuccess("");
    setNotifSaving(true);
    const prev = field === "adminNotifications" ? notifAdminAlerts : notifDisputeAlerts;
    if (field === "adminNotifications") setNotifAdminAlerts(value);
    else setNotifDisputeAlerts(value);
    try {
      const res = await fetch(`${BASE_URL}api/users/me/notifications`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ [field]: value }),
      });
      const data = await res.json() as { error?: string; adminNotifications?: boolean; disputeNotifications?: boolean };
      if (!res.ok) {
        if (field === "adminNotifications") setNotifAdminAlerts(prev);
        else setNotifDisputeAlerts(prev);
        setNotifError(data.error ?? "Failed to update notification preferences.");
        return;
      }
      if (typeof data.adminNotifications === "boolean") setNotifAdminAlerts(data.adminNotifications);
      if (typeof data.disputeNotifications === "boolean") setNotifDisputeAlerts(data.disputeNotifications);
      setNotifSuccess("Notification preferences saved.");
      await queryClient.invalidateQueries({ queryKey: getGetMyProfileQueryKey() });
    } catch {
      if (field === "adminNotifications") setNotifAdminAlerts(prev);
      else setNotifDisputeAlerts(prev);
      setNotifError("Network error. Please try again.");
    } finally {
      setNotifSaving(false);
    }
  }

  function openEditor() {
    setDraftDisplayName(profile?.displayName ?? "");
    setDraftFirstName(profile?.firstName ?? "");
    setDraftLastName(profile?.lastName ?? "");
    setDraftAvatarStyle(profile?.avatarStyle ?? "bottts");
    setDraftPronouns(profile?.pronouns ?? "");
    setDraftEmail("");
    setEditError("");
    setEditSuccess("");
    setEditing(true);
  }

  function cancelEditor() {
    setEditing(false);
    setEditError("");
    setEditSuccess("");
  }

  async function saveProfile() {
    setEditError("");
    setEditSuccess("");

    const body: Record<string, string> = {};
    if (draftDisplayName.trim() !== (profile?.displayName ?? "")) body.displayName = draftDisplayName.trim();
    if (draftFirstName.trim() !== (profile?.firstName ?? "")) body.firstName = draftFirstName.trim();
    if (draftLastName.trim() !== (profile?.lastName ?? "")) body.lastName = draftLastName.trim();
    if (draftAvatarStyle !== (profile?.avatarStyle ?? "bottts")) body.avatarStyle = draftAvatarStyle;
    if (draftPronouns !== (profile?.pronouns ?? "")) body.pronouns = draftPronouns;
    if (draftEmail.trim()) body.email = draftEmail.trim();

    if (Object.keys(body).length === 0) {
      cancelEditor();
      return;
    }

    try {
      const result = await updateProfile.mutateAsync({ data: body });
      await queryClient.invalidateQueries({ queryKey: getGetMyProfileQueryKey() });
      // Sync the PersonNameContext so fact cards re-render immediately without a page refresh
      if (body.displayName !== undefined) setPersonName(body.displayName);
      if (body.pronouns   !== undefined) setPersonPronouns(body.pronouns);
      if (result.emailVerificationPending) {
        setEditSuccess(`Profile saved. A verification email has been sent to ${draftEmail}. Check your inbox to confirm the change.`);
      } else {
        setEditSuccess("Profile updated successfully.");
      }
      setEditing(false);
    } catch (err: unknown) {
      const errObj = err as { response?: { data?: { error?: string } }; message?: string };
      setEditError(errObj?.response?.data?.error ?? errObj?.message ?? "Failed to update profile.");
    }
  }

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!fileInputRef.current) fileInputRef.current = e.target;
    e.target.value = "";
    if (!file) return;

    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowedTypes.includes(file.type)) {
      setPhotoError("Please select a JPEG, PNG, WebP, or GIF image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setPhotoError("Image must be under 5 MB.");
      return;
    }

    setPhotoError("");
    setPhotoUploading(true);
    try {
      // Center-square crop + downscale on the client. The photo becomes the
      // user's reusable identity asset (memes, AI images, AI video memes), and
      // the downstream meme/AI flows expect a square face crop. Keep GIFs
      // untouched so animation isn't lost.
      const cropped = file.type === "image/gif"
        ? file
        : await cropToSquareJpeg(file, 1024).catch(() => file);
      const uploadRes = await fetch(`${BASE_URL}api/storage/upload-avatar`, {
        method: "POST",
        headers: { "Content-Type": cropped.type },
        credentials: "include",
        body: cropped,
      });
      if (!uploadRes.ok) {
        const errData = await uploadRes.json() as { error?: string };
        throw new Error(errData.error ?? "Upload failed");
      }
      const { objectPath } = await uploadRes.json() as { objectPath: string };

      const profileImageUrl = `/api/storage${objectPath}`;
      await updateProfile.mutateAsync({ data: { profileImageUrl, avatarSource: "photo" } });
      await queryClient.invalidateQueries({ queryKey: getGetMyProfileQueryKey() });
    } catch (err: unknown) {
      const errObj = err as { message?: string };
      setPhotoError(errObj?.message ?? "Photo upload failed.");
    } finally {
      setPhotoUploading(false);
    }
  }

  async function resendVerification() {
    setResendStatus("");
    try {
      const res = await fetch(`${BASE_URL}api/auth/resend-verification`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json() as { message?: string; error?: string };
      setResendStatus(data.message ?? data.error ?? "Sent.");
    } catch {
      setResendStatus("Failed to resend. Please try again.");
    }
  }

  if (authLoading) {
    return (
      <Layout>
        <div className="max-w-5xl mx-auto px-4 py-12 animate-pulse space-y-8">
          <div className="h-32 bg-card border-2 border-border rounded-sm" />
          <div className="h-12 bg-card border-2 border-border rounded-sm w-full max-w-md" />
          <div className="h-64 bg-card border-2 border-border rounded-sm" />
        </div>
      </Layout>
    );
  }

  if (!isAuthenticated) {
    return (
      <Layout>
        <AccessGate variant="page" reason="login" returnTo="/profile" description="You must authenticate to access personnel records." />
      </Layout>
    );
  }

  if (isLoading || !profile) {
    return (
      <Layout>
        <div className="max-w-5xl mx-auto px-4 py-12 animate-pulse space-y-8">
          <div className="h-32 bg-card border-2 border-border rounded-sm" />
          <div className="h-12 bg-card border-2 border-border rounded-sm w-full max-w-md" />
          <div className="h-64 bg-card border-2 border-border rounded-sm" />
        </div>
      </Layout>
    );
  }

  const hasCustomPhoto = Boolean(profile.profileImageUrl);
  const hasDisplayName = Boolean(profile.displayName && profile.displayName.trim().length > 0);
  const identityIncomplete = !hasCustomPhoto || !hasDisplayName;

  return (
    <Layout>
      <div className="max-w-5xl mx-auto px-4 py-12 md:py-20">

        {/* ── Identity-first card ─────────────────────────────────────
            The profile photo + display name are the user's reusable
            identity asset. Every meme, AI image, and AI video meme
            reuses them, so prompt the user to set them up the moment
            they land here. Free for everyone — no upgrade gate. */}
        {identityIncomplete && (
          <div className="bg-card border-2 border-primary/40 rounded-sm p-5 md:p-6 mb-6 shadow-[0_0_24px_rgba(249,115,22,0.12)]">
            <div className="flex flex-col md:flex-row md:items-center gap-4 md:gap-6">
              <div className="flex items-center gap-4 md:shrink-0">
                <div className="relative shrink-0">
                  <img
                    src={getAvatarUrl()}
                    alt={profile.displayName ?? "Your avatar"}
                    className="w-16 h-16 md:w-20 md:h-20 rounded-sm border-2 border-primary/60 object-cover bg-secondary"
                  />
                  {!hasCustomPhoto && (
                    <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center shadow">!</span>
                  )}
                </div>
                <div className="md:hidden flex-1 min-w-0">
                  <div className="text-[10px] font-display uppercase tracking-[0.18em] text-primary mb-0.5">Complete your identity</div>
                  <h2 className="text-base font-display uppercase tracking-wide text-foreground leading-tight">Your face is the meme</h2>
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="hidden md:block text-[11px] font-display uppercase tracking-[0.18em] text-primary mb-1">Complete your identity</div>
                <h2 className="hidden md:block text-xl font-display uppercase tracking-wide text-foreground mb-1">Your face is the meme</h2>
                <p className="text-xs md:text-sm text-muted-foreground leading-snug">
                  Add your <strong className="text-foreground">name</strong> and a <strong className="text-foreground">photo of you</strong> — we reuse them everywhere: photo memes, AI memes of you in impossible scenarios, and AI video memes. Free for everyone.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {!hasCustomPhoto && (
                    <Button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={photoUploading}
                      size="sm"
                      className="gap-2"
                    >
                      {photoUploading ? <><Loader2 className="w-4 h-4 animate-spin" /> Uploading…</> : <><Camera className="w-4 h-4" /> Add Photo</>}
                    </Button>
                  )}
                  {!hasDisplayName && (
                    <Button
                      onClick={openEditor}
                      variant={hasCustomPhoto ? "primary" : "outline"}
                      size="sm"
                      className="gap-2"
                    >
                      <Pencil className="w-4 h-4" /> Add Name
                    </Button>
                  )}
                </div>
                {photoError && <p className="text-xs text-destructive mt-2">{photoError}</p>}
              </div>
            </div>
          </div>
        )}

        {/* Checkout Success Banner */}
        {checkoutBanner === "success" && (
          <div className="flex items-center justify-between gap-4 bg-primary/20 border-2 border-primary rounded-sm p-4 mb-8">
            <div className="flex items-center gap-3">
              {checkoutPolling ? (
                <>
                  <Loader2 className="w-5 h-5 text-primary shrink-0 animate-spin" />
                  <p className="font-bold text-foreground">Payment received — upgrading your account&hellip;</p>
                </>
              ) : checkoutConfirmed ? (
                <>
                  <Star className="w-5 h-5 text-primary shrink-0" />
                  <p className="font-bold text-foreground">You're now Legendary! Your membership is active. Daily facts incoming.</p>
                </>
              ) : (
                <>
                  <Clock className="w-5 h-5 text-primary shrink-0" />
                  <p className="font-bold text-foreground">Payment received — your account upgrade is still processing. Check back in a moment.</p>
                </>
              )}
            </div>
            {!checkoutPolling && (
              <button onClick={() => setCheckoutBanner(null)} className="text-muted-foreground hover:text-foreground shrink-0">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        )}

        {/* Email Verified Banner */}
        {emailVerifiedBanner && (
          <div className="flex items-center justify-between gap-4 bg-green-500/20 border-2 border-green-500 rounded-sm p-4 mb-8">
            <div className="flex items-center gap-3">
              <CheckCircle className="w-5 h-5 text-green-500 shrink-0" />
              <p className="font-bold text-foreground">Email address verified successfully!</p>
            </div>
            <button onClick={() => setEmailVerifiedBanner(false)} className="text-muted-foreground hover:text-foreground shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Pending Email Banner */}
        {profile.pendingEmail && (
          <div className="flex items-center justify-between gap-4 bg-amber-500/20 border-2 border-amber-500 rounded-sm p-4 mb-8">
            <div className="flex items-center gap-3">
              <Mail className="w-5 h-5 text-amber-500 shrink-0" />
              <p className="text-foreground">
                <span className="font-bold">Email change pending</span> — Check your inbox to confirm <strong>{profile.pendingEmail}</strong>
              </p>
            </div>
            <button
              onClick={resendVerification}
              className="text-xs text-amber-400 hover:text-amber-300 underline shrink-0 transition-colors"
            >
              Resend
            </button>
          </div>
        )}
        {resendStatus && (
          <p className="text-sm text-muted-foreground mb-4 -mt-4">{resendStatus}</p>
        )}

        {/* Unverified Email Banner */}
        {profile.email && !profile.emailVerified && !profile.pendingEmail && (
          <div className="flex items-center justify-between gap-4 bg-amber-500/20 border-2 border-amber-500 rounded-sm p-4 mb-8">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
              <p className="text-foreground">
                <span className="font-bold">Check your email</span> — We sent a verification link to <strong>{profile.email}</strong>. Verify to unlock all features.
              </p>
            </div>
            <button
              onClick={resendVerification}
              className="text-xs text-amber-400 hover:text-amber-300 underline shrink-0 transition-colors"
            >
              Resend
            </button>
          </div>
        )}

        {/* Edit Success / Error */}
        {editSuccess && (
          <div className="flex items-center gap-3 bg-green-500/20 border-2 border-green-500 rounded-sm p-4 mb-8">
            <CheckCircle className="w-5 h-5 text-green-500 shrink-0" />
            <p className="text-foreground">{editSuccess}</p>
          </div>
        )}

        {/* ── DESKTOP: Wide hero ──────────────────────────────────── */}
        <div className="hidden md:flex items-end gap-10 pb-10 mb-10 border-b border-border">
          {/* Avatar */}
          <div className="relative group shrink-0">
            <img
              src={getAvatarUrl()}
              alt={profile.displayName ?? "User"}
              className="w-[120px] h-[120px] rounded-full border-2 border-primary object-cover bg-secondary shadow-[0_0_24px_rgba(249,115,22,0.25)]"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={photoUploading}
              className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              title="Upload profile photo"
            >
              {photoUploading ? <Loader2 className="w-6 h-6 text-white animate-spin" /> : <Camera className="w-6 h-6 text-white" />}
            </button>
          </div>

          {/* Name + stats */}
          <div className="flex-1 pb-1">
            <div className="flex items-center gap-3 mb-1">
              {isLegendary && (
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-primary/15 border border-primary/30 text-[10px] font-bold tracking-[0.14em] uppercase text-primary font-display">
                  <Star className="w-3 h-3" /> Legendary
                </span>
              )}
            </div>
            <h1
              className="font-display font-bold uppercase tracking-tight leading-[0.9] text-foreground mb-4"
              style={{ fontSize: "clamp(36px, 4vw, 56px)" }}
            >
              {profile.displayName ?? profile.email}
            </h1>
            <div className="flex items-center gap-8">
              <div>
                <div className="font-display font-bold text-xl">{profile.likedFacts.length}</div>
                <div className="text-[11px] text-muted-foreground uppercase tracking-[0.1em] font-display mt-0.5">Liked</div>
              </div>
              <div className="w-px h-8 bg-border" />
              <div>
                <div className="font-display font-bold text-xl">{profile.submittedFacts.length}</div>
                <div className="text-[11px] text-muted-foreground uppercase tracking-[0.1em] font-display mt-0.5">Submitted</div>
              </div>
              {myMemesData && (
                <>
                  <div className="w-px h-8 bg-border" />
                  <div>
                    <div className="font-display font-bold text-xl">{myMemesData.memes.length}</div>
                    <div className="text-[11px] text-muted-foreground uppercase tracking-[0.1em] font-display mt-0.5">Memes</div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2 pb-1 shrink-0">
            <Button onClick={openEditor} variant="outline" className="gap-2">
              <Pencil className="w-4 h-4" /> Edit Profile
            </Button>
            {!isLegendary && (
              <Button onClick={() => setLocation("/pricing")} className="gap-2">
                <Crown className="w-4 h-4" /> Go Legendary
              </Button>
            )}
          </div>
        </div>

        {/* Profile Header */}
        <div className="md:hidden bg-card border-2 border-border p-8 rounded-sm shadow-xl flex flex-col md:flex-row items-center gap-8 relative overflow-hidden mb-8">
          <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 rounded-bl-full -mr-16 -mt-16 pointer-events-none" />

          {/* Clickable avatar */}
          <div className="relative group shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              onChange={handlePhotoChange}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={photoUploading}
              className="relative block rounded-sm focus:outline-none focus:ring-2 focus:ring-primary"
              title="Upload profile photo"
            >
              <img
                src={getAvatarUrl()}
                alt={profile.displayName ?? "User"}
                className="w-24 h-24 rounded-sm border-2 border-primary object-cover bg-secondary shadow-[0_0_15px_rgba(249,115,22,0.3)]"
              />
              <div className="absolute inset-0 bg-black/50 rounded-sm flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                {photoUploading
                  ? <Loader2 className="w-6 h-6 text-white animate-spin" />
                  : <Camera className="w-6 h-6 text-white" />
                }
              </div>
            </button>
            {photoError && (
              <p className="absolute top-full mt-1 left-0 w-48 text-xs text-destructive font-medium bg-card border border-destructive/40 rounded-sm px-2 py-1 z-20">{photoError}</p>
            )}

            {/* Avatar source toggle — anyone with a custom photo */}
            {profile.profileImageUrl && (
              <div className="mt-2 flex items-center gap-1 bg-secondary/80 rounded-sm p-0.5 border border-border/60">
                <button
                  disabled={avatarSourceToggling}
                  onClick={() => (profile.avatarSource ?? "avatar") !== "avatar" && toggleAvatarSource()}
                  className={`flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-bold uppercase tracking-wider transition-colors ${
                    (profile.avatarSource ?? "avatar") === "avatar"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  title="Use avatar style"
                >
                  <UserCircle2 className="w-3 h-3" /> Avatar
                </button>
                <button
                  disabled={avatarSourceToggling}
                  onClick={() => (profile.avatarSource ?? "avatar") !== "photo" && toggleAvatarSource()}
                  className={`flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-bold uppercase tracking-wider transition-colors ${
                    (profile.avatarSource ?? "avatar") === "photo"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  title="Use custom photo"
                >
                  <Image className="w-3 h-3" /> Photo
                </button>
              </div>
            )}
          </div>
          
          <div className="flex-1 text-center md:text-left z-10">
            <h1 className="text-3xl md:text-4xl font-display uppercase tracking-wide text-foreground mb-2">
              {profile.displayName ?? profile.email}
            </h1>
            <p className="text-muted-foreground text-lg font-medium">{profile.email}</p>
          </div>

          <div className="flex flex-col gap-2 z-10">
            <Button variant="outline" onClick={openEditor} className="gap-2">
              <Pencil className="w-4 h-4" /> EDIT PROFILE
            </Button>
            <Button variant="danger" onClick={logout} className="gap-2">
              <LogOut className="w-4 h-4" /> LOGOUT
            </Button>
            {isRealAdmin && (
              <Button variant="outline" onClick={() => setLocation("/admin")} className="gap-2 border-primary/40 text-primary hover:text-primary hover:border-primary">
                <ShieldCheck className="w-4 h-4" /> ADMIN PANEL
              </Button>
            )}
            {isRealAdmin && (!forgetMeConfirm ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setForgetMeConfirm(true)}
                className="gap-2 text-muted-foreground hover:text-destructive"
              >
                <Eraser className="w-4 h-4" /> Forget Me
              </Button>
            ) : (
              <div className="border border-destructive/40 bg-destructive/5 rounded-sm p-3 space-y-2">
                <p className="text-xs text-destructive font-medium flex items-start gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  This logs you out and wipes ALL local data — cookies, storage, preferences — so the site treats you as a brand-new visitor.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={handleForgetMe}
                    disabled={forgetMeLoading}
                    className="flex-1 gap-1.5"
                  >
                    {forgetMeLoading
                      ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Wiping…</>
                      : <><Eraser className="w-3.5 h-3.5" /> Yes, forget me</>
                    }
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setForgetMeConfirm(false)}
                    disabled={forgetMeLoading}
                    className="flex-1"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Edit Profile Form */}
        {editing && (
          <div className="bg-card border-2 border-border p-6 rounded-sm shadow mb-8">
            <h2 className="font-display text-xl uppercase tracking-wide text-foreground mb-6 border-b border-border pb-4 flex items-center gap-2">
              <Pencil className="w-5 h-5 text-primary" /> Edit Profile
            </h2>
            <div className="grid grid-cols-1 gap-5">
              <div>
                <label className="block text-sm font-bold text-muted-foreground uppercase tracking-wide mb-1">Display Name</label>
                <input
                  type="text"
                  value={draftDisplayName}
                  onChange={(e) => setDraftDisplayName(e.target.value)}
                  placeholder="How you want to appear on the site"
                  maxLength={80}
                  className="w-full max-w-md bg-secondary border border-border rounded-sm px-3 py-2 text-foreground outline-none focus:border-primary transition-colors"
                />
                <p className="text-xs text-muted-foreground mt-1">This name appears on your facts and profile.</p>
              </div>

              {/* Billing & Fulfillment Name */}
              <div className="border border-border/50 rounded-sm p-4 bg-secondary/30">
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-3">Billing &amp; Store Orders</p>
                <p className="text-xs text-muted-foreground mb-4">Used for payment invoices and personalized store orders. Not shown publicly.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-bold text-muted-foreground uppercase tracking-wide mb-1">First Name</label>
                    <input
                      type="text"
                      value={draftFirstName}
                      onChange={(e) => setDraftFirstName(e.target.value)}
                      placeholder="Legal first name"
                      maxLength={80}
                      className="w-full bg-secondary border border-border rounded-sm px-3 py-2 text-foreground outline-none focus:border-primary transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-muted-foreground uppercase tracking-wide mb-1">Last Name</label>
                    <input
                      type="text"
                      value={draftLastName}
                      onChange={(e) => setDraftLastName(e.target.value)}
                      placeholder="Legal last name"
                      maxLength={80}
                      className="w-full bg-secondary border border-border rounded-sm px-3 py-2 text-foreground outline-none focus:border-primary transition-colors"
                    />
                  </div>
                </div>
              </div>

              {/* Avatar Style Picker */}
              <div>
                <label className="block text-sm font-bold text-muted-foreground uppercase tracking-wide mb-2">Avatar Style</label>
                <div className="flex flex-wrap gap-3">
                  {AVATAR_STYLES.map((style) => (
                    <button
                      key={style.id}
                      type="button"
                      onClick={() => setDraftAvatarStyle(style.id)}
                      className={`flex flex-col items-center gap-1 p-1.5 rounded-sm border-2 transition-all ${draftAvatarStyle === style.id ? "border-primary bg-primary/10" : "border-border bg-secondary hover:border-primary/50"}`}
                      title={style.label}
                    >
                      <img
                        src={dicebearUrl(style.id, profile.id)}
                        alt={style.label}
                        className="w-12 h-12 rounded-sm"
                      />
                      <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{style.label}</span>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-1">Your avatar is generated from your unique ID — same look everywhere, no photo needed.</p>
              </div>

              {/* Photo Upload — free identity asset for everyone */}
              <div>
                <label className="block text-sm font-bold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-2">
                  <Camera className="w-3.5 h-3.5" /> Profile Photo <span className="text-muted-foreground/70 text-[10px] font-normal normal-case tracking-normal">— free, reused for memes &amp; AI</span>
                </label>
                <div className="flex items-center gap-4 flex-wrap">
                  {profile.profileImageUrl && (
                    <img src={profile.profileImageUrl} alt="Current photo" className="w-12 h-12 rounded-sm border border-border object-cover" />
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={photoUploading}
                    className="gap-2 text-sm"
                  >
                    {photoUploading ? <><Loader2 className="w-4 h-4 animate-spin" /> Uploading…</> : <><Camera className="w-4 h-4" /> {profile.profileImageUrl ? "Change Photo" : "Upload Photo"}</>}
                  </Button>
                  {profile.profileImageUrl && (
                    <div className="flex flex-col gap-1">
                      <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide">Display as</p>
                      <div className="flex items-center gap-1 bg-secondary/80 rounded-sm p-0.5 border border-border/60">
                        <button
                          type="button"
                          disabled={avatarSourceToggling}
                          onClick={() => (profile.avatarSource ?? "avatar") !== "avatar" && toggleAvatarSource()}
                          className={`flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-bold uppercase tracking-wider transition-colors ${
                            (profile.avatarSource ?? "avatar") === "avatar"
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          <UserCircle2 className="w-3 h-3" /> Avatar
                        </button>
                        <button
                          type="button"
                          disabled={avatarSourceToggling}
                          onClick={() => (profile.avatarSource ?? "avatar") !== "photo" && toggleAvatarSource()}
                          className={`flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-bold uppercase tracking-wider transition-colors ${
                            (profile.avatarSource ?? "avatar") === "photo"
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          <Image className="w-3 h-3" /> Photo
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                {photoError && <p className="text-xs text-destructive mt-1">{photoError}</p>}
                <p className="text-xs text-muted-foreground mt-1">
                  {profile.profileImageUrl
                    ? "Toggle between your avatar style and your custom photo, or upload a new photo. We reuse this photo as your face for memes and AI generation."
                    : "Upload a photo of your face. We reuse it for memes, AI images, and AI video memes of you. JPEG, PNG, WebP or GIF, max 5 MB."}
                </p>
              </div>

              <div>
                <label className="block text-sm font-bold text-muted-foreground uppercase tracking-wide mb-1">Pronouns</label>
                <PronounEditor value={draftPronouns} onChange={setDraftPronouns} />
              </div>
            </div>

            <div className="mt-4 border-t border-border pt-4">
              <h3 className="font-bold text-sm text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                <Mail className="w-4 h-4" /> Email Address
              </h3>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-foreground font-medium">{profile.email ?? "No email on file"}</span>
                {profile.emailVerified ? (
                  <span className="text-xs bg-green-500/20 text-green-400 border border-green-500/40 px-2 py-0.5 rounded-sm font-bold">Verified</span>
                ) : profile.email ? (
                  <span className="text-xs bg-amber-500/20 text-amber-400 border border-amber-500/40 px-2 py-0.5 rounded-sm font-bold">Unverified</span>
                ) : null}
              </div>
              {profile.pendingEmail && (
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-muted-foreground text-sm">Pending: {profile.pendingEmail}</span>
                  <span className="text-xs bg-amber-500/20 text-amber-400 border border-amber-500/40 px-2 py-0.5 rounded-sm font-bold">Awaiting Verification</span>
                </div>
              )}
              <div className="mt-3">
                <label className="block text-sm font-bold text-muted-foreground uppercase tracking-wide mb-1">New Email Address</label>
                <input
                  type="email"
                  value={draftEmail}
                  onChange={(e) => setDraftEmail(e.target.value)}
                  placeholder="Enter new email to request a change"
                  className="w-full max-w-md bg-secondary border border-border rounded-sm px-3 py-2 text-foreground outline-none focus:border-primary transition-colors"
                />
                <p className="text-xs text-muted-foreground mt-1">A verification email will be sent to the new address before the change takes effect.</p>
              </div>
            </div>

            {editError && (
              <p className="text-destructive text-sm font-medium mt-4">{editError}</p>
            )}

            <div className="flex gap-3 mt-6">
              <Button onClick={saveProfile} disabled={updateProfile.isPending} className="gap-2">
                <Check className="w-4 h-4" /> {updateProfile.isPending ? "Saving…" : "Save Changes"}
              </Button>
              <Button variant="outline" onClick={cancelEditor}>Cancel</Button>
            </div>
          </div>
        )}

        {/* Sign-in Method & Password */}
        {(() => {
          const oauthProvider = profile?.oauthProvider ?? null;
          const hasPassword = profile?.hasPassword ?? false;
          return (
            <div className="bg-card border-2 border-border p-6 rounded-sm shadow mb-8">
              <h2 className="font-display text-xl uppercase tracking-wide text-foreground mb-4 border-b border-border pb-4 flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-primary" /> Sign-in Methods
              </h2>

              <div className="flex flex-col gap-3 mb-5">
                {/* Google badge */}
                <div className={`flex items-center gap-3 px-4 py-3 rounded-sm border ${oauthProvider === "google" ? "border-blue-500/40 bg-blue-500/5" : "border-border bg-secondary/30 opacity-50"}`}>
                  <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  <div className="flex-1">
                    <p className="font-bold text-sm text-foreground">Google</p>
                    <p className="text-xs text-muted-foreground">{oauthProvider === "google" ? "Connected — use Google to sign in" : "Not linked"}</p>
                  </div>
                  {oauthProvider === "google" && (
                    <span className="text-xs bg-blue-500/20 text-blue-400 border border-blue-500/40 px-2 py-0.5 rounded-sm font-bold">Active</span>
                  )}
                  {oauthProvider === "google" && hasPassword && !unlinkConfirm && (
                    <button
                      onClick={() => { setUnlinkConfirm(true); setUnlinkError(""); setUnlinkSuccess(""); }}
                      className="text-xs text-muted-foreground hover:text-destructive transition-colors underline shrink-0 ml-1"
                    >
                      Unlink
                    </button>
                  )}
                  {oauthProvider === "google" && !hasPassword && (
                    <span className="text-xs text-amber-500/80 shrink-0 ml-1">Set a password to enable unlinking</span>
                  )}
                </div>

                {/* Unlink confirmation / feedback */}
                {oauthProvider === "google" && unlinkConfirm && (
                  <div className="border border-destructive/40 bg-destructive/5 rounded-sm p-4 space-y-3">
                    <p className="text-sm text-foreground font-medium">Remove Google sign-in from your account?</p>
                    <p className="text-xs text-muted-foreground">You'll only be able to sign in with your email and password going forward.</p>
                    {unlinkError && <p className="text-xs text-destructive font-medium">{unlinkError}</p>}
                    <div className="flex gap-3">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleUnlinkGoogle}
                        disabled={unlinkLoading}
                        className="gap-2 border-destructive/60 text-destructive hover:bg-destructive/10"
                      >
                        {unlinkLoading ? <><Loader2 className="w-4 h-4 animate-spin" /> Unlinking…</> : "Yes, Unlink Google"}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => { setUnlinkConfirm(false); setUnlinkError(""); }}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {unlinkSuccess && (
                  <div className="flex items-center gap-3 bg-green-500/20 border border-green-500/40 rounded-sm p-3">
                    <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />
                    <p className="text-sm text-foreground">{unlinkSuccess}</p>
                  </div>
                )}

                {/* Email + Password badge */}
                <div className={`flex items-center gap-3 px-4 py-3 rounded-sm border ${hasPassword ? "border-green-500/40 bg-green-500/5" : "border-border bg-secondary/30 opacity-60"}`}>
                  <Mail className="w-5 h-5 shrink-0 text-muted-foreground" />
                  <div className="flex-1">
                    <p className="font-bold text-sm text-foreground">Email + Password</p>
                    <p className="text-xs text-muted-foreground">{hasPassword ? "Password set — you can sign in with your email and password" : "No password set"}</p>
                  </div>
                  {hasPassword && (
                    <span className="text-xs bg-green-500/20 text-green-400 border border-green-500/40 px-2 py-0.5 rounded-sm font-bold">Active</span>
                  )}
                </div>
              </div>

              {/* Password success message */}
              {passwordSuccess && (
                <div className="flex items-center gap-3 bg-green-500/20 border border-green-500/40 rounded-sm p-3 mb-4">
                  <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />
                  <p className="text-sm text-foreground">{passwordSuccess}</p>
                </div>
              )}

              {/* Toggle set/change password form */}
              {!showPasswordSection ? (
                <div className="space-y-2">
                  <Button variant="outline" size="sm" onClick={() => { setShowPasswordSection(true); setPasswordError(""); setPasswordSuccess(""); }} className="gap-2">
                    <KeyRound className="w-4 h-4" />
                    {hasPassword ? "Change Password" : "Set a Password"}
                  </Button>
                  {oauthProvider === "google" && !hasPassword && (
                    <p className="text-xs text-amber-500/80">Setting a password also lets you unlink your Google account later.</p>
                  )}
                  {oauthProvider === "google" && hasPassword && (
                    <p className="text-xs text-amber-500/80">To remove Google sign-in from your account, use the <span className="font-semibold">Unlink</span> option in the Google row above.</p>
                  )}
                </div>
              ) : (
                <div className="border border-border rounded-sm p-4 bg-secondary/20 space-y-4">
                  <p className="text-sm font-bold text-muted-foreground uppercase tracking-wide">
                    {hasPassword ? "Change Password" : "Set a Password"}
                  </p>
                  {!hasPassword && (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Adding a password lets you sign in with your email and password in addition to any linked social accounts.</p>
                      {oauthProvider === "google" && (
                        <p className="text-xs text-amber-500/80">Setting a password also lets you unlink your Google account later.</p>
                      )}
                    </div>
                  )}

                  {hasPassword && oauthProvider === "google" && (
                    <p className="text-xs text-amber-500/80">To remove Google sign-in from your account, use the <span className="font-semibold">Unlink</span> option in the Google row above.</p>
                  )}

                  {hasPassword && (
                    <div>
                      <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wide mb-1">Current Password</label>
                      <div className="relative max-w-sm">
                        <input
                          type={showCurrentPw ? "text" : "password"}
                          value={currentPassword}
                          onChange={(e) => setCurrentPassword(e.target.value)}
                          placeholder="Your current password"
                          className="w-full bg-secondary border border-border rounded-sm px-3 py-2 pr-10 text-foreground outline-none focus:border-primary transition-colors text-sm"
                        />
                        <button type="button" onClick={() => setShowCurrentPw(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                          {showCurrentPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wide mb-1">New Password</label>
                    <div className="relative max-w-sm">
                      <input
                        type={showNewPw ? "text" : "password"}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="At least 8 characters"
                        className="w-full bg-secondary border border-border rounded-sm px-3 py-2 pr-10 text-foreground outline-none focus:border-primary transition-colors text-sm"
                      />
                      <button type="button" onClick={() => setShowNewPw(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                        {showNewPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wide mb-1">Confirm New Password</label>
                    <div className="relative max-w-sm">
                      <input
                        type={showConfirmPw ? "text" : "password"}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Repeat new password"
                        className="w-full bg-secondary border border-border rounded-sm px-3 py-2 pr-10 text-foreground outline-none focus:border-primary transition-colors text-sm"
                      />
                      <button type="button" onClick={() => setShowConfirmPw(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                        {showConfirmPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  {passwordError && (
                    <p className="text-xs text-destructive font-medium">{passwordError}</p>
                  )}

                  <div className="flex gap-3">
                    <Button onClick={handleSetPassword} disabled={passwordLoading} size="sm" className="gap-2">
                      {passwordLoading ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : <><Check className="w-4 h-4" /> Save Password</>}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => { setShowPasswordSection(false); setPasswordError(""); setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* Admin Notification Preferences — visible to admins only */}
        {isRealAdmin && (
          <div className="bg-card border-2 border-border p-6 rounded-sm shadow mb-8">
            <h2 className="font-display text-xl uppercase tracking-wide text-foreground mb-4 border-b border-border pb-4 flex items-center gap-2">
              <Bell className="w-5 h-5 text-primary" /> Notification Preferences
            </h2>
            <p className="text-sm text-muted-foreground mb-5">Control which admin email alerts you receive.</p>

            <div className="space-y-4">
              {/* Moderation alerts toggle */}
              <label className="flex items-center justify-between gap-4 cursor-pointer group">
                <div>
                  <p className="font-bold text-sm text-foreground">Moderation alerts</p>
                  <p className="text-xs text-muted-foreground">Emails for new fact submissions awaiting review.</p>
                </div>
                <button
                  role="switch"
                  aria-checked={notifAdminAlerts}
                  disabled={notifSaving}
                  onClick={() => handleToggleNotification("adminNotifications", !notifAdminAlerts)}
                  className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-card disabled:opacity-60 ${
                    notifAdminAlerts ? "bg-primary border-primary" : "bg-secondary border-border"
                  }`}
                >
                  <span
                    className={`pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm transition-transform mt-0.5 ${
                      notifAdminAlerts ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </label>

              {/* Dispute alerts toggle */}
              <label className="flex items-center justify-between gap-4 cursor-pointer group">
                <div>
                  <p className="font-bold text-sm text-foreground">Dispute alerts</p>
                  <p className="text-xs text-muted-foreground">Emails for new payment disputes that need attention.</p>
                </div>
                <button
                  role="switch"
                  aria-checked={notifDisputeAlerts}
                  disabled={notifSaving}
                  onClick={() => handleToggleNotification("disputeNotifications", !notifDisputeAlerts)}
                  className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-card disabled:opacity-60 ${
                    notifDisputeAlerts ? "bg-primary border-primary" : "bg-secondary border-border"
                  }`}
                >
                  <span
                    className={`pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm transition-transform mt-0.5 ${
                      notifDisputeAlerts ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </label>
            </div>

            {notifError && (
              <p className="text-xs text-destructive font-medium mt-4">{notifError}</p>
            )}
            {notifSuccess && (
              <div className="flex items-center gap-2 mt-4">
                <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />
                <p className="text-xs text-green-400">{notifSuccess}</p>
              </div>
            )}
          </div>
        )}

        {/* Subscription Panel */}
        <SubscriptionPanel refetchTrigger={checkoutConfirmed || undefined} />

        {/* Favorite Hashtags */}
        {profile.favoriteHashtags && profile.favoriteHashtags.length > 0 && (
          <div className="bg-card border-2 border-border p-6 rounded-sm shadow mb-8">
            <div className="flex items-center gap-2 mb-4">
              <Hash className="w-5 h-5 text-primary" />
              <h2 className="font-display text-xl uppercase tracking-wide text-foreground">Favorite Intel Tags</h2>
            </div>
            <div className="flex flex-wrap gap-2">
              {profile.favoriteHashtags.map((tag: string) => (
                <Link key={tag} href={`/search?q=%23${encodeURIComponent(tag)}`}>
                  <span className="inline-block bg-primary/10 text-primary border border-primary/40 hover:bg-primary/20 hover:border-primary transition-colors px-4 py-1.5 rounded-sm font-bold font-display text-sm uppercase tracking-widest cursor-pointer">
                    #{tag}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Custom Tabs */}
        <div className="relative mb-8">
          {/* Left fade + chevron */}
          {tabScroll.left && (
            <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-16 z-10 flex items-center justify-start"
              style={{ background: "linear-gradient(to right, hsl(var(--background)) 30%, transparent)" }}>
              <ChevronLeft className="w-6 h-6 text-foreground/60 ml-1 flex-shrink-0" />
            </div>
          )}
          {/* Right fade + chevron */}
          {tabScroll.right && (
            <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-16 z-10 flex items-center justify-end"
              style={{ background: "linear-gradient(to left, hsl(var(--background)) 30%, transparent)" }}>
              <ChevronRight className="w-6 h-6 text-foreground/60 mr-1 flex-shrink-0" />
            </div>
          )}
          <div
            ref={tabsRef}
            onScroll={updateTabScroll}
            className="flex overflow-x-auto gap-2 border-b-2 border-border no-scrollbar"
          >
            <button
              onClick={() => setActiveTab("liked")}
              className={`flex items-center gap-2 px-6 py-4 font-display text-lg uppercase tracking-wider transition-colors border-b-2 whitespace-nowrap ${activeTab === "liked" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"}`}
            >
              <ThumbsUp className="w-5 h-5" /> Liked Facts ({profile.likedFacts.length})
            </button>
            <button
              onClick={() => setActiveTab("submitted")}
              className={`flex items-center gap-2 px-6 py-4 font-display text-lg uppercase tracking-wider transition-colors border-b-2 whitespace-nowrap ${activeTab === "submitted" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"}`}
            >
              <FileText className="w-5 h-5" /> Submissions ({profile.submittedFacts.length + (profile.pendingSubmissions?.length ?? 0) + (profile.myComments?.length ?? 0)})
            </button>
            <button
              onClick={() => setActiveTab("history")}
              className={`flex items-center gap-2 px-6 py-4 font-display text-lg uppercase tracking-wider transition-colors border-b-2 whitespace-nowrap ${activeTab === "history" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"}`}
            >
              <Clock className="w-5 h-5" /> Search History
            </button>
            {isLegendary && (
              <button
                onClick={() => setActiveTab("images")}
                className={`flex items-center gap-2 px-6 py-4 font-display text-lg uppercase tracking-wider transition-colors border-b-2 whitespace-nowrap ${activeTab === "images" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"}`}
              >
                <Images className="w-5 h-5" /> My Images
              </button>
            )}
            <button
              onClick={() => setActiveTab("memes")}
              className={`flex items-center gap-2 px-6 py-4 font-display text-lg uppercase tracking-wider transition-colors border-b-2 whitespace-nowrap ${activeTab === "memes" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"}`}
            >
              <ImageIcon className="w-5 h-5" /> My Memes
            </button>
          </div>
        </div>

        {/* Tab Content */}
        <div className="min-h-[400px]">
          {activeTab === "liked" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {profile.likedFacts.map(fact => <FactCard key={fact.id} fact={fact} />)}
              {profile.likedFacts.length === 0 && <p className="col-span-full text-center text-muted-foreground py-12">No liked facts. You have high standards.</p>}
            </div>
          )}

          {activeTab === "submitted" && (
            <div className="space-y-8">
              {(profile.pendingSubmissions?.length ?? 0) > 0 && (
                <div>
                  <h3 className="font-display text-base uppercase tracking-wider text-muted-foreground mb-4 flex items-center gap-2">
                    <Clock className="w-4 h-4" /> Under Review
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {profile.pendingSubmissions!.map((sub: { id: number; text: string; status: string; hashtags: string[]; createdAt: string; reason: string | null }) => (
                      <div key={sub.id} className={`bg-card border-2 rounded-sm p-4 space-y-2 ${sub.status === "rejected" ? "border-destructive/40" : "border-border"}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-sm border ${
                            sub.status === "pending"
                              ? "bg-amber-500/10 text-amber-400 border-amber-500/40"
                              : sub.status === "rejected"
                              ? "bg-destructive/10 text-destructive border-destructive/40"
                              : "bg-green-500/10 text-green-400 border-green-500/40"
                          }`}>
                            {sub.status === "pending" ? "Pending Review" : sub.status === "rejected" ? "Declined" : sub.status}
                          </span>
                          <span className="text-xs text-muted-foreground">{new Date(sub.createdAt).toLocaleDateString()}</span>
                        </div>
                        <p className="text-foreground text-sm leading-relaxed">{sub.text}</p>
                        {sub.hashtags.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {sub.hashtags.map((tag: string) => (
                              <span key={tag} className="text-[10px] text-primary/70 font-bold uppercase tracking-wider">#{tag}</span>
                            ))}
                          </div>
                        )}
                        {sub.status === "rejected" && sub.reason && (
                          <p className="text-xs text-muted-foreground border-t border-border/50 pt-2 mt-2">
                            <span className="font-bold text-destructive/80">Reason:</span> {sub.reason}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {profile.submittedFacts.length > 0 && (
                <div>
                  {(profile.pendingSubmissions?.length ?? 0) > 0 && (
                    <h3 className="font-display text-base uppercase tracking-wider text-muted-foreground mb-4 flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 text-green-500" /> Approved &amp; Live
                    </h3>
                  )}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {profile.submittedFacts.map(fact => <FactCard key={fact.id} fact={fact} />)}
                  </div>
                </div>
              )}

              {(profile.myComments?.length ?? 0) > 0 && (
                <div>
                  <h3 className="font-display text-base uppercase tracking-wider text-muted-foreground mb-4 flex items-center gap-2">
                    <FileText className="w-4 h-4" /> Your Comments
                  </h3>
                  <div className="space-y-3">
                    {profile.myComments!.map((comment) => (
                      <div key={comment.id} className="bg-card border border-border rounded-sm p-4 space-y-2">
                        {comment.factText && (
                          <p className="text-xs text-muted-foreground italic border-l-2 border-primary/40 pl-2 leading-relaxed line-clamp-2">
                            {comment.factText}
                          </p>
                        )}
                        <p className="text-sm text-foreground leading-relaxed">{comment.text}</p>
                        <div className="flex items-center justify-between gap-2 pt-1">
                          <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-sm border ${
                            comment.status === "pending"
                              ? "bg-amber-500/10 text-amber-400 border-amber-500/40"
                              : comment.status === "approved"
                              ? "bg-green-500/10 text-green-400 border-green-500/40"
                              : "bg-destructive/10 text-destructive border-destructive/40"
                          }`}>
                            {comment.status === "pending" ? "Awaiting Approval" : comment.status === "approved" ? "Visible" : comment.status}
                          </span>
                          <div className="flex items-center gap-3">
                            <span className="text-xs text-muted-foreground">{new Date(comment.createdAt).toLocaleDateString()}</span>
                            <Link href={`/facts/${comment.factId}`} className="text-xs text-primary hover:underline">View Fact →</Link>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {profile.submittedFacts.length === 0 && (profile.pendingSubmissions?.length ?? 0) === 0 && (profile.myComments?.length ?? 0) === 0 && (
                <div className="text-center py-12 bg-card border-2 border-dashed border-border rounded-sm">
                  <p className="text-muted-foreground text-lg mb-4">You haven't submitted any facts yet.</p>
                  <Link href="/submit"><Button>SUBMIT FACT</Button></Link>
                </div>
              )}
            </div>
          )}

          {activeTab === "history" && (
            <div className="bg-card border-2 border-border rounded-sm p-6 max-w-2xl">
              <h3 className="font-display text-xl uppercase mb-6 text-foreground border-b border-border pb-4">Recent Queries</h3>
              <div className="space-y-2">
                {profile.searchHistory.map((query, i) => (
                  <Link key={i} href={`/search?q=${encodeURIComponent(query)}`} className="block px-4 py-3 bg-secondary hover:bg-primary/20 hover:text-primary transition-colors font-medium rounded-sm border border-transparent hover:border-primary/30">
                    "{query}"
                  </Link>
                ))}
                {profile.searchHistory.length === 0 && <p className="text-muted-foreground italic">Memory wiped. No history found.</p>}
              </div>
            </div>
          )}

          {activeTab === "images" && (
            <div>
              <p className="text-sm text-muted-foreground mb-6">Images you've uploaded for meme creation. Click an image to copy its link for reuse in the meme builder.</p>
              {isUploadsError ? (
                <div className="text-center py-12 bg-card border-2 border-destructive/30 rounded-sm">
                  <AlertTriangle className="w-10 h-10 text-destructive/60 mx-auto mb-3" />
                  <p className="text-muted-foreground font-medium">Could not load your images. Please try again later.</p>
                </div>
              ) : isUploadsLoading ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="aspect-square bg-card border-2 border-border rounded-sm animate-pulse" />
                  ))}
                </div>
              ) : uploadsData && uploadsData.uploads.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                  {uploadsData.uploads.map((upload) => {
                    const imgUrl = `${BASE_URL}api/storage${upload.objectPath}`;
                    const permalink = `${window.location.origin}${BASE_URL}api/storage${upload.objectPath}`;
                    return (
                      <ImageCard
                        key={upload.objectPath}
                        src={imgUrl}
                        alt="Uploaded image"
                        isAuthProtected
                        aspectRatio="aspect-square"
                        actions={["delete", "copyLink", "openFull"]}
                        onDelete={() => deleteUpload(upload.objectPath)}
                        deleteConfirmMessage="Permanently delete this uploaded image? This cannot be undone."
                        permalink={permalink}
                        imageOverlay={upload.isLowRes ? (
                          <div className="absolute top-1 left-1 bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-sm z-10">
                            LOW RES
                          </div>
                        ) : undefined}
                        footer={<AdminMediaInfo fileName={getFileNameFromUrl(upload.objectPath)} fileSizeBytes={upload.fileSizeBytes} mimeType={getMimeTypeFromUrl(upload.objectPath)} width={upload.width} height={upload.height} />}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-16 bg-card border-2 border-dashed border-border rounded-sm">
                  <Images className="w-16 h-16 text-muted-foreground/40 mx-auto mb-4" />
                  <p className="text-muted-foreground text-lg font-medium mb-2">No images uploaded yet.</p>
                  <p className="text-muted-foreground text-sm mb-6">Upload a custom photo in the meme builder and it will appear here for easy reuse.</p>
                  <Link href="/"><Button variant="outline">GO TO MEME BUILDER</Button></Link>
                </div>
              )}

              {/* AI-Generated Reference Backgrounds section */}
              {(isAiImagesLoading || (aiImagesData && aiImagesData.images.length > 0)) && (
                <div className="mt-10">
                  <h3 className="text-lg font-display uppercase tracking-wider text-foreground mb-1">AI Reference Backgrounds</h3>
                  <p className="text-sm text-muted-foreground mb-6">Images generated from your reference photos in the meme builder.</p>
                  {isAiImagesLoading ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="aspect-square bg-card border-2 border-border rounded-sm animate-pulse" />
                      ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                      {aiImagesData!.images.map((img) => {
                        const imgUrl = `${BASE_URL}api/memes/ai-user/image?storagePath=${encodeURIComponent(img.storagePath)}`;
                        return (
                          <ImageCard
                            key={img.id}
                            src={imgUrl}
                            alt="AI reference background"
                            isAuthProtected
                            aspectRatio="aspect-square"
                            actions={["openFull"]}
                            imageOverlay={
                              <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-1.5 py-0.5 z-10">
                                <span className="text-[10px] text-white/70 uppercase tracking-wider">{img.gender}</span>
                              </div>
                            }
                            footer={<AdminMediaInfoForUrl url={imgUrl} fileName={getFileNameFromUrl(img.storagePath)} mimeType={getMimeTypeFromUrl(img.storagePath)} />}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === "memes" && (
            <div>
              <p className="text-sm text-muted-foreground mb-6">Memes you've created.</p>
              {isMyMemesLoading ? (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="aspect-video bg-card border-2 border-border rounded-sm animate-pulse" />
                  ))}
                </div>
              ) : myMemesData && myMemesData.memes.length > 0 ? (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {myMemesData.memes.map(meme => {
                    const memePermalink = `${window.location.origin}/meme/${meme.permalinkSlug}`;
                    return (
                      <ImageCard
                        key={meme.id}
                        src={meme.imageUrl}
                        alt="Meme"
                        href={`/meme/${meme.permalinkSlug}`}
                        aspectRatio="aspect-video"
                        actions={["delete", "copyLink", "openFull"]}
                        onDelete={() => deleteMemeFromProfile(meme.permalinkSlug)}
                        deleteConfirmMessage="Remove this meme? It will no longer be visible to anyone."
                        permalink={memePermalink}
                        footer={<AdminMediaInfo fileName={getFileNameFromUrl(meme.imageUrl)} fileSizeBytes={meme.uploadFileSizeBytes} mimeType={getMimeTypeFromUrl(meme.imageUrl)} width={meme.originalWidth} height={meme.originalHeight} />}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-16 bg-card border-2 border-dashed border-border rounded-sm">
                  <ImageIcon className="w-16 h-16 text-muted-foreground/40 mx-auto mb-4" />
                  <p className="text-muted-foreground text-lg font-medium mb-2">No memes created yet.</p>
                  <p className="text-muted-foreground text-sm mb-6">Head to a fact page and build your first meme.</p>
                  <Link href="/"><Button variant="outline">BROWSE FACTS</Button></Link>
                </div>
              )}
            </div>
          )}
        </div>

      </div>
    </Layout>
  );
}
