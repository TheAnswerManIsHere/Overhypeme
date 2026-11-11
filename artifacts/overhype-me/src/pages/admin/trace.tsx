/**
 * Trace an image — /admin/trace (image tracing, plan
 * `docs/plans/PLAN_IMAGE_TRACING.md`). An admin pastes a record id or a link
 * (a meme link, a stored image link), or gives the picture itself — a file,
 * dropped or pasted — which is traced by the id stamped in its metadata, its
 * exact bytes, and the id in its invisible watermark; they see every matching provenance
 * record: what the picture is, who made it and when, the engine and the exact
 * request it received, the code version it was made under (the commit, its
 * date and pull-request title), the picture it was made from, which lookup
 * matched, and whether the meme, the picture and the account still exist.
 * When nothing matches it says what it tried.
 */
import { useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { Link } from "wouter";
import { AlertTriangle, ImageUp, Search } from "lucide-react";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

interface ProvenanceRecord {
  id: number;
  kind: string;
  generationRequestId: number | null;
  sourceProvenanceId: number | null;
  actorKind: string;
  actorUserId: string | null;
  actorEmail: string | null;
  memeSlug: string | null;
  objectPath: string | null;
  attemptId: number | null;
  comparisonCellId: number | null;
  factId: number | null;
  engineId: string | null;
  snapshot: Record<string, unknown>;
  sha256: string;
  mime: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  watermarkScheme: string | null;
  sourceCommit: string | null;
  sourceCommitAt: string | null;
  sourceCommitTitle: string | null;
  deploymentId: string | null;
  createdAt: string;
}

interface GenerationRequest {
  id: number;
  producer: string;
  engineId: string | null;
  endpointId: string;
  request: Record<string, unknown>;
  vendorRequestId: string | null;
  actorKind: string;
  actorUserId: string | null;
  actorEmail: string | null;
  sourceCommit: string | null;
  sourceCommitAt: string | null;
  sourceCommitTitle: string | null;
  createdAt: string;
}

interface TracedRecord {
  record: ProvenanceRecord;
  generationRequest: GenerationRequest | null;
  source: ProvenanceRecord | null;
  stillExists: { account: boolean | null; meme: boolean | null };
}

interface TraceResult {
  method: "id" | "link" | "metadata" | "hash" | "watermark" | null;
  matches: TracedRecord[];
  tried: string[];
  note: string | null;
}

const KIND_LABEL: Record<string, string> = {
  ai_render: "AI render",
  comparison_cell: "Engine comparison picture",
  workbench: "Engine workbench test",
  upload: "Member upload",
  meme_bake: "Saved meme",
  meme_live: "Meme (rendered live)",
  preview: "Meme preview",
  download: "Meme download",
};

const PRODUCER_LABEL: Record<string, string> = {
  product_render: "product render",
  review_render: "moderation render",
  eval_render: "eval render",
  comparison_cell: "engine comparison",
  engine_workbench: "engine workbench",
};

const METHOD_LABEL: Record<string, string> = {
  id: "the record id",
  link: "the link",
  metadata: "the id stamped in the file",
  hash: "the file's exact bytes",
  watermark: "the invisible watermark",
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2 py-0.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground break-all">{children}</span>
    </div>
  );
}

