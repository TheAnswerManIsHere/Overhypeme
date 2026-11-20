/**
 * @purpose The Library's Submissions tab (plan PLAN_LIBRARY_SUBMISSIONS.md): everything the owner submitted for moderation, by type (Facts, Comments) and by status (Under Review, Approved & Live, Declined, No longer live), each with its true count, a plain line on what the status means, search, sort and paging; the view lives in the page address.
 * @subsystem public-site
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  getGetMySubmissionCountsQueryKey, getListMySubmissionsQueryKey, getMySubmissionCounts, listMySubmissions,
  type MySubmission, type MySubmissionCounts, type MySubmissionStatusCounts,
} from "@workspace/api-client-react";
import { REJECTION_REASON_LABELS, type RejectionReason } from "@workspace/api-zod";
import {
  AlertTriangle, ArrowDownUp, CheckCircle, Clock, EyeOff, FileText, MessageSquare, Search, X, XCircle,
} from "lucide-react";
import { FactCard } from "@/components/facts/FactCard";
import { useDebouncedValue } from "@/components/meme-builder/hooks/useDebouncedValue";
import { Button } from "@/components/ui/Button";
import { PausedWhenReadOnly } from "@/components/PausedWhenReadOnly";

export type SubmissionType = "facts" | "comments";
export type SubmissionStatus = "review" | "live" | "declined" | "gone";
type Sort = "newest" | "oldest";

const STATUS_ORDER: SubmissionStatus[] = ["review", "live", "declined", "gone"];

const STATUS_LABEL: Record<SubmissionStatus, string> = {
  review: "Under Review",
  live: "Approved & Live",
  declined: "Declined",
  gone: "No longer live",
};

const STATUS_ICON: Record<SubmissionStatus, React.ReactNode> = {
  review: <Clock className="w-4 h-4" />,
  live: <CheckCircle className="w-4 h-4" />,
  declined: <XCircle className="w-4 h-4" />,
  gone: <EyeOff className="w-4 h-4" />,
};

/** What each status means and what happens next, per type, in one plain line. */
const STATUS_HELP: Record<SubmissionType, Record<SubmissionStatus, string>> = {
  facts: {
    review: "A person on the team reads every fact before it goes live. These are still with them — we'll email you when there's a decision.",
    live: "Approved and live on Overhype.me. Anyone can find these, see them with their own name, and share them.",
    declined: "Not approved. The team's reason is on each card, and we emailed you the same when it was decided.",
    gone: "These were approved, then taken down by the team. They no longer appear anywhere on the site.",
  },
  comments: {
    review: "A person on the team reads every comment before it appears. Hidden comments were up, and are off the site while the team takes another look.",
    live: "Visible to everyone under the fact you commented on.",
    declined: "Not approved by the team, so they don't appear on the site — including any that were up and then hidden for another look. Where the team left a note, it's on the card.",
    gone: "Approved, but the fact they're on has since been taken down, so they no longer appear.",
  },
};

/** Brings a newly selected tab into its row's view (on a phone the row scrolls sideways). */
function scrollIntoRowOnce(el: HTMLElement | null) {
  el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

/** The opening status: the first that has anything in it, in the plan's order. */
export function openingStatus(counts: MySubmissionStatusCounts): SubmissionStatus {
  return STATUS_ORDER.find((s) => counts[s] > 0) ?? "review";
}

/** The view as the page address holds it; anything unrecognised reads as its default. */
function readView(search: string) {
  const p = new URLSearchParams(search);
  const type: SubmissionType = p.get("type") === "comments" ? "comments" : "facts";
  const rawStatus = p.get("status");
  const status = (STATUS_ORDER as string[]).includes(rawStatus ?? "") ? (rawStatus as SubmissionStatus) : null;
  const sort: Sort = p.get("sort") === "oldest" ? "oldest" : "newest";
  return { params: p, type, status, sort, q: (p.get("q") ?? "").slice(0, 100) };
}

function useSubmissionsView() {
  const search = useSearch();
  const [location, setLocation] = useLocation();
  const view = readView(search);
  /** Rewrites the address's view; a type or status change is a history entry, search and sort are not. */
  const update = (changes: Record<string, string | null>, push: boolean) => {
    const p = new URLSearchParams(search);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "") p.delete(k); else p.set(k, v);
    }
    const qs = p.toString();
    setLocation(`${location}${qs ? `?${qs}` : ""}`, { replace: !push });
  };
  return { ...view, update };
}

