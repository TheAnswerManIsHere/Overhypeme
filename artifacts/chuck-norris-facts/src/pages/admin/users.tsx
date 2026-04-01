import { useEffect, useRef, useState } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Shield, ShieldOff, Search, Pencil, X, Save, AlertCircle, CheckCircle, Crown, Star } from "lucide-react";

interface User {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  profileImageUrl: string | null;
  isAdmin: boolean;
  captchaVerified: boolean;
  membershipTier: "free" | "premium";
  pronouns: "he/him" | "she/her" | "they/them" | null;
  stripeCustomerId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UsersResponse {
  users: User[];
  total: number;
  page: number;
  limit: number;
}

type EditDraft = Pick<User, "firstName" | "lastName" | "email" | "username" | "isAdmin" | "captchaVerified" | "membershipTier" | "pronouns">;

const LIMIT = 50;

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">
      {children}
    </label>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="h-9 px-3 flex items-center bg-muted/40 border border-border rounded-sm text-sm text-muted-foreground font-mono select-all truncate">
        {value || "—"}
      </div>
    </div>
  );
}

function displayName(u: User) {
  if (u.firstName || u.lastName) return [u.firstName, u.lastName].filter(Boolean).join(" ");
  return u.username ?? u.email ?? u.id.slice(0, 12) + "…";
}

