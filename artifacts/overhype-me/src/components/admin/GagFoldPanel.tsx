/**
 * @purpose The fold and cast fill on Taxonomy Health: what a run would do (the dry run), the button that starts one, its progress, and the two lists that must be empty before pictures switch to the direct path.
 * @subsystem visual-pipeline
 *
 * Plan docs/plans/PLAN_GAG_DIRECT_RENDER.md, E. The report is read from the
 * gags as they are now, so it is the dry run until Run is pressed, and a
 * moderator's edit to a listed gag clears it from the list by itself.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { Layers, Loader2, Play, RefreshCw } from "lucide-react";
import type { GagFoldReport, GagFoldStartResponse, GagFoldVersionReport } from "@workspace/api-zod";
import { Button } from "@/components/ui/Button";

const FOLD_LABEL: Record<keyof GagFoldReport["fold"], string> = {
  would_convert: "Would fold",
  listed: "Listed for a moderator",
  already_converted: "Folded",
  nothing: "Nothing to fold",
};
const CAST_LABEL: Record<keyof GagFoldReport["cast"], string> = {
  extracted: "Cast read",
  missing: "Cast not read",
  stale: "Cast out of date",
  failed: "Cast failed",
};

export function GagFoldPanel() {
  const [report, setReport] = useState<GagFoldReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState<GagFoldStartResponse | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/gag-fold", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as Partial<GagFoldReport> | null;
      if (!data || typeof data.fold !== "object" || typeof data.cast !== "object" || !Array.isArray(data.forModerator) || !Array.isArray(data.castMissing)) {
        throw new Error("unexpected answer");
      }
      setReport(data as GagFoldReport);
      setError(null);
    } catch (e) {
      setError(`Could not read the fold's report (${e instanceof Error ? e.message : String(e)}).`);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // While jobs are queued or running, read the report again every few seconds.
  const busy = (report?.jobs.queued ?? 0) + (report?.jobs.running ?? 0) > 0;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(t);
  }, [busy, load]);

  const run = async () => {
    setStarting(true);
    try {
      const r = await fetch("/api/admin/gag-fold/run", { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStarted((await r.json()) as GagFoldStartResponse);
      await load();
    } catch (e) {
      setError(`Could not start the fold (${e instanceof Error ? e.message : String(e)}).`);
    } finally {
      setStarting(false);
    }
  };

  const work = report ? report.fold.would_convert + report.cast.missing + report.cast.stale + report.cast.failed : 0;

  return (
    <section className="rounded-sm border border-border p-3 space-y-3" data-testid="gag-fold-panel">
      <div className="flex items-center gap-2 flex-wrap">
        <Layers className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-bold">Gag fold and cast fill</h3>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          <RefreshCw className="w-3 h-3 mr-1" /> Refresh
        </Button>
        <Button size="sm" onClick={() => void run()} disabled={starting || busy || !report || work === 0} data-testid="gag-fold-run">
          {starting || busy ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Play className="w-3 h-3 mr-1" />}
          {busy ? "Running…" : `Run on ${work} version${work === 1 ? "" : "s"}`}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Moves what is typed in each gag's old "More art direction" fields into its scene, and reads who is in every gag's
        scene (its cast). Until you press Run, the counts below are what a run would do; nothing has been changed. A run
        costs one small AI call per version with work. The original of every folded version is kept, so a fold can be
        undone. Both lists below must be empty before pictures can switch to being drawn straight from the gag.
      </p>
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      {started && (
        <p className="text-xs text-muted-foreground" data-testid="gag-fold-started">
          Started: {started.queued} queued{started.deduped ? `, ${started.deduped} already queued` : ""}.
        </p>
      )}
      {report && (
        <>
          <div className="flex flex-wrap gap-2 text-xs" data-testid="gag-fold-counts">
            <Count label="Gag versions" value={report.versions} />
            {(Object.keys(FOLD_LABEL) as Array<keyof typeof FOLD_LABEL>).map((k) => <Count key={k} label={FOLD_LABEL[k]} value={report.fold[k]} />)}
            {(Object.keys(CAST_LABEL) as Array<keyof typeof CAST_LABEL>).map((k) => <Count key={k} label={CAST_LABEL[k]} value={report.cast[k]} />)}
            {busy && <Count label="Jobs queued · running" value={`${report.jobs.queued} · ${report.jobs.running}`} />}
          </div>
          <VersionList
            title="Listed for a moderator"
            empty="Nothing listed: every version the fold reaches can be folded."
            help="The fold leaves these alone because converting them would change what the picture shows. A scene that would be too long clears when you shorten the gag's scene, save, and approve its test renders. An old violence, supporting-text or depiction setting cannot be removed from this screen (none existed when the fold was built): report the gag so it is converted before pictures switch to the direct path."
            rows={report.forModerator}
            testId="gag-fold-for-moderator"
          />
          <VersionList
            title="No cast yet"
            empty="Every version has a cast read from its scene."
            help="A run reads these. One that stays here after a run needs its scene to show who speaks in its bubbles."
            rows={report.castMissing}
            testId="gag-fold-cast-missing"
          />
        </>
      )}
    </section>
  );
}

function Count({ label, value }: { label: string; value: number | string }) {
  return (
    <span className="rounded-sm border border-border bg-muted/20 px-2 py-1">
      <span className="text-muted-foreground">{label}</span> <span className="font-bold text-foreground">{value}</span>
    </span>
  );
}

function VersionList({ title, empty, help, rows, testId }: { title: string; empty: string; help: string; rows: GagFoldVersionReport[]; testId: string }) {
  return (
    <div className="space-y-1" data-testid={testId}>
      <p className="text-xs font-bold text-foreground">{title} ({rows.length})</p>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{help}</p>
          <ul className="space-y-1">
            {rows.map((r) => (
              <li key={`${r.gagId}:${r.stage}`} className="text-xs rounded-sm border border-border p-2">
                <Link href={`/admin/facts?focus=${r.factId}`} className="text-primary hover:underline">
                  Fact #{r.factId} · gag {r.slot} · {r.stage === "approved" ? "approved version" : "pending change"}
                </Link>
                {r.job && (r.job.status === "pending" || r.job.status === "processing") && (
                  <span className="ml-2 text-muted-foreground">({r.job.status === "pending" ? "queued" : "running"})</span>
                )}
                <ul className="list-disc ml-4 text-muted-foreground">
                  {r.reasons.map((why) => <li key={why}>{why}</li>)}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