/** The counts for the Submissions tab: totals, and with `q`, matches. */
export function useSubmissionCounts(q: string, enabled = true) {
  const params = q ? { q } : undefined;
  return useQuery<MySubmissionCounts>({
    queryKey: getGetMySubmissionCountsQueryKey(params),
    queryFn: () => getMySubmissionCounts(params),
    enabled,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/** How many submissions there are altogether, across both types. */
export function submissionTotal(counts: MySubmissionCounts | undefined): number | null {
  return counts ? sumCounts(counts.totals.facts) + sumCounts(counts.totals.comments) : null;
}

function sumCounts(c: MySubmissionStatusCounts): number {
  return c.review + c.live + c.declined + c.gone;
}

export function SubmissionsPanel() {
  const view = useSubmissionsView();
  const { type, sort, q } = view;

  // The search box is typed into freely and written to the address shortly after.
  // It runs only when the typed term settles, so an address change made
  // elsewhere (Back, a type switch) is never written over by a stale term.
  const [draft, setDraft] = useState(q);
  useEffect(() => { setDraft(q); }, [q]);
  const settled = useDebouncedValue(draft.trim(), 300);
  useEffect(() => {
    if (settled !== q) view.update({ q: settled || null }, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);
  const clearSearch = () => { setDraft(""); view.update({ q: null }, false); };

  const counts = useSubmissionCounts(q);
  const totals = counts.data?.totals[type];
  const matches = q ? counts.data?.matches?.[type] : undefined;
  const status: SubmissionStatus | null = view.status ?? (totals ? openingStatus(totals) : null);
  const typeTotal = (t: SubmissionType) => {
    const c = counts.data?.totals[t];
    return c ? sumCounts(c) : null;
  };

  const visibleStatuses = STATUS_ORDER.filter((s) => s !== "gone" || (totals?.gone ?? 0) > 0 || status === "gone");

  return (
    <div className="space-y-6">
      {/* Type tabs */}
      <div role="tablist" aria-label="Submission type" className="flex gap-2 flex-wrap">
        {(["facts", "comments"] as const).map((t) => {
          const active = t === type;
          const n = typeTotal(t);
          return (
            <button
              key={t}
              role="tab"
              aria-selected={active}
              onClick={() => { if (!active) view.update({ type: t, status: null, q: null }, true); }}
              className={`flex items-center gap-2 px-4 py-2 rounded-sm border-2 font-display uppercase tracking-wider text-base transition-colors ${
                active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40"
              }`}
            >
              {t === "facts" ? <FileText className="w-4 h-4" /> : <MessageSquare className="w-4 h-4" />}
              {t === "facts" ? "Facts" : "Comments"}
              {n !== null && <span className="font-mono text-xs opacity-80">{n}</span>}
            </button>
          );
        })}
      </div>

      {/* Status tabs */}
      <div role="tablist" aria-label="Status" className="flex overflow-x-auto no-scrollbar gap-1 border-b border-border">
        {visibleStatuses.map((s) => {
          const active = s === status;
          const total = totals?.[s];
          const match = matches?.[s];
          return (
            <button
              key={s}
              ref={active && totals ? scrollIntoRowOnce : undefined}
              role="tab"
              aria-selected={active}
              onClick={() => { if (!active) view.update({ status: s }, true); }}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-bold uppercase tracking-wider whitespace-nowrap border-b-2 -mb-px transition-colors ${
                active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {STATUS_ICON[s]} {STATUS_LABEL[s]}
              {total !== undefined && (
                <span className="font-mono text-xs font-normal text-muted-foreground">
                  {match !== undefined ? `${match} of ${total}` : total}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Search and sort */}
      <div className="flex gap-2 items-center">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="search"
            value={draft}
            maxLength={100}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={type === "facts" ? "Search your facts or #hashtags" : "Search your comments"}
            aria-label={type === "facts" ? "Search your facts" : "Search your comments"}
            className="w-full bg-card border-2 border-border rounded-sm pl-9 pr-9 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
          />
          {draft && (
            <button
              aria-label="Clear search"
              onClick={clearSearch}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground shrink-0">
          <ArrowDownUp className="w-4 h-4" aria-hidden="true" />
          <span className="sr-only">Sort</span>
          <select
            value={sort}
            onChange={(e) => view.update({ sort: e.target.value === "oldest" ? "oldest" : null }, false)}
            className="bg-card border-2 border-border rounded-sm px-2 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
      </div>

      {counts.isError ? (
        <LoadError onRetry={() => void counts.refetch()} />
      ) : !status ? (
        // Only the opening status waits for the counts; one the address names loads at once.
        <ListSkeleton />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{STATUS_HELP[type][status]}</p>
          <SubmissionList
            type={type}
            status={status}
            q={q}
            sort={sort}
            typeIsEmpty={typeTotal(type) === 0}
            onClearSearch={clearSearch}
          />
        </>
      )}
    </div>
  );
}

function SubmissionList({ type, status, q, sort, typeIsEmpty, onClearSearch }: {
  type: SubmissionType; status: SubmissionStatus; q: string; sort: Sort; typeIsEmpty: boolean; onClearSearch: () => void;
}) {
  const base = { type, status, ...(q ? { q } : {}), ...(sort === "oldest" ? { sort } : {}) } as const;
  const list = useInfiniteQuery({
    queryKey: getListMySubmissionsQueryKey(base),
    queryFn: ({ pageParam }) => listMySubmissions({ ...base, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: "" as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  if (list.isError) return <LoadError onRetry={() => void list.refetch()} />;
  if (list.isLoading) return <ListSkeleton />;

  if (items.length === 0) {
    return <EmptyState type={type} status={status} q={q} typeIsEmpty={typeIsEmpty} onClearSearch={onClearSearch} />;
  }

  return (
    <div>
      <div className={type === "comments" ? "space-y-3" : "grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6"}>
        {items.map((item) => <SubmissionCard key={`${item.kind}:${item.id}`} item={item} status={status} />)}
      </div>
      {list.hasNextPage && (
        <div className="flex justify-center mt-6">
          <Button variant="outline" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
            {list.isFetchingNextPage ? "LOADING…" : "LOAD MORE"}
          </Button>
        </div>
      )}
    </div>
  );
}

function EmptyState({ type, status, q, typeIsEmpty, onClearSearch }: {
  type: SubmissionType; status: SubmissionStatus; q: string; typeIsEmpty: boolean; onClearSearch: () => void;
}) {
  let title: string;
  let detail: string | null = null;
  let action: React.ReactNode = null;

  if (q) {
    title = `Nothing here matches "${q}".`;
    detail = type === "facts"
      ? "Search looks at each fact's wording as you wrote it and its hashtags. Names and pronouns are filled in when a fact is shown, so they aren't searched."
      : "Search looks at the words of your comments.";
    action = <Button variant="outline" onClick={onClearSearch}>CLEAR SEARCH</Button>;
  } else if (typeIsEmpty && type === "facts") {
    title = "You haven't submitted any facts yet.";
    detail = "Write one about anyone — it reads with each visitor's own name.";
    action = <PausedWhenReadOnly><Link href="/submit"><Button>SUBMIT A FACT</Button></Link></PausedWhenReadOnly>;
  } else if (typeIsEmpty) {
    title = "You haven't commented on any facts yet.";
    detail = "Open any fact and add a comment under it.";
    action = <Link href="/"><Button variant="outline">BROWSE FACTS</Button></Link>;
  } else {
    const noun = type === "facts" ? "facts" : "comments";
    title = {
      review: `No ${noun} waiting for review.`,
      live: type === "facts" ? "None of your facts are live yet." : "None of your comments are showing yet.",
      declined: `No declined ${noun}.`,
      gone: `No ${noun} have been taken down.`,
    }[status];
    if (status === "review" && type === "facts") action = <PausedWhenReadOnly><Link href="/submit"><Button variant="outline">SUBMIT A FACT</Button></Link></PausedWhenReadOnly>;
  }

  return (
    <div className="text-center py-12 px-4 bg-card border-2 border-dashed border-border rounded-sm space-y-3">
      <p className="text-foreground text-lg font-medium">{title}</p>
      {detail && <p className="text-muted-foreground text-sm max-w-md mx-auto">{detail}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="text-center py-12 bg-card border-2 border-destructive/30 rounded-sm space-y-3">
      <AlertTriangle className="w-10 h-10 text-destructive/60 mx-auto" />
      <p className="text-muted-foreground font-medium">Couldn't load your submissions.</p>
      <Button variant="outline" onClick={onRetry}>TRY AGAIN</Button>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-32 bg-card border-2 border-border rounded-sm animate-pulse" />
      ))}
    </div>
  );
}

// ── Cards ──────────────────────────────────────────────────────────

const BADGE = {
  amber: "bg-amber-500/10 text-amber-400 border-amber-500/40",
  green: "bg-green-500/10 text-green-400 border-green-500/40",
  red: "bg-destructive/10 text-destructive border-destructive/40",
  muted: "bg-muted/40 text-muted-foreground border-border",
} as const;

function Badge({ tone, children }: { tone: keyof typeof BADGE; children: React.ReactNode }) {
  return (
    <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-sm border ${BADGE[tone]}`}>
      {children}
    </span>
  );
}

const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString() : null);

function reasonLabel(reason: string): string {
  return REJECTION_REASON_LABELS[reason as RejectionReason] ?? reason;
}

function Hashtags({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span key={tag} className="text-[10px] text-primary/70 font-bold uppercase tracking-wider">#{tag}</span>
      ))}
    </div>
  );
}

/** Two steps a fact under review moves through, shown without the team's internal step names. */
function Progress({ progress }: { progress: MySubmission["progress"] }) {
  const second = progress === "preparing";
  return (
    <div className="pt-2 border-t border-border/50 space-y-1.5">
      <div className="flex items-center gap-1.5" aria-hidden="true">
        <span className="h-1.5 flex-1 rounded-full bg-amber-400" />
        <span className={`h-1.5 flex-1 rounded-full ${second ? "bg-amber-400" : "bg-border"}`} />
        <span className="h-1.5 flex-1 rounded-full bg-border" />
      </div>
      <p className="text-xs text-muted-foreground">
        {second
          ? "Passed the first look — the team is preparing it to go live. It can still be declined."
          : "Waiting for a first look from the team."}
      </p>
    </div>
  );
}

/** One submission, drawn for the status list it is in: the list is its status. */
export function SubmissionCard({ item, status }: { item: MySubmission; status: SubmissionStatus }) {
  switch (item.kind) {
    case "fact":
      return item.fact ? <FactCard fact={item.fact} /> : null;
    case "review":
      return <ReviewCard item={item} declined={status === "declined"} />;
    case "fact_gone":
      return (
        <article className="bg-card border-2 border-border rounded-sm p-4 space-y-2 opacity-80">
          <div className="flex items-center justify-between gap-2">
            <Badge tone="muted">No longer live</Badge>
            <span className="font-mono text-xs text-muted-foreground">Approved {day(item.decidedAt)}</span>
          </div>
          <p className="text-foreground text-sm leading-relaxed">{item.text}</p>
          <Hashtags tags={item.hashtags} />
          <p className="text-xs text-muted-foreground border-t border-border/50 pt-2">
            Taken down by the team after it was approved, so it no longer appears on the site.
          </p>
        </article>
      );
    case "comment":
      return <CommentCard item={item} state={status === "review" && item.hidden ? "hidden" : status} />;
  }
}

function ReviewCard({ item, declined }: { item: MySubmission; declined: boolean }) {
  return (
    <article className={`bg-card border-2 rounded-sm p-4 space-y-2 ${declined ? "border-destructive/40" : "border-border"}`}>
      <div className="flex items-center justify-between gap-2">
        {declined ? <Badge tone="red">Declined</Badge> : <Badge tone="amber">Under review</Badge>}
        <span className="font-mono text-xs text-muted-foreground">
          {declined && item.decidedAt ? `Declined ${day(item.decidedAt)}` : `Sent ${day(item.createdAt)}`}
        </span>
      </div>
      <p className="text-foreground text-sm leading-relaxed">{item.text}</p>
      <Hashtags tags={item.hashtags} />
      {declined ? (
        (item.reason || item.teamNote) && (
          <div className="text-xs text-muted-foreground border-t border-border/50 pt-2 space-y-1">
            {item.reason && (
              <p><span className="font-bold text-destructive/80">Reason:</span> <span>{reasonLabel(item.reason)}</span></p>
            )}
            {item.teamNote && (
              <p className="whitespace-pre-line"><span className="font-bold text-destructive/80">Note from the team:</span> <span>{item.teamNote}</span></p>
            )}
          </div>
        )
      ) : (
        <Progress progress={item.progress} />
      )}
    </article>
  );
}

type CommentState = SubmissionStatus | "hidden";

function CommentCard({ item, state }: { item: MySubmission; state: CommentState }) {
  const badge = {
    review: <Badge tone="amber">Awaiting approval</Badge>,
    hidden: <Badge tone="amber">Hidden for another look</Badge>,
    live: <Badge tone="green">Visible</Badge>,
    declined: <Badge tone="red">Declined</Badge>,
    gone: <Badge tone="muted">Fact taken down</Badge>,
  }[state];

  return (
    <article className={`bg-card border-2 rounded-sm p-4 space-y-2 ${state === "declined" ? "border-destructive/40" : "border-border"}`}>
      {item.factText && (
        <p className="text-xs text-muted-foreground italic border-l-2 border-primary/40 pl-2 leading-relaxed line-clamp-2">
          {item.factText}
        </p>
      )}
      <p className="text-sm text-foreground leading-relaxed">{item.text}</p>
      {state === "declined" && item.teamNote && (
        <p className="text-xs text-muted-foreground whitespace-pre-line">
          <span className="font-bold text-destructive/80">Note from the team:</span> {item.teamNote}
        </p>
      )}
      <div className="flex items-center justify-between gap-2 pt-1">
        {badge}
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground">{day(item.createdAt)}</span>
          {item.factLive && item.factId !== null && (
            <Link href={`/facts/${item.factId}`} className="text-xs text-primary hover:underline">View fact →</Link>
          )}
        </div>
      </div>
    </article>
  );
}