export default function AdminUsers() {
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [loading, setLoading] = useState(false);

  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300);
  }, [search]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
    if (debouncedSearch) params.set("search", debouncedSearch);
    fetch(`/api/admin/users?${params}`, { credentials: "include" })
      .then(async (r) => {
        const data = (await r.json()) as Partial<UsersResponse>;
        if (r.ok && Array.isArray(data.users)) {
          setUsers(data.users as User[]);
          setTotal(data.total ?? 0);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, debouncedSearch]);

  function selectUser(user: User) {
    setSelectedUser(user);
    setDraft({
      firstName: user.firstName ?? "",
      lastName: user.lastName ?? "",
      email: user.email ?? "",
      username: user.username ?? "",
      isAdmin: user.isAdmin,
      captchaVerified: user.captchaVerified,
      membershipTier: user.membershipTier,
      pronouns: user.pronouns ?? "he/him",
    });
    setSaveResult(null);
  }

  function clearSelection() {
    setSelectedUser(null);
    setDraft(null);
    setSaveResult(null);
  }

  async function saveUser() {
    if (!selectedUser || !draft) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await fetch(`/api/admin/users/${selectedUser.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: draft.firstName || null,
          lastName: draft.lastName || null,
          email: draft.email || null,
          username: draft.username || null,
          isAdmin: draft.isAdmin,
          captchaVerified: draft.captchaVerified,
          membershipTier: draft.membershipTier,
          pronouns: draft.pronouns,
        }),
      });
      const data = (await res.json()) as { success?: boolean; user?: User; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      const updated = data.user!;
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      setSelectedUser(updated);
      setSaveResult({ type: "success", message: "Saved successfully." });
    } catch (err) {
      setSaveResult({ type: "error", message: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <AdminLayout title="Users">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Left — user list */}
        <div className="bg-card border border-border rounded-lg overflow-hidden flex flex-col">
          <div className="p-4 border-b border-border flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                placeholder="Search name, email, username, ID…"
                className="pl-9"
              />
            </div>
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              {total} user{total !== 1 ? "s" : ""}
            </span>
          </div>

          <div className="flex-1 overflow-auto divide-y divide-border">
            {loading ? (
              <div className="p-8 text-center text-muted-foreground text-sm">Loading…</div>
            ) : users.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground text-sm">No users found.</div>
            ) : (
              users.map((user) => {
                const isSelected = selectedUser?.id === user.id;
                return (
                  <div
                    key={user.id}
                    onClick={() => selectUser(user)}
                    className={`flex items-center gap-3 px-4 py-3 cursor-pointer group transition-colors ${
                      isSelected
                        ? "bg-primary/10 border-l-2 border-primary"
                        : "hover:bg-muted/40 border-l-2 border-transparent"
                    }`}
                  >
                    {/* Avatar */}
                    {user.profileImageUrl ? (
                      <img src={user.profileImageUrl} alt="" className="w-8 h-8 rounded-full shrink-0 object-cover" />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0 text-xs font-bold text-muted-foreground">
                        {(user.firstName?.[0] ?? user.email?.[0] ?? "?").toUpperCase()}
                      </div>
                    )}

                    {/* Name + meta */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium text-foreground truncate">{displayName(user)}</span>
                        {user.isAdmin && <Shield className="w-3 h-3 text-primary shrink-0" title="Admin" />}
                        {user.membershipTier === "premium" && <Crown className="w-3 h-3 text-yellow-500 shrink-0" title="Premium" />}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {user.email ?? user.id.slice(0, 16) + "…"}
                      </div>
                    </div>

                    {/* Joined + pencil */}
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-muted-foreground hidden sm:block">
                        {new Date(user.createdAt).toLocaleDateString()}
                      </span>
                      <Pencil className={`w-3.5 h-3.5 transition-opacity ${isSelected ? "text-primary opacity-100" : "text-muted-foreground opacity-0 group-hover:opacity-100"}`} />
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {totalPages > 1 && (
            <div className="p-3 border-t border-border flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">Page {page} of {totalPages}</span>
              <Button variant="ghost" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
                Next
              </Button>
            </div>
          )}
        </div>

        {/* Right — edit panel or placeholder */}
        {selectedUser && draft ? (
          <div className="bg-card border border-border rounded-lg p-5 flex flex-col gap-4">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {selectedUser.profileImageUrl ? (
                  <img src={selectedUser.profileImageUrl} alt="" className="w-10 h-10 rounded-full object-cover" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-bold text-muted-foreground">
                    {(selectedUser.firstName?.[0] ?? selectedUser.email?.[0] ?? "?").toUpperCase()}
                  </div>
                )}
                <h2 className="font-display font-bold text-foreground uppercase tracking-wide flex items-center gap-2">
                  <Pencil className="w-4 h-4 text-primary" />
                  Edit User
                </h2>
              </div>
              <button onClick={clearSelection} className="p-1 text-muted-foreground hover:text-foreground transition-colors" title="Close">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Read-only identity */}
            <div className="grid grid-cols-1 gap-2">
              <ReadOnlyField label="User ID" value={selectedUser.id} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <ReadOnlyField label="Joined" value={new Date(selectedUser.createdAt).toLocaleString()} />
              <ReadOnlyField label="Stripe Customer ID" value={selectedUser.stripeCustomerId ?? ""} />
            </div>

            {/* Name row */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel>First Name</FieldLabel>
                <Input
                  value={draft.firstName ?? ""}
                  onChange={(e) => setDraft((d) => d ? { ...d, firstName: e.target.value } : d)}
                  placeholder="First name"
                />
              </div>
              <div>
                <FieldLabel>Last Name</FieldLabel>
                <Input
                  value={draft.lastName ?? ""}
                  onChange={(e) => setDraft((d) => d ? { ...d, lastName: e.target.value } : d)}
                  placeholder="Last name"
                />
              </div>
            </div>

            {/* Email + Username */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel>Email</FieldLabel>
                <Input
                  type="email"
                  value={draft.email ?? ""}
                  onChange={(e) => setDraft((d) => d ? { ...d, email: e.target.value } : d)}
                  placeholder="user@example.com"
                />
              </div>
              <div>
                <FieldLabel>Username</FieldLabel>
                <Input
                  value={draft.username ?? ""}
                  onChange={(e) => setDraft((d) => d ? { ...d, username: e.target.value } : d)}
                  placeholder="username"
                />
              </div>
            </div>

            {/* Membership tier */}
            <div>
              <FieldLabel>Membership Tier</FieldLabel>
              <div className="flex gap-2">
                {(["free", "premium"] as const).map((tier) => (
                  <button
                    key={tier}
                    onClick={() => setDraft((d) => d ? { ...d, membershipTier: tier } : d)}
                    className={`flex-1 flex items-center justify-center gap-2 h-9 rounded-sm border text-sm font-medium transition-colors ${
                      draft.membershipTier === tier
                        ? tier === "premium"
                          ? "border-yellow-500 bg-yellow-500/10 text-yellow-500"
                          : "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/40"
                    }`}
                  >
                    {tier === "premium" ? <Crown className="w-3.5 h-3.5" /> : <Star className="w-3.5 h-3.5" />}
                    {tier.charAt(0).toUpperCase() + tier.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Pronouns */}
            <div>
              <FieldLabel>Pronouns</FieldLabel>
              <div className="flex gap-2">
                {(["he/him", "she/her", "they/them"] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setDraft((d) => d ? { ...d, pronouns: p } : d)}
                    className={`flex-1 h-9 rounded-sm border text-xs font-medium transition-colors ${
                      draft.pronouns === p
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/40"
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {/* Toggle flags */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel>Admin Access</FieldLabel>
                <button
                  onClick={() => setDraft((d) => d ? { ...d, isAdmin: !d.isAdmin } : d)}
                  className={`w-full h-9 flex items-center justify-center gap-2 rounded-sm border text-sm font-medium transition-colors ${
                    draft.isAdmin
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-primary/40"
                  }`}
                >
                  {draft.isAdmin ? <Shield className="w-4 h-4" /> : <ShieldOff className="w-4 h-4" />}
                  {draft.isAdmin ? "Admin" : "Not Admin"}
                </button>
              </div>
              <div>
                <FieldLabel>CAPTCHA Verified</FieldLabel>
                <button
                  onClick={() => setDraft((d) => d ? { ...d, captchaVerified: !d.captchaVerified } : d)}
                  className={`w-full h-9 flex items-center justify-center gap-2 rounded-sm border text-sm font-medium transition-colors ${
                    draft.captchaVerified
                      ? "border-green-500 bg-green-500/10 text-green-500"
                      : "border-border text-muted-foreground hover:border-green-500/40"
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full ${draft.captchaVerified ? "bg-green-500" : "bg-muted-foreground"}`} />
                  {draft.captchaVerified ? "Verified" : "Unverified"}
                </button>
              </div>
            </div>

            {/* Save result */}
            {saveResult && (
              <div className={`flex items-start gap-2 text-sm px-3 py-2.5 rounded-sm ${
                saveResult.type === "success"
                  ? "bg-green-500/10 text-green-400 border border-green-500/30"
                  : "bg-destructive/10 text-destructive border border-destructive/30"
              }`}>
                {saveResult.type === "success"
                  ? <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  : <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />}
                {saveResult.message}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-1">
              <Button onClick={saveUser} isLoading={saving} className="flex-1">
                <Save className="w-4 h-4" /> Save Changes
              </Button>
              <Button variant="outline" onClick={clearSelection} className="flex-1">
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          /* Placeholder when no user is selected */
          <div className="bg-card border border-dashed border-border rounded-lg flex flex-col items-center justify-center text-center p-12 text-muted-foreground gap-3">
            <Pencil className="w-8 h-8 opacity-30" />
            <p className="text-sm font-medium">Select a user from the list to edit their profile, toggle admin access, or change their membership tier.</p>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