function Maker({ kind, userId, email, accountExists }: { kind: string; userId: string | null; email: string | null; accountExists?: boolean | null }) {
  if (kind === "anonymous") return <>Nobody signed in</>;
  if (kind === "system") return <>Unattended (no person started it)</>;
  return (
    <>
      {kind === "admin" ? "Admin" : "Member"}{" "}
      {email ? <span className="font-mono">{email}</span> : <span className="text-muted-foreground">(no email recorded)</span>}
      {userId && <span className="text-muted-foreground"> · account {userId}</span>}
      {accountExists === false && <span className="text-amber-600 dark:text-amber-400 font-semibold"> · account since deleted</span>}
      {email && <span className="block text-[11px] text-muted-foreground">The account's contact address when the picture was made — not proof of who the person is.</span>}
    </>
  );
}

function CodeVersion({ commit, at, title }: { commit: string | null; at: string | null; title: string | null }) {
  if (!commit) return <span className="text-muted-foreground">Unversioned (a development or test run)</span>;
  return (
    <>
      <a className="font-mono underline" href={`https://github.com/TheAnswerManIsHere/Overhypeme/commit/${commit}`} target="_blank" rel="noreferrer">
        {commit.slice(0, 7)}
      </a>
      {at && <span className="text-muted-foreground"> · {when(at)}</span>}
      {title && <span className="block">{title}</span>}
    </>
  );
}

function isIdentity(v: unknown): v is { name: string | null; pronouns: string | null } {
  return typeof v === "object" && v !== null && "name" in v;
}

function promptOf(t: TracedRecord): string | null {
  const fromRequest = t.generationRequest?.request?.["prompt"];
  if (typeof fromRequest === "string") return fromRequest;
  const fromSnapshot = t.record.snapshot?.["prompt"];
  return typeof fromSnapshot === "string" ? fromSnapshot : null;
}

function RecordCard({ t }: { t: TracedRecord }) {
  const r = t.record;
  const req = t.generationRequest;
  const prompt = promptOf(t);
  const stageDiffers = req && req.sourceCommit !== r.sourceCommit;
  return (
    <div className="rounded-sm border border-border bg-background p-3 space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-bold text-foreground">{KIND_LABEL[r.kind] ?? r.kind}</span>
        <span className="text-xs font-mono text-muted-foreground">record {r.id}</span>
      </div>
      <div className="grid gap-3 md:grid-cols-[1fr_16rem]">
        <div>
          <Row label="Made">{when(r.createdAt)}</Row>
          <Row label="Made by"><Maker kind={r.actorKind} userId={r.actorUserId} email={r.actorEmail} accountExists={t.stillExists.account} /></Row>
          <Row label="Code version"><CodeVersion commit={r.sourceCommit} at={r.sourceCommitAt} title={r.sourceCommitTitle} /></Row>
          {r.engineId && <Row label="Engine"><span className="font-mono">{r.engineId}</span></Row>}
          {r.factId != null && <Row label="Fact"><Link href={`/facts/${r.factId}`} className="underline">fact {r.factId}</Link></Row>}
          {r.memeSlug && (
            <Row label="Meme">
              <Link href={`/m/${r.memeSlug}`} className="underline font-mono">{r.memeSlug}</Link>
              {t.stillExists.meme === false && <span className="text-amber-600 dark:text-amber-400 font-semibold"> · meme since deleted</span>}
            </Row>
          )}
          {r.attemptId != null && <Row label="Render attempt">{r.attemptId}</Row>}
          {r.comparisonCellId != null && <Row label="Comparison cell">{r.comparisonCellId}</Row>}
          <Row label="File">{r.mime} · {r.width && r.height ? `${r.width}×${r.height} · ` : ""}{r.byteSize.toLocaleString()} bytes</Row>
          <Row label="Exact hash (SHA-256)"><span className="font-mono">{r.sha256}</span></Row>
          {r.objectPath && <Row label="Stored at"><span className="font-mono">{r.objectPath}</span></Row>}
          {r.watermarkScheme && <Row label="Invisible watermark">carries record {r.id} ({r.watermarkScheme})</Row>}
          {typeof r.snapshot?.["caption"] === "string" && <Row label="Caption drawn"><span className="whitespace-pre-wrap">{r.snapshot["caption"] as string}</span></Row>}
          {isIdentity(r.snapshot?.["identity"]) && (
            <Row label="Personalised as">{r.snapshot["identity"].name ?? "—"} ({r.snapshot["identity"].pronouns ?? "—"})</Row>
          )}
        </div>
        {r.objectPath && r.mime.startsWith("image/") && (
          <a href={`/api/admin/provenance/images/${r.id}`} target="_blank" rel="noreferrer" className="block">
            <img
              src={`/api/admin/provenance/images/${r.id}`}
              alt={`The stored picture of record ${r.id}`}
              className="w-full rounded-sm border border-border bg-muted/30"
              onError={(e) => { (e.currentTarget as HTMLImageElement).replaceWith(Object.assign(document.createElement("p"), { className: "text-xs text-muted-foreground", textContent: "The picture is not in storage (deleted, or never saved)." })); }}
            />
          </a>
        )}
      </div>

      {req && (
        <div className="rounded-sm border border-border p-2 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">The request the engine received</p>
          <Row label="Started by"><Maker kind={req.actorKind} userId={req.actorUserId} email={req.actorEmail} /></Row>
          <Row label="Path">{PRODUCER_LABEL[req.producer] ?? req.producer}</Row>
          <Row label="Endpoint"><span className="font-mono">{req.endpointId}</span></Row>
          {req.vendorRequestId && <Row label="Vendor request id"><span className="font-mono">{req.vendorRequestId}</span></Row>}
          <Row label="Submitted">{when(req.createdAt)}</Row>
          {stageDiffers && <Row label="Submitted under"><CodeVersion commit={req.sourceCommit} at={req.sourceCommitAt} title={req.sourceCommitTitle} /></Row>}
          {prompt && <Row label="Prompt"><span className="whitespace-pre-wrap">{prompt}</span></Row>}
          <details>
            <summary className="text-xs text-muted-foreground cursor-pointer">Every setting sent</summary>
            <pre className="mt-1 text-[11px] font-mono bg-muted/30 border border-border rounded-sm p-2 overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(req.request, null, 2)}
            </pre>
          </details>
        </div>
      )}
      {!req && r.kind !== "upload" && r.snapshot?.["requestCaptured"] === false && (
        <p className="text-xs text-muted-foreground">The engine's request was sent before image tracing began, so it was not recorded.</p>
      )}

      {t.source && (
        <div className="rounded-sm border border-border p-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Made from</p>
          <Row label="Picture">{KIND_LABEL[t.source.kind] ?? t.source.kind} · record {t.source.id}</Row>
          <Row label="Made by"><Maker kind={t.source.actorKind} userId={t.source.actorUserId} email={t.source.actorEmail} /></Row>
          <Row label="Made">{when(t.source.createdAt)}</Row>
        </div>
      )}
    </div>
  );
}

export default function AdminTrace() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TraceResult | null>(null);
  const [traced, setTraced] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function run(request: () => Promise<Response>, label: string) {
    setLoading(true);
    setError(null);
    setResult(null);
    setTraced(label);
    try {
      const res = await request();
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `The trace failed (${res.status}).`);
      setResult(body as TraceResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The trace failed.");
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    void run(() => fetch(`/api/admin/provenance/trace?q=${encodeURIComponent(q)}`, { credentials: "include" }), q);
  }

  function traceFile(file: File | null | undefined) {
    if (!file) return;
    void run(
      () => fetch("/api/admin/provenance/trace-image", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      }),
      `the picture ${file.name || "pasted"}`,
    );
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    traceFile(e.dataTransfer.files?.[0]);
  }

  function onPaste(e: ClipboardEvent) {
    const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
    if (file) {
      e.preventDefault();
      traceFile(file);
    }
  }

  return (
    <AdminLayout title="Trace an image">
      <div className="max-w-5xl space-y-4">
        <p className="text-sm text-muted-foreground">
          Paste a record id, a meme link or an image link — or give the picture itself — to see how it was made.
        </p>
        <form onSubmit={onSubmit} onPaste={onPaste} className="flex gap-2">
          <div className="flex-1">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. 1234567890123 or https://overhype.me/m/abc123"
              aria-label="Record id or link"
              icon={<Search className="h-4 w-4" />}
            />
          </div>
          <Button type="submit" isLoading={loading} disabled={!query.trim()}>
            Trace
          </Button>
        </form>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex flex-wrap items-center gap-3 rounded-sm border border-dashed p-3 text-sm ${dragging ? "border-primary bg-primary/5" : "border-border"}`}
          data-testid="trace-picture-drop"
        >
          <Button type="button" variant="outline" onClick={() => fileInput.current?.click()} disabled={loading}>
            <ImageUp className="h-4 w-4 mr-1.5" />Trace a picture
          </Button>
          <span className="text-muted-foreground">
            or drop one here, or paste a screenshot. It is read by its stamp, its exact bytes and its invisible watermark, and is not stored.
          </span>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label="Picture to trace"
            onChange={(e) => { traceFile(e.target.files?.[0]); e.target.value = ""; }}
          />
        </div>

        {loading && traced && <p className="text-sm text-muted-foreground">Tracing {traced}…</p>}

        {error && (
          <p className="flex items-center gap-1.5 text-sm text-destructive"><AlertTriangle className="h-4 w-4" />{error}</p>
        )}

        {result && (
          <div className="space-y-3">
            {result.matches.length > 0 ? (
              <p className="text-sm text-foreground">
                Found by {METHOD_LABEL[result.method ?? ""] ?? "lookup"}:{" "}
                <span className="font-bold">{result.matches.length} record{result.matches.length === 1 ? "" : "s"}</span>
                {result.matches.length > 1 && <span className="text-muted-foreground"> — every match is shown; none is picked for you.</span>}
              </p>
            ) : (
              <div className="rounded-sm border border-border bg-background p-3 text-sm space-y-1">
                <p className="font-bold text-foreground">No record found.</p>
                {result.note && <p className="text-foreground">{result.note}</p>}
              </div>
            )}
            {result.matches.map((t) => <RecordCard key={t.record.id} t={t} />)}
            <details className="text-xs text-muted-foreground" open={result.method === null || ["metadata", "hash", "watermark"].includes(result.method)}>
              <summary className="cursor-pointer">What was tried</summary>
              <ul className="mt-1 list-disc pl-5">{result.tried.map((line) => <li key={line}>{line}</li>)}</ul>
            </details>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
