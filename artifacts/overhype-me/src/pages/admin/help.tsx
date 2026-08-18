import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { AdminLayout } from "@/components/admin/AdminLayout";
import { HELP_CHAPTERS, HELP_INDEX_DOC, findHelpDoc, type HelpDocMeta } from "@/generated/help/manifest";
import { loadHelpContent } from "@/generated/help/content";
import type { HelpSearchEntry } from "@/generated/help/searchIndex";
import { useFragmentScroll, currentHash } from "@/components/admin/useFragmentScroll";
import { searchHelp, type HelpSearchHit } from "@/components/admin/helpSearch";
import { internalHelpTarget, helpHref } from "@/components/admin/helpLinkGuard";
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

const ROUTER_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");


/**
 * Navigate to a help path + optional fragment through the router.
 *
 * Every in-app help link goes through here — generated anchors AND search
 * results — because the two diverging is exactly what broke same-chapter
 * navigation: wouter does not re-render on a hash-only change and its history
 * navigation emits no native `hashchange`, so a search hit into the chapter
 * already on screen moved nothing at all.
 *
 * `onHash` is called unconditionally rather than relying on the event, which
 * is what makes the same-chapter case work.
 */
function navigateToHelp(
  setLocation: (to: string) => void,
  path: string,
  fragment: string,
  onHash: (h: string) => void,
): void {
  const current = window.location.pathname.slice(ROUTER_BASE.length) || "/";
  const samePath = current === path;
  // One href builder for every navigation, so the address bar carries the same
  // percent-encoded form the generated anchors do — and the form `currentHash()`
  // decodes on the way back.
  const url = helpHref(ROUTER_BASE, { path, fragment });

  if (!samePath) {
    // A path change is the router's own history entry; adding the fragment
    // afterwards must not create a second one.
    setLocation(path);
    if (fragment || window.location.hash) window.history.replaceState({}, "", url);
  } else if (fragment !== currentHash()) {
    // Same path, different fragment: this is user-initiated navigation and
    // must be reversible. `replaceState` here overwrote the entry the reader
    // came from, so Back skipped past the previous section and left Help —
    // unlike an ordinary anchor, which is the behaviour being imitated.
    window.history.pushState({}, "", url);
  }
  onHash(fragment);
}

function ChapterNav({
  activeSlug,
  onNavigate,
}: {
  activeSlug: string | null;
  onNavigate: (path: string, fragment: string) => void;
}) {
  const go = (path: string) => (e: React.MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onNavigate(path, "");
  };
  return (
    <nav className="space-y-0.5" aria-label="Manual chapters">
      <a href={`${ROUTER_BASE}/admin/help`} onClick={go("/admin/help")} className="block no-underline">
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
      </a>
      {HELP_CHAPTERS.map((c) => (
        <a
          key={c.slug}
          href={`${ROUTER_BASE}/admin/help/${c.slug}`}
          onClick={go(`/admin/help/${c.slug}`)}
          className="block no-underline"
        >
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
        </a>
      ))}
    </nav>
  );
}

