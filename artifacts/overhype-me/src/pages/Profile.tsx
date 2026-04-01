import { useState, useEffect, useRef } from "react";
import { useAuth } from "@workspace/replit-auth-web";
import { useGetMyProfile, getGetMyProfileQueryKey, useUpdateMyProfile } from "@workspace/api-client-react";
import { Layout } from "@/components/layout/Layout";
import { FactCard } from "@/components/facts/FactCard";
import { Button } from "@/components/ui/Button";
import { SubscriptionPanel } from "@/components/SubscriptionPanel";
import { ShieldAlert, LogOut, Clock, ThumbsUp, FileText, Hash, Star, X, Pencil, Check, Mail, AlertTriangle, CheckCircle, Camera, Loader2 } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { PronounEditor } from "@/components/ui/PronounEditor";

const BASE_URL = import.meta.env.BASE_URL ?? "/";

export default function Profile() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, login, logout } = useAuth();
  const queryClient = useQueryClient();
  const { data: profile, isLoading } = useGetMyProfile({
    query: { queryKey: getGetMyProfileQueryKey(), enabled: isAuthenticated, retry: false }
  });

  const updateProfile = useUpdateMyProfile();

  const [activeTab, setActiveTab] = useState<"submitted" | "liked" | "history">("liked");
  const [checkoutBanner, setCheckoutBanner] = useState<"success" | "cancel" | null>(null);
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
  const [draftAvatarStyle, setDraftAvatarStyle] = useState("bottts");
  const [draftPronouns, setDraftPronouns] = useState("");
  const [draftEmail, setDraftEmail] = useState("");
  const [editError, setEditError] = useState("");
  const [editSuccess, setEditSuccess] = useState("");
  const [resendStatus, setResendStatus] = useState("");

  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  function dicebearUrl(style: string, seed: string) {
    return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}`;
  }

  function getAvatarUrl() {
    if (profile?.isPremium && profile?.profileImageUrl) return profile.profileImageUrl;
    return dicebearUrl(profile?.avatarStyle ?? "bottts", profile?.id ?? "default");
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "success") {
      setCheckoutBanner("success");
      window.history.replaceState({}, "", window.location.pathname);
    }
    if (params.get("emailVerified") === "1") {
      setEmailVerifiedBanner(true);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  function openEditor() {
    setDraftDisplayName(profile?.displayName ?? "");
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
    if (draftAvatarStyle !== (profile?.avatarStyle ?? "bottts")) body.avatarStyle = draftAvatarStyle;
    if (draftPronouns !== (profile?.pronouns ?? "")) body.pronouns = draftPronouns;
    if (draftEmail.trim()) body.email = draftEmail.trim();

    if (Object.keys(body).length === 0) {
      cancelEditor();
      return;
    }

    try {
      const result = await updateProfile.mutateAsync(body);
      await queryClient.invalidateQueries({ queryKey: getGetMyProfileQueryKey() });
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
      const urlRes = await fetch(`${BASE_URL}api/storage/uploads/request-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!urlRes.ok) {
        const errData = await urlRes.json() as { error?: string };
        throw new Error(errData.error ?? "Failed to get upload URL");
      }
      const { uploadURL, objectPath } = await urlRes.json() as { uploadURL: string; objectPath: string };

      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error("Upload to storage failed");

      const profileImageUrl = `/api/storage${objectPath}`;
      await updateProfile.mutateAsync({ profileImageUrl });
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

  if (!isAuthenticated) {
    return (
      <Layout>
        <div className="max-w-2xl mx-auto px-4 py-24 text-center">
          <ShieldAlert className="w-20 h-20 text-primary mx-auto mb-6 opacity-80" />
          <h1 className="text-4xl font-display uppercase mb-4 text-foreground">Access Denied</h1>
          <p className="text-muted-foreground text-lg mb-8">You must authenticate to access personnel records.</p>
          <div className="flex gap-4 justify-center">
            <Button size="lg" onClick={() => setLocation("/login")}>AUTHENTICATE NOW</Button>
            <Button size="lg" variant="outline" onClick={() => window.history.length > 1 ? window.history.back() : setLocation("/")}>GO BACK</Button>
          </div>
        </div>
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
              <Star className="w-5 h-5 text-primary shrink-0" />
              <p className="font-bold text-foreground">Welcome to Premium! Your membership is now active. Daily facts incoming.</p>
            </div>
            <button onClick={() => setCheckoutBanner(null)} className="text-muted-foreground hover:text-foreground shrink-0">
              <X className="w-4 h-4" />
            </button>
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
                    <Camera className="w-3.5 h-3.5" /> Custom Photo <span className="text-primary text-xs">Premium</span>
                  </label>
                  <div className="flex items-center gap-4">
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
                  </div>
                  {photoError && <p className="text-xs text-destructive mt-1">{photoError}</p>}
                  <p className="text-xs text-muted-foreground mt-1">Replaces your generated avatar. JPEG, PNG, WebP or GIF, max 5 MB.</p>
                </div>
              ) : (
                <div className="flex items-start gap-3 bg-primary/5 border border-primary/20 rounded-sm p-3">
                  <Star className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-bold text-foreground">Custom Photo — Premium Feature</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Upgrade to Premium to replace your generated avatar with a custom photo.</p>
                  </div>
                </div>
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
        <SubscriptionPanel />

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
            <ThumbsUp className="w-5 h-5" /> Liked Intel ({profile.likedFacts.length})
          </button>
          <button 
            onClick={() => setActiveTab("submitted")}
            className={`flex items-center gap-2 px-6 py-4 font-display text-lg uppercase tracking-wider transition-colors border-b-2 whitespace-nowrap ${activeTab === "submitted" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"}`}
          >
            <FileText className="w-5 h-5" /> Submissions ({profile.submittedFacts.length})
          </button>
          <button 
            onClick={() => setActiveTab("history")}
            className={`flex items-center gap-2 px-6 py-4 font-display text-lg uppercase tracking-wider transition-colors border-b-2 whitespace-nowrap ${activeTab === "history" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"}`}
          >
            <Clock className="w-5 h-5" /> Search History
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {profile.submittedFacts.map(fact => <FactCard key={fact.id} fact={fact} />)}
              {profile.submittedFacts.length === 0 && (
                <div className="col-span-full text-center py-12 bg-card border-2 border-dashed border-border rounded-sm">
                  <p className="text-muted-foreground text-lg mb-4">You haven't contributed any intel yet.</p>
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
        </div>

      </div>
    </Layout>
  );
}
