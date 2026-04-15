import { useState, useEffect, useRef } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import { useGetMyProfile, getGetMyProfileQueryKey, useUpdateMyProfile } from "@workspace/api-client-react";
import { Layout } from "@/components/layout/Layout";
import { FactCard } from "@/components/facts/FactCard";
import { Button } from "@/components/ui/Button";
import { SubscriptionPanel } from "@/components/SubscriptionPanel";
import { SpendCollapsible } from "@/components/ui/SpendHistory";
import { ShieldAlert, LogOut, Clock, ThumbsUp, FileText, Hash, Star, X, Pencil, Check, Mail, AlertTriangle, CheckCircle, Camera, Loader2, Images, ImageIcon, UserCircle2, Image, Eraser, TrendingUp } from "lucide-react";
import { ImageCard } from "@/components/ui/ImageCard";
import { Link, useLocation } from "wouter";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { PronounEditor } from "@/components/ui/PronounEditor";
import { usePersonName } from "@/hooks/use-person-name";
import { AccessGate } from "@/components/AccessGate";

const BASE_URL = import.meta.env.BASE_URL ?? "/";

export default function Profile() {
  const [currentPath, setLocation] = useLocation();
  const { isAuthenticated, isLoading: authLoading, login, logout } = useAuth();
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
  const [avatarSourceToggling, setAvatarSourceToggling] = useState(false);
  const [forgetMeConfirm, setForgetMeConfirm] = useState(false);
  const [forgetMeLoading, setForgetMeLoading] = useState(false);

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

  function getAvatarUrl() {
    if (profile?.isPremium && profile?.profileImageUrl && (profile?.avatarSource ?? "avatar") === "photo") {
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
      setCheckoutBanner("success");
      setLocation(currentPath, { replace: true });
    }
    if (params.get("emailVerified") === "1") {
      setEmailVerifiedBanner(true);
      setLocation(currentPath, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll /api/stripe/membership directly after checkout — webhook may arrive after redirect.
  // This effect runs only when checkoutBanner becomes "success" and does NOT depend on
  // profile data (which may still be loading at that point).
  useEffect(() => {
    if (checkoutBanner !== "success") return;

    setCheckoutPolling(true);
    let attempts = 0;
    const maxAttempts = 15; // ~30 seconds at 2s intervals
    let cancelled = false;

    const poll = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch("/api/stripe/membership", { credentials: "include" });
        if (!cancelled && res.ok) {
          const data = (await res.json()) as { tier?: string };
          if (data.tier === "legendary") {
            clearInterval(poll);
            setCheckoutPolling(false);
            setCheckoutConfirmed(true);
            // Refresh profile so the subscription panel reflects the new tier
            await queryClient.invalidateQueries({ queryKey: getGetMyProfileQueryKey() });
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
      }
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [checkoutBanner]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const uploadRes = await fetch(`${BASE_URL}api/storage/upload-avatar`, {
        method: "POST",
        headers: { "Content-Type": file.type },
        credentials: "include",
        body: file,
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

  return (
    <Layout>
      <div className="max-w-5xl mx-auto px-4 py-12 md:py-20">

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

        {/* Profile Header */}
        <div className="bg-card border-2 border-border p-8 rounded-sm shadow-xl flex flex-col md:flex-row items-center gap-8 relative overflow-hidden mb-8">
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
              onClick={() => profile.isPremium ? fileInputRef.current?.click() : openEditor()}
              disabled={photoUploading}
              className="relative block rounded-sm focus:outline-none focus:ring-2 focus:ring-primary"
              title={profile.isPremium ? "Change profile photo" : "Choose avatar style"}
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

            {/* Avatar source toggle — Legendary users with a custom photo */}
            {profile.isPremium && profile.profileImageUrl && (
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
              <LogOut className="w-4 h-4" /> DISCONNECT
            </Button>
            {!forgetMeConfirm ? (
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
            )}
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

              {/* Photo Upload — Premium only */}
              {profile.isPremium ? (
                <div>
                  <label className="block text-sm font-bold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-2">
                    <Camera className="w-3.5 h-3.5" /> Custom Photo <span className="text-primary text-xs">Legendary</span>
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
                      ? "Toggle between your avatar style and your custom photo, or upload a new photo."
                      : "Upload a photo to replace your generated avatar. JPEG, PNG, WebP or GIF, max 5 MB."}
                  </p>
                </div>
              ) : (
                <AccessGate reason="legendary" size="sm" description="Go Legendary to replace your generated avatar with a custom photo." />
              )}

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

        {/* Subscription Panel */}
        <SubscriptionPanel refetchTrigger={checkoutConfirmed || undefined} />

        {/* Generation Cost Tracker */}
        <div className="bg-card border-2 border-border p-5 rounded-sm shadow mb-4">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-4 h-4 text-primary" />
            <h2 className="font-display text-base uppercase tracking-wide text-foreground">AI Generation Costs</h2>
          </div>
          <SpendCollapsible endpoint="/api/users/me/spend" />
        </div>

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
        <div className="flex overflow-x-auto gap-2 mb-8 border-b-2 border-border pb-[-2px] no-scrollbar">
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
          {profile.isPremium && (
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
