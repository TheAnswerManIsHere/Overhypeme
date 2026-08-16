import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { HELP_CHAPTERS, HELP_INDEX_DOC, findHelpDoc, type HelpDocMeta } from "@/generated/help/manifest";
import { loadHelpContent } from "@/generated/help/content";
import type { HelpSearchEntry } from "@/generated/help/searchIndex";
import { useFragmentScroll, currentHash } from "@/components/admin/useFragmentScroll";
import { searchHelp, type HelpSearchHit } from "@/components/admin/helpSearch";
import { BookOpen, ExternalLink, Search, ChevronLeft, FileQuestion } from "lucide-react";

/**
 * Styling for generated Manual HTML. Written explicitly rather than via
 * @tailwindcss/typography, which is a devDependency but is not wired into
 * index.css — adding the plugin would be scope this build did not agree.
 */
const PROSE = [
  "max-w-3xl text-[15px] leading-relaxed text-foreground/90",
  "[&_h1]:font-display [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:uppercase [&_h1]:tracking-wide [&_h1]:text-foreground [&_h1]:mb-6",
  "[&_h2]:font-display [&_h2]:text-xl [&_h2]:font-bold [&_h2]:uppercase [&_h2]:tracking-wide [&_h2]:text-foreground [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:scroll-mt-6",
  "[&_h3]:font-semibold [&_h3]:text-base [&_h3]:text-foreground [&_h3]:mt-7 [&_h3]:mb-2 [&_h3]:scroll-mt-6",
  "[&_h4]:font-semibold [&_h4]:text-sm [&_h4]:text-foreground [&_h4]:mt-5 [&_h4]:mb-2 [&_h4]:scroll-mt-6",
  "[&_p]:my-3",
  "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1.5",
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-primary/80",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px]",
  "[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-sm [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted [&_pre]:p-4",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/60 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground",
  "[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm",
  "[&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold",
  "[&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:align-top",
  "[&_hr]:my-8 [&_hr]:border-border",
  "[&_strong]:font-semibold [&_strong]:text-foreground",
].join(" ");

/** Wide content (tables, code) must scroll inside itself, never the page. */
const CONTENT_WRAP = "min-w-0 overflow-x-auto";

