import { useEffect, useRef, useState } from "react";
import { PronounEditor } from "@/components/ui/PronounEditor";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SpendInline } from "@/components/ui/SpendHistory";
import { Shield, ShieldOff, Search, Pencil, X, Save, AlertCircle, CheckCircle, Crown, Star, UserPlus, MailCheck, Trash2, UserX, ExternalLink } from "lucide-react";

interface User {
  id: string;
  email: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  isAdmin: boolean;
  captchaVerified: boolean;
  membershipTier: "free" | "premium";
  pronouns: string | null;
  stripeCustomerId: string | null;
  emailVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UsersResponse {
  users: User[];
  total: number;
  page: number;
  limit: number;
}

type EditDraft = Pick<User, "displayName" | "email" | "isAdmin" | "captchaVerified" | "membershipTier" | "pronouns">;

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
  return u.displayName ?? u.email ?? u.id.slice(0, 12) + "…";
}

interface AddUserForm {
  email: string;
  password: string;
  displayName: string;
  membershipTier: "free" | "premium";
  isAdmin: boolean;
}

const EMPTY_ADD_FORM: AddUserForm = {
  email: "",
  password: "",
  displayName: "",
  membershipTier: "free",
  isAdmin: false,
};

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
  const [verifyingEmail, setVerifyingEmail] = useState(false);

  const [showAddModal, setShowAddModal] = useState(false);
  const [addForm, setAddForm] = useState<AddUserForm>(EMPTY_ADD_FORM);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSaving, setAddSaving] = useState(false);

  const [deleteModal, setDeleteModal] = useState<null | "choose" | "confirm-hard">(null);
  const [deleting, setDeleting] = useState(false);

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
      displayName: user.displayName ?? "",
      email: user.email ?? "",
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

  async function verifyEmail() {
    if (!selectedUser) return;
    setVerifyingEmail(true);
    try {
      const res = await fetch(`/api/admin/users/${selectedUser.id}/verify-email`, {
        method: "POST",
        credentials: "include",
      });
      const data = (await res.json()) as { success?: boolean; user?: User; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Verification failed");
      const updated = data.user!;
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      setSelectedUser(updated);
    } catch (err) {
      setSaveResult({ type: "error", message: err instanceof Error ? err.message : "Verification failed" });
    } finally {
      setVerifyingEmail(false);
    }
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
          displayName: draft.displayName || null,
          email: draft.email || null,
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

  async function addUser() {
    setAddError(null);
    if (!addForm.email.trim()) { setAddError("Email is required"); return; }
    if (!addForm.password) { setAddError("Password is required"); return; }
    if (addForm.password.length < 8) { setAddError("Password must be at least 8 characters"); return; }
    if (!addForm.displayName.trim()) { setAddError("Display name is required"); return; }
    setAddSaving(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: addForm.email.trim(),
          password: addForm.password,
          displayName: addForm.displayName.trim(),
          membershipTier: addForm.membershipTier,
          isAdmin: addForm.isAdmin,
        }),
      });
      const data = (await res.json()) as { success?: boolean; user?: User; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to create user");
      const newUser = data.user!;
      setUsers((prev) => [newUser, ...prev]);
      setTotal((t) => t + 1);
      setShowAddModal(false);
      setAddForm(EMPTY_ADD_FORM);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setAddSaving(false);
    }
  }

  async function deleteUser(hard: boolean) {
    if (!selectedUser) return;
    setDeleting(true);
    try {
      const url = `/api/admin/users/${selectedUser.id}${hard ? "?hard=true" : ""}`;
      const res = await fetch(url, { method: "DELETE", credentials: "include" });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Delete failed");
      setUsers((prev) => prev.filter((u) => u.id !== selectedUser.id));
      setTotal((t) => t - 1);
      clearSelection();
      setDeleteModal(null);
    } catch (err) {
      setSaveResult({ type: "error", message: err instanceof Error ? err.message : "Delete failed" });
      setDeleteModal(null);
    } finally {
      setDeleting(false);
    }
  }

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <AdminLayout title="Users">
      {/* Delete Modal */}
      {deleteModal && selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-sm p-6 flex flex-col gap-5 shadow-xl">
            {deleteModal === "choose" ? (
              <>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
                    <Trash2 className="w-5 h-5 text-destructive" />
                  </div>
                  <div>
                    <h2 className="font-display font-bold text-foreground uppercase tracking-wide">Delete User</h2>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[220px]">
                      {selectedUser.displayName ?? selectedUser.email ?? selectedUser.id}
                    </p>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">Choose how to delete this user:</p>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => deleteUser(false)}
                    disabled={deleting}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-sm border border-border hover:border-yellow-500/50 hover:bg-yellow-500/5 text-left transition-colors disabled:opacity-50"
                  >
                    <UserX className="w-5 h-5 text-yellow-500 shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-foreground">Soft Delete</div>
                      <div className="text-xs text-muted-foreground">Marks the user as inactive. Data is preserved.</div>
                    </div>
                  </button>
                  <button
                    onClick={() => setDeleteModal("confirm-hard")}
                    disabled={deleting}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-sm border border-border hover:border-destructive/50 hover:bg-destructive/5 text-left transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="w-5 h-5 text-destructive shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-foreground">Hard Delete</div>
                      <div className="text-xs text-muted-foreground">Permanently removes the user row from the database.</div>
                    </div>
                  </button>
                </div>
                <Button variant="outline" onClick={() => setDeleteModal(null)} className="w-full">
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
                    <Trash2 className="w-5 h-5 text-destructive" />
                  </div>
                  <div>
                    <h2 className="font-display font-bold text-foreground uppercase tracking-wide">Confirm Hard Delete</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">This action cannot be undone.</p>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  You are about to <span className="text-destructive font-semibold">permanently delete</span> all data for{" "}
                  <span className="font-medium text-foreground">
                    {selectedUser.displayName ?? selectedUser.email ?? selectedUser.id}
                  </span>
                  . This cannot be reversed.
                </p>
                <div className="flex gap-3">
                  <Button
                    onClick={() => deleteUser(true)}
                    isLoading={deleting}
                    className="flex-1 bg-destructive hover:bg-destructive/90 text-destructive-foreground border-destructive"
                  >
                    <Trash2 className="w-4 h-4" /> Delete Forever
                  </Button>
                  <Button variant="outline" onClick={() => setDeleteModal("choose")} className="flex-1" disabled={deleting}>
                    Back
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Add User Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-card border border-border rounded-lg w-full max-w-md p-6 flex flex-col gap-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="font-display font-bold text-foreground uppercase tracking-wide flex items-center gap-2">
                <UserPlus className="w-4 h-4 text-primary" />
                Add User
              </h2>
              <button
                onClick={() => { setShowAddModal(false); setAddForm(EMPTY_ADD_FORM); setAddError(null); }}
                className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div>
              <FieldLabel>Display Name <span className="text-destructive">*</span></FieldLabel>
              <Input
                value={addForm.displayName}
                onChange={(e) => setAddForm((f) => ({ ...f, displayName: e.target.value }))}
                placeholder="Name inserted into personalized facts (e.g. Alex Smith)"
              />
            </div>

            <div>
              <FieldLabel>Email <span className="text-destructive">*</span></FieldLabel>
              <Input
                type="email"
                value={addForm.email}
                onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="user@example.com"
              />
            </div>

            <div>
              <FieldLabel>Password <span className="text-destructive">*</span></FieldLabel>
              <Input
                type="password"
                value={addForm.password}
                onChange={(e) => setAddForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="Min. 8 characters"
              />
            </div>

            <div>
              <FieldLabel>Membership Tier</FieldLabel>
              <div className="flex gap-2">
                {(["free", "premium"] as const).map((tier) => (
                  <button
                    key={tier}
                    onClick={() => setAddForm((f) => ({ ...f, membershipTier: tier }))}
                    className={`flex-1 flex items-center justify-center gap-2 h-9 rounded-sm border text-sm font-medium transition-colors ${
                      addForm.membershipTier === tier
                        ? tier === "premium"
                          ? "border-yellow-500 bg-yellow-500/10 text-yellow-500"
                          : "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/40"
                    }`}
                  >
                    {tier === "premium" ? <Crown className="w-3.5 h-3.5" /> : <Star className="w-3.5 h-3.5" />}
                    {tier === "premium" ? "Legendary" : "Free"}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <FieldLabel>Admin Access</FieldLabel>
              <button
                onClick={() => setAddForm((f) => ({ ...f, isAdmin: !f.isAdmin }))}
                className={`w-full h-9 flex items-center justify-center gap-2 rounded-sm border text-sm font-medium transition-colors ${
                  addForm.isAdmin
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/40"
                }`}
              >
                {addForm.isAdmin ? <Shield className="w-4 h-4" /> : <ShieldOff className="w-4 h-4" />}
                {addForm.isAdmin ? "Admin" : "Not Admin"}
              </button>
            </div>

            {addError && (
              <div className="flex items-start gap-2 text-sm px-3 py-2.5 rounded-sm bg-destructive/10 text-destructive border border-destructive/30">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                {addError}
              </div>
            )}

            <div className="flex gap-3 pt-1">
              <Button onClick={addUser} isLoading={addSaving} className="flex-1">
                <UserPlus className="w-4 h-4" /> Create User
              </Button>
              <Button
                variant="outline"
                onClick={() => { setShowAddModal(false); setAddForm(EMPTY_ADD_FORM); setAddError(null); }}
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Left — user list */}
        <div className="bg-card border border-border rounded-lg overflow-hidden flex flex-col">
          <div className="p-4 border-b border-border flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                placeholder="Search name, email, or ID…"
                className="pl-9"
              />
            </div>
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              {total} user{total !== 1 ? "s" : ""}
            </span>
            <Button size="sm" onClick={() => { setAddForm(EMPTY_ADD_FORM); setAddError(null); setShowAddModal(true); }}>
              <UserPlus className="w-4 h-4" /> Add User
            </Button>
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
                        {(user.displayName?.[0] ?? user.email?.[0] ?? "?").toUpperCase()}
                      </div>
                    )}

                    {/* Name + meta */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium text-foreground truncate">{displayName(user)}</span>
                        {user.isAdmin && <Shield className="w-3 h-3 text-primary shrink-0" title="Admin" />}
                        {user.membershipTier === "premium" && <Crown className="w-3 h-3 text-yellow-500 shrink-0" title="Legendary" />}
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
                    {(selectedUser.displayName?.[0] ?? selectedUser.email?.[0] ?? "?").toUpperCase()}
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
              <div>
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-1">Stripe Customer ID</p>
                {selectedUser.stripeCustomerId ? (
                  <a
                    href={`https://dashboard.stripe.com/test/customers/${selectedUser.stripeCustomerId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-sm font-mono text-primary hover:underline truncate"
                  >
                    {selectedUser.stripeCustomerId}
                    <ExternalLink className="w-3 h-3 shrink-0" />
                  </a>
                ) : (
                  <p className="text-sm text-muted-foreground italic">—</p>
                )}
              </div>
            </div>

            {/* Display Name */}
            <div>
              <FieldLabel>Display Name</FieldLabel>
              <Input
                value={draft.displayName ?? ""}
                onChange={(e) => setDraft((d) => d ? { ...d, displayName: e.target.value } : d)}
                placeholder="Name inserted into personalized facts"
              />
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
            </div>

            {/* Generation Costs */}
            <div>
              <FieldLabel>Generation Costs</FieldLabel>
              <SpendInline userId={selectedUser.id} isAdmin />
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
                    {tier === "premium" ? "Legendary" : "Free"}
                  </button>
                ))}
              </div>
            </div>

            {/* Pronouns */}
            <div>
              <FieldLabel>Pronouns</FieldLabel>
              <PronounEditor
                value={draft.pronouns ?? ""}
                onChange={(val) => setDraft((d) => d ? { ...d, pronouns: val || null } : d)}
              />
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

            {/* Email verification */}
            <div>
              <FieldLabel>Email Verified</FieldLabel>
              {selectedUser.emailVerifiedAt ? (
                <div className="w-full h-9 flex items-center justify-center gap-2 rounded-sm border border-green-500 bg-green-500/10 text-green-500 text-sm font-medium">
                  <MailCheck className="w-4 h-4" />
                  Verified {new Date(selectedUser.emailVerifiedAt).toLocaleDateString()}
                </div>
              ) : (
                <button
                  onClick={verifyEmail}
                  disabled={verifyingEmail}
                  className="w-full h-9 flex items-center justify-center gap-2 rounded-sm border border-border text-muted-foreground hover:border-green-500/40 hover:text-green-500 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <MailCheck className="w-4 h-4" />
                  {verifyingEmail ? "Verifying…" : "Mark as Verified"}
                </button>
              )}
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

            <div className="border-t border-border pt-3">
              <Button
                variant="outline"
                onClick={() => setDeleteModal("choose")}
                className="w-full text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive/60"
              >
                <Trash2 className="w-4 h-4" /> Delete User
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