function SearchPanel({ onNavigate }: { onNavigate: (path: string, fragment: string) => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<HelpSearchEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [indexFailed, setIndexFailed] = useState(false);

  // The index is its own chunk, fetched the first time someone actually
  // searches — it is the single largest generated artifact, and most admin
  // visits to help never search at all.
  useEffect(() => {
    if (query.trim().length < 2 || index || loading || indexFailed) return;
    setLoading(true);
    void import("@/generated/help/searchIndex")
      .then((m) => setIndex(m.HELP_SEARCH_INDEX))
      // A chunk can genuinely fail to load — most commonly an open tab whose
      // chunks a deploy has replaced. Without a terminal state the guard above
      // is satisfied again on the next keystroke and this re-imports forever.
      .catch(() => setIndexFailed(true))
      .finally(() => setLoading(false));
  }, [query, index, loading, indexFailed]);

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
          {indexFailed && (
            <p className="text-sm text-muted-foreground px-1">
              Search is unavailable — reload the page to try again. Chapters below still work.
            </p>
          )}
          {index && !indexFailed && hits.length === 0 && (
            <p className="text-sm text-muted-foreground px-1">No matches for “{query.trim()}”.</p>
          )}
          {hits.map((hit, i) => (
            <a
              key={`${hit.doc}-${hit.section}-${i}`}
              href={`${ROUTER_BASE}/admin/help/${hit.doc}#${hit.section}`}
              onClick={(e) => {
                if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                onNavigate(`/admin/help/${hit.doc}`, hit.section);
              }}
              className="block no-underline"
            >
              <div className="rounded-sm border border-border bg-card px-3 py-2 cursor-pointer hover:border-primary/60 transition-colors">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="text-sm font-semibold text-foreground truncate">{hit.sectionTitle}</span>
                  <span className="text-[11px] text-muted-foreground truncate shrink-0">{hit.docTitle}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{hit.snippet}</p>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function NotFound({ slug, onNavigate }: { slug: string; onNavigate: (path: string, fragment: string) => void }) {
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
      <a
        href={`${ROUTER_BASE}/admin/help`}
        onClick={(e) => {
          if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          onNavigate("/admin/help", "");
        }}
        className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
      >
        <ChevronLeft className="w-4 h-4" /> Back to the manual
      </a>
    </div>
  );
}

function DocView({
  doc,
  navHash,
  onNavigate,
}: {
  doc: HelpDocMeta;
  /** Fragment set by an in-app navigation, which emits no `hashchange`. */
  navHash: { value: string; nonce: number } | null;
  onNavigate: (path: string, fragment: string) => void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [hash, setHash] = useState(currentHash());
  const [location] = useLocation();
  const bodyRef = useRef<HTMLDivElement>(null);

  // Wouter does not re-render on hash-only changes, and an in-page anchor
  // click is exactly that — so track it directly.
  useEffect(() => {
    const sync = () => setHash(currentHash());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [location]);

  // An in-app navigation sets the fragment directly, because neither wouter
  // nor history.replaceState fires `hashchange`.
  useEffect(() => {
    if (navHash !== null) setHash(navHash.value);
  }, [navHash]);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setLoadFailed(false);
    void loadHelpContent(doc.slug)
      ?.then((m) => { if (!cancelled) setHtml(m.html); })
      // Same production condition as the search index: an open tab whose
      // chunks a deploy replaced. Without this the page sits on "Loading…"
      // forever and the rejection never reaches an error boundary.
      .catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => {
      cancelled = true;
    };
  }, [doc.slug]);

  // Scoped to the rendered prose: every fragment this page can produce targets
  // a generated heading inside it, so resolving them against `document` could
  // only ever find something that is NOT the intended anchor.
  useFragmentScroll(hash, html !== null, bodyRef);

  /**
   * Generated in-app links are plain `<a data-help-internal>` inside injected
   * HTML, so wouter never sees them. Two consequences, both fixed here:
   * the href must carry the router base (`import.meta.env.BASE_URL`), and the
   * click must navigate through the router rather than reloading the document.
   */
  useEffect(() => {
    if (html === null || !ROUTER_BASE) return;
    for (const a of bodyRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-help-internal]") ?? []) {
      // The UNBASED path comes from the data attribute, never from parsing the
      // href. Inferring "already prefixed?" from the href breaks whenever the
      // deployment base is itself a prefix of the route — with BASE_PATH=/admin
      // every href already starts with `/admin/`, so the guard skipped it and
      // the click handler then stripped a base that was never added.
      const target = internalHelpTarget(a);
      // Built from a validated ASCII path plus a percent-encoded fragment —
      // never by concatenating the raw attribute onto the base.
      if (target) a.setAttribute("href", helpHref(ROUTER_BASE, target));
    }
  }, [html]);

  const onBodyClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Leave modified clicks alone — cmd/ctrl/shift/middle all mean "not here".
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const anchor = (e.target as HTMLElement).closest?.("a[data-help-internal]") as HTMLAnchorElement | null;
    if (!anchor) return;
    // Read the UNBASED path from the attribute; never re-derive it from href.
    // Same validation as the href write above — one helper, so the two cannot
    // drift apart the way this file's earlier paired checks did.
    const target = internalHelpTarget(anchor);
    if (!target) return;
    e.preventDefault();
    onNavigate(target.path, target.fragment);
  }, [onNavigate]);

  return (
    <article className={CONTENT_WRAP}>
      {loadFailed ? (
        <p className="text-sm text-muted-foreground" data-testid="help-chapter-failed">
          This chapter could not be loaded — reload the page to try again.
        </p>
      ) : html === null ? (
        <div aria-busy="true" className="text-sm text-muted-foreground">
          Loading…
        </div>
      ) : (
        <>
          {/* Generated at build time from docs/manual/, with raw HTML dropped
              and the output asserted free of executable content. */}
          <div ref={bodyRef} className={PROSE} onClick={onBodyClick} dangerouslySetInnerHTML={{ __html: html }} />
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
  const [, setLocation] = useLocation();
  const slug = params?.chapter ?? "";
  const doc = findHelpDoc(slug);
  const [navHash, setNavHash] = useState<{ value: string; nonce: number } | null>(null);

  const goToHelp = useCallback(
    (path: string, fragment: string) =>
      // Stamped, so re-clicking the SAME result still re-scrolls — a bare
      // string would compare equal and the effect would never re-fire.
      navigateToHelp(setLocation, path, fragment, (value) =>
        setNavHash((prev) => ({ value, nonce: (prev?.nonce ?? 0) + 1 })),
      ),
    [setLocation],
  );

  return (
    <AdminLayout title="Help">
      <div className="space-y-4">
        {/* One search surface for every breakpoint. Rendering it twice gave two
            independent query states and two elements sharing one test id. */}
        <div className="max-w-xl">
          <SearchPanel onNavigate={goToHelp} />
        </div>

        <div className="flex gap-6 items-start">
          <aside className="hidden lg:block w-64 shrink-0 sticky top-0">
            <ChapterNav activeSlug={doc ? slug : null} onNavigate={goToHelp} />
          </aside>

          <div className="flex-1 min-w-0">
            <details className="lg:hidden mb-4 rounded-sm border border-border bg-card">
              <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-foreground">
                All chapters
              </summary>
              <div className="p-2 pt-0">
                <ChapterNav activeSlug={doc ? slug : null} onNavigate={goToHelp} />
              </div>
            </details>

            {doc ? <DocView doc={doc} navHash={navHash} onNavigate={goToHelp} /> : <NotFound slug={slug} onNavigate={goToHelp} />}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