function ChapterNav({ activeSlug }: { activeSlug: string | null }) {
  return (
    <nav className="space-y-0.5" aria-label="Manual chapters">
      <Link href="/admin/help">
        <div
          className={`flex items-center gap-2 rounded-sm px-3 py-2 text-sm cursor-pointer transition-colors ${
            activeSlug === ""
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
          }`}
        >
          <BookOpen className="w-4 h-4 shrink-0" />
          <span className="truncate">{HELP_INDEX_DOC.title}</span>
        </div>
      </Link>
      {HELP_CHAPTERS.map((c) => (
        <Link key={c.slug} href={`/admin/help/${c.slug}`}>
          <div
            className={`flex items-start gap-2 rounded-sm px-3 py-2 text-sm cursor-pointer transition-colors ${
              activeSlug === c.slug
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
          >
            <span className="font-mono text-[11px] opacity-70 pt-0.5 w-5 shrink-0">{c.number}</span>
            <span className="min-w-0">{c.title}</span>
          </div>
        </Link>
      ))}
    </nav>
  );
}

function SearchPanel() {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<HelpSearchEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  // The index is its own chunk, fetched the first time someone actually
  // searches — it is the single largest generated artifact, and most admin
  // visits to help never search at all.
  useEffect(() => {
    if (query.trim().length < 2 || index || loading) return;
    setLoading(true);
    void import("@/generated/help/searchIndex")
      .then((m) => setIndex(m.HELP_SEARCH_INDEX))
      .finally(() => setLoading(false));
  }, [query, index, loading]);

  const titleFor = useCallback((slug: string) => findHelpDoc(slug)?.title ?? slug, []);
  const hits: HelpSearchHit[] = useMemo(
    () => (index ? searchHelp(index, query, titleFor) : []),
    [index, query, titleFor],
  );

  const searching = query.trim().length >= 2;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the manual…"
          aria-label="Search the manual"
          data-testid="help-search-input"
          className="w-full rounded-sm border border-border bg-card pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      {searching && (
        <div data-testid="help-search-results" className="space-y-1">
          {loading && !index && <p className="text-sm text-muted-foreground px-1">Loading the index…</p>}
          {index && hits.length === 0 && (
            <p className="text-sm text-muted-foreground px-1">No matches for “{query.trim()}”.</p>
          )}
          {hits.map((hit, i) => (
            <Link key={`${hit.doc}-${hit.section}-${i}`} href={`/admin/help/${hit.doc}#${hit.section}`}>
              <div className="rounded-sm border border-border bg-card px-3 py-2 cursor-pointer hover:border-primary/60 transition-colors">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="text-sm font-semibold text-foreground truncate">{hit.sectionTitle}</span>
                  <span className="text-[11px] text-muted-foreground truncate shrink-0">{hit.docTitle}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{hit.snippet}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function NotFound({ slug }: { slug: string }) {
  return (
    <div className="max-w-xl space-y-4" data-testid="help-not-found">
      <FileQuestion className="w-12 h-12 text-muted-foreground" />
      <h2 className="font-display text-2xl font-bold uppercase tracking-wide text-foreground">
        No such chapter
      </h2>
      <p className="text-sm text-muted-foreground">
        There is no manual chapter called{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{slug}</code>. It may have
        been renamed or renumbered since this link was saved.
      </p>
      <Link href="/admin/help">
        <span className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline cursor-pointer">
          <ChevronLeft className="w-4 h-4" /> Back to the manual
        </span>
      </Link>
    </div>
  );
}

function DocView({ doc }: { doc: HelpDocMeta }) {
  const [html, setHtml] = useState<string | null>(null);
  const [hash, setHash] = useState(currentHash());
  const [location] = useLocation();

  // Wouter does not re-render on hash-only changes, and an in-page anchor
  // click is exactly that — so track it directly.
  useEffect(() => {
    const sync = () => setHash(currentHash());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [location]);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    void loadHelpContent(doc.slug)?.then((m) => {
      if (!cancelled) setHtml(m.html);
    });
    return () => {
      cancelled = true;
    };
  }, [doc.slug]);

  useFragmentScroll(hash, html !== null);

  return (
    <article className={CONTENT_WRAP}>
      <div id="admin-help-top" />
      {html === null ? (
        <div aria-busy="true" className="text-sm text-muted-foreground">
          Loading…
        </div>
      ) : (
        <>
          {/* Generated at build time from docs/manual/, with raw HTML dropped
              and the output asserted free of executable content. */}
          <div className={PROSE} dangerouslySetInnerHTML={{ __html: html }} />
          <div className="mt-10 pt-4 border-t border-border">
            <a
              href={doc.githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Edit this chapter on GitHub — <code className="font-mono">{doc.file}</code>
            </a>
          </div>
        </>
      )}
    </article>
  );
}

export default function AdminHelp() {
  const [, params] = useRoute("/admin/help/:chapter");
  const slug = params?.chapter ?? "";
  const doc = findHelpDoc(slug);

  return (
    <AdminLayout title="Help">
      <div className="space-y-4">
        {/* One search surface for every breakpoint. Rendering it twice gave two
            independent query states and two elements sharing one test id. */}
        <div className="max-w-xl">
          <SearchPanel />
        </div>

        <div className="flex gap-6 items-start">
          <aside className="hidden lg:block w-64 shrink-0 sticky top-0">
            <ChapterNav activeSlug={doc ? slug : null} />
          </aside>

          <div className="flex-1 min-w-0">
            <details className="lg:hidden mb-4 rounded-sm border border-border bg-card">
              <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-foreground">
                All chapters
              </summary>
              <div className="p-2 pt-0">
                <ChapterNav activeSlug={doc ? slug : null} />
              </div>
            </details>

            {doc ? <DocView doc={doc} /> : <NotFound slug={slug} />}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
