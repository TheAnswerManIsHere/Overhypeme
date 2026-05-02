import { useState, useEffect, useRef } from "react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Film, Plus, Save, Trash2, Upload, X, ChevronDown, ChevronUp, Eye, EyeOff } from "lucide-react";
import type { VideoStyleDef } from "@/config/videoStyles";

interface StyleRow extends VideoStyleDef {
  updatedAt: string;
  createdAt: string;
}

function GifPreview({ styleId, gifPath }: { styleId: string; gifPath: string | null }) {
  if (!gifPath) return null;
  return (
    <img
      src={`/api/video-styles/${styleId}/preview-gif`}
      alt="Style preview"
      className="w-full h-24 object-cover rounded-sm"
    />
  );
}

function StyleEditor({ style, onSaved }: { style: StyleRow; onSaved: (updated: StyleRow) => void }) {
  const [form, setForm] = useState({
    label: style.label,
    description: style.description,
    motionPrompt: style.motionPrompt,
    gradientFrom: style.gradientFrom,
    gradientTo: style.gradientTo,
    sortOrder: String(style.sortOrder),
    isActive: style.isActive,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [uploadingGif, setUploadingGif] = useState(false);
  const [gifError, setGifError] = useState<string | null>(null);
  const [removingGif, setRemovingGif] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = (k: keyof typeof form, v: string | boolean) =>
    setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const r = await fetch(`/api/admin/video-styles/${style.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: form.label,
          description: form.description,
          motionPrompt: form.motionPrompt,
          gradientFrom: form.gradientFrom,
          gradientTo: form.gradientTo,
          sortOrder: parseInt(form.sortOrder, 10) || 0,
          isActive: form.isActive,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      const updated: StyleRow = await r.json();
      onSaved(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleGifUpload = async (file: File) => {
    if (!file.type.startsWith("image/gif") && !file.name.endsWith(".gif")) {
      setGifError("Please select a .gif file");
      return;
    }
    if (file.size > 1_800_000) {
      setGifError("GIF must be under 1.8 MB");
      return;
    }
    setUploadingGif(true);
    setGifError(null);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const r = await fetch(`/api/admin/video-styles/${style.id}/preview-gif`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base64 }),
      });
      if (!r.ok) throw new Error(await r.text());
      const updated: StyleRow = await r.json();
      onSaved(updated);
    } catch (e) {
      setGifError(String(e));
    } finally {
      setUploadingGif(false);
    }
  };

  const handleRemoveGif = async () => {
    setRemovingGif(true);
    try {
      const r = await fetch(`/api/admin/video-styles/${style.id}/preview-gif`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(await r.text());
      const updated: StyleRow = await r.json();
      onSaved(updated);
    } catch (e) {
      setGifError(String(e));
    } finally {
      setRemovingGif(false);
    }
  };

  return (
    <div className="space-y-4 pt-4 border-t border-border">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Label</label>
          <input
            value={form.label}
            onChange={(e) => set("label", e.target.value)}
            className="w-full px-3 py-1.5 text-sm bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
          />
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Sort Order</label>
            <input
              type="number"
              value={form.sortOrder}
              onChange={(e) => set("sortOrder", e.target.value)}
              className="w-24 min-h-[44px] px-3 py-1.5 text-sm bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
            />
          </div>
          <button
            onClick={() => set("isActive", !form.isActive)}
            className={`flex items-center gap-1.5 min-h-[44px] px-3 py-1.5 text-xs font-bold rounded-sm border transition-colors ${
              form.isActive
                ? "bg-green-500/10 border-green-500/40 text-green-400"
                : "bg-muted/30 border-border text-muted-foreground"
            }`}
          >
            {form.isActive ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            {form.isActive ? "Active" : "Inactive"}
          </button>
        </div>
      </div>

      <div>
        <label className="block text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Description</label>
        <input
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          className="w-full px-3 py-1.5 text-sm bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Motion Prompt</label>
        <textarea
          value={form.motionPrompt}
          onChange={(e) => set("motionPrompt", e.target.value)}
          rows={3}
          className="w-full px-3 py-1.5 text-sm bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary font-mono resize-y"
        />
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Gradient From</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={form.gradientFrom}
              onChange={(e) => set("gradientFrom", e.target.value)}
              className="w-11 h-11 rounded cursor-pointer border border-border"
            />
            <input
              value={form.gradientFrom}
              onChange={(e) => set("gradientFrom", e.target.value)}
              className="w-28 min-h-[44px] px-2 py-1 text-xs font-mono bg-muted/30 border border-border rounded-sm focus:outline-none"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Gradient To</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={form.gradientTo}
              onChange={(e) => set("gradientTo", e.target.value)}
              className="w-11 h-11 rounded cursor-pointer border border-border"
            />
            <input
              value={form.gradientTo}
              onChange={(e) => set("gradientTo", e.target.value)}
              className="w-28 min-h-[44px] px-2 py-1 text-xs font-mono bg-muted/30 border border-border rounded-sm focus:outline-none"
            />
          </div>
        </div>
        <div className="basis-full sm:basis-auto sm:flex-1 h-8 rounded-sm" style={{ background: `linear-gradient(135deg, ${form.gradientFrom}, ${form.gradientTo})` }} />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <button
        onClick={handleSave}
        disabled={saving}
        className="flex items-center gap-1.5 min-h-[44px] px-4 py-1.5 text-xs font-bold uppercase tracking-wide bg-primary text-primary-foreground rounded-sm hover:bg-primary/90 disabled:opacity-50 transition-colors"
      >
        <Save className="w-3.5 h-3.5" />
        {saving ? "Saving…" : saved ? "Saved!" : "Save Changes"}
      </button>

      <div className="border-t border-border pt-4 space-y-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Animated GIF Preview</p>
        {style.previewGifPath ? (
          <div className="space-y-2">
            <GifPreview styleId={style.id} gifPath={style.previewGifPath} />
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploadingGif}
                className="flex items-center gap-1.5 min-h-[44px] px-3 py-1 text-xs font-bold bg-muted/50 border border-border rounded-sm hover:border-primary/50 transition-colors"
              >
                <Upload className="w-3 h-3" /> Replace GIF
              </button>
              <button
                onClick={handleRemoveGif}
                disabled={removingGif}
                className="flex items-center gap-1.5 min-h-[44px] px-3 py-1 text-xs font-bold text-destructive border border-destructive/30 rounded-sm hover:bg-destructive/10 transition-colors"
              >
                <Trash2 className="w-3 h-3" /> {removingGif ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        ) : (
          <div>
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploadingGif}
              className="flex items-center gap-1.5 min-h-[44px] px-3 py-1.5 text-xs font-bold border border-dashed border-border rounded-sm hover:border-primary/50 text-muted-foreground hover:text-foreground transition-colors"
            >
              <Upload className="w-3.5 h-3.5" />
              {uploadingGif ? "Uploading…" : "Upload animated GIF (max 1.8 MB)"}
            </button>
          </div>
        )}
        <input ref={fileRef} type="file" accept=".gif,image/gif" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { handleGifUpload(f); e.target.value = ""; } }} />
        {gifError && <p className="text-xs text-destructive">{gifError}</p>}
      </div>
    </div>
  );
}

function StyleCard({ style, onSaved }: { style: StyleRow; onSaved: (updated: StyleRow) => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`bg-card border rounded-sm overflow-hidden ${!style.isActive ? "opacity-60" : "border-border"}`}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 p-4 hover:bg-muted/30 transition-colors text-left"
      >
        <div
          className="w-10 h-10 rounded-sm shrink-0 flex items-center justify-center overflow-hidden"
          style={{ background: `linear-gradient(135deg, ${style.gradientFrom}, ${style.gradientTo})` }}
        >
          {style.previewGifPath ? (
            <img
              src={`/api/video-styles/${style.id}/preview-gif`}
              alt=""
              className="w-full h-full object-cover"
            />
          ) : (
            <Film className="w-5 h-5 text-white/60" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-foreground">{style.label}</span>
            <span className="text-[10px] font-mono text-muted-foreground/60 bg-muted/50 px-1.5 py-0.5 rounded">{style.id}</span>
            {!style.isActive && <span className="text-[10px] font-bold text-muted-foreground bg-muted px-1.5 py-0.5 rounded">INACTIVE</span>}
            {style.previewGifPath && <span className="text-[10px] font-bold text-green-400 bg-green-500/10 px-1.5 py-0.5 rounded">GIF</span>}
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">{style.description}</p>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">#{style.sortOrder}</span>
        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>
      {expanded && (
        <div className="px-4 pb-4">
          <StyleEditor style={style} onSaved={onSaved} />
        </div>
      )}
    </div>
  );
}

function NewStyleForm({ onCreated }: { onCreated: (style: StyleRow) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ id: "", label: "", description: "", motionPrompt: "", gradientFrom: "#000000", gradientTo: "#333333" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const handleCreate = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/video-styles", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error(await r.text());
      const created: StyleRow = await r.json();
      onCreated(created);
      setForm({ id: "", label: "", description: "", motionPrompt: "", gradientFrom: "#000000", gradientTo: "#333333" });
      setOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 min-h-[44px] px-4 py-2 text-sm font-bold border border-dashed border-border rounded-sm text-muted-foreground hover:border-primary/50 hover:text-foreground transition-colors"
      >
        <Plus className="w-4 h-4" /> Add New Style
      </button>
    );
  }

  return (
    <div className="bg-card border border-primary/30 rounded-sm p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-foreground uppercase tracking-wide">New Style</h3>
        <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wide">ID (slug, e.g. "horror")</label>
          <input value={form.id} onChange={(e) => set("id", e.target.value)} placeholder="my-style" className="w-full min-h-[44px] px-3 py-1.5 text-sm bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary font-mono" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Label</label>
          <input value={form.label} onChange={(e) => set("label", e.target.value)} placeholder="My Style" className="w-full min-h-[44px] px-3 py-1.5 text-sm bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary" />
        </div>
      </div>
      <div>
        <label className="block text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Description</label>
        <input value={form.description} onChange={(e) => set("description", e.target.value)} className="w-full px-3 py-1.5 text-sm bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary" />
      </div>
      <div>
        <label className="block text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wide">Motion Prompt</label>
        <textarea value={form.motionPrompt} onChange={(e) => set("motionPrompt", e.target.value)} rows={2} className="w-full px-3 py-1.5 text-sm bg-muted/30 border border-border rounded-sm focus:outline-none focus:border-primary font-mono resize-y" />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <button onClick={handleCreate} disabled={saving || !form.id || !form.label} className="flex items-center gap-1.5 min-h-[44px] px-4 py-1.5 text-xs font-bold uppercase tracking-wide bg-primary text-primary-foreground rounded-sm hover:bg-primary/90 disabled:opacity-50 transition-colors">
        <Plus className="w-3.5 h-3.5" /> {saving ? "Creating…" : "Create Style"}
      </button>
    </div>
  );
}

export default function AdminVideoStyles() {
  const [styles, setStyles] = useState<StyleRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/video-styles", { credentials: "include" })
      .then((r) => r.json())
      .then((data: StyleRow[]) => { setStyles(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleSaved = (updated: StyleRow) =>
    setStyles((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));

  const handleCreated = (created: StyleRow) =>
    setStyles((prev) => [...prev, created].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)));

  return (
    <AdminLayout title="Video Styles">
      <div className="max-w-3xl space-y-4">
        <p className="text-sm text-muted-foreground">
          Manage the motion styles available in the video builder. Each style defines a motion prompt sent to the AI video model and an optional animated GIF preview shown to users in the style picker.
        </p>

        {loading ? (
          <div className="text-muted-foreground text-sm">Loading…</div>
        ) : (
          <div className="space-y-2">
            {styles.map((style) => (
              <StyleCard key={style.id} style={style} onSaved={handleSaved} />
            ))}
          </div>
        )}

        <NewStyleForm onCreated={handleCreated} />
      </div>
    </AdminLayout>
  );
}
