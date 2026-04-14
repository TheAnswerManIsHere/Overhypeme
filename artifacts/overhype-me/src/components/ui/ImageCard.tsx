import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "wouter";
import {
  Trash2,
  Link2,
  Maximize2,
  CheckCircle2,
  ChevronDown,
  Loader2,
  ShoppingBag,
} from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// Spring entrance animation injected once per menu render (idempotent)
const GLASSMORPHIC_KEYFRAMES = `
  @keyframes kebabSlideIn {
    from { opacity: 0; transform: scale(0.92) translateY(-4px); }
    to   { opacity: 1; transform: scale(1)    translateY(0);    }
  }
`;

type ActionType = "delete" | "copyLink" | "openFull" | "makeMerch";

export interface ImageCardProps {
  src: string;
  alt?: string;
  isAuthProtected?: boolean;
  aspectRatio?: string;
  href?: string;
  onSelect?: () => void;
  selected?: boolean;
  compact?: boolean;
  actions?: ActionType[];
  onDelete?: () => Promise<void> | void;
  /** @deprecated Use zazzleUrl instead — plain <a> link avoids popup blockers on Safari/iOS */
  onMakeMerch?: () => void;
  /** Direct Zazzle redirect URL. When provided, "Make Merch" renders as a real link (no popup blocker issues). */
  zazzleUrl?: string;
  deleteConfirmMessage?: string;
  permalink?: string;
  footer?: ReactNode;
  imageOverlay?: ReactNode;
  className?: string;
}

function useBlobSrc(src: string, isAuthProtected: boolean) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isAuthProtected || !src) { setBlobUrl(null); return; }
    let url: string | null = null;
    fetch(src, { credentials: "include" })
      .then(r => r.ok ? r.blob() : null)
      .then(blob => { if (blob) { url = URL.createObjectURL(blob); setBlobUrl(url); } })
      .catch(() => {});
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [src, isAuthProtected]);
  return isAuthProtected ? blobUrl : src;
}

function useClickOutside(ref: React.RefObject<HTMLElement | null>, handler: () => void) {
  useEffect(() => {
    const listener = (e: MouseEvent | TouchEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      handler();
    };
    document.addEventListener("mousedown", listener);
    document.addEventListener("touchstart", listener);
    return () => {
      document.removeEventListener("mousedown", listener);
      document.removeEventListener("touchstart", listener);
    };
  }, [ref, handler]);
}

// ─── Action Menu ───────────────────────────────────────────────────────────

interface ActionMenuProps {
  actions: ActionType[];
  onDeleteConfirm?: () => Promise<void> | void;
  onDeleteRequest?: () => void;
  onCopy?: () => void;
  onOpenFull?: () => void;
  onMakeMerch?: () => void;
  zazzleUrl?: string;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

function ActionMenu({
  actions,
  onDeleteConfirm,
  onDeleteRequest,
  onCopy,
  onOpenFull,
  onMakeMerch,
  zazzleUrl,
  onClose,
  anchorRef,
}: ActionMenuProps) {
  const isMobile = useIsMobile();
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useClickOutside(menuRef as React.RefObject<HTMLElement | null>, onClose);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmDelete) { setConfirmDelete(false); return; }
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, confirmDelete]);

  // ── Mobile bottom sheet ──────────────────────────────────────────────────
  if (isMobile) {
    const mobileItems = [
      actions.includes("openFull") && onOpenFull && {
        icon: <Maximize2 className="w-4 h-4" />,
        label: "Open Full Resolution",
        action: onOpenFull,
        href: undefined as string | undefined,
      },
      actions.includes("copyLink") && onCopy && {
        icon: <Link2 className="w-4 h-4" />,
        label: "Copy Link",
        action: onCopy,
        href: undefined as string | undefined,
      },
      actions.includes("makeMerch") && (zazzleUrl ?? onMakeMerch) && {
        icon: <ShoppingBag className="w-4 h-4" />,
        label: "Make Merch on Zazzle",
        action: onMakeMerch ?? (() => {}),
        href: zazzleUrl,
      },
      actions.includes("delete") && (onDeleteRequest ?? onDeleteConfirm) && {
        icon: <Trash2 className="w-4 h-4 text-red-400" />,
        label: <span className="text-red-400">Delete</span>,
        action: onDeleteRequest ?? (() => { void onDeleteConfirm?.(); }),
        href: undefined as string | undefined,
      },
    ].filter(Boolean) as { icon: ReactNode; label: ReactNode; action: () => void; href?: string }[];

    return createPortal(
      <div className="fixed inset-0 z-[9998] flex items-end" onClick={onClose}>
        <div className="absolute inset-0 bg-black/40" />
        <div
          ref={menuRef}
          className="relative w-full bg-card border-t-2 border-border rounded-t-xl pb-safe animate-in slide-in-from-bottom duration-200"
          onClick={e => e.stopPropagation()}
          role="menu"
        >
          <div className="flex justify-center pt-2.5 pb-1">
            <div className="w-10 h-1 bg-muted-foreground/30 rounded-full" />
          </div>
          {mobileItems.map((item, i) =>
            item.href ? (
              <a
                key={i}
                role="menuitem"
                href={item.href}
                target="_blank"
                rel="noreferrer"
                onClick={onClose}
                className="flex items-center gap-4 w-full px-6 py-4 text-left text-sm font-medium hover:bg-accent transition-colors"
              >
                {item.icon}
                {item.label}
              </a>
            ) : (
              <button
                key={i}
                role="menuitem"
                onClick={() => { item.action(); onClose(); }}
                className="flex items-center gap-4 w-full px-6 py-4 text-left text-sm font-medium hover:bg-accent transition-colors"
              >
                {item.icon}
                {item.label}
              </button>
            )
          )}
          <button
            role="menuitem"
            onClick={onClose}
            className="flex items-center justify-center w-full px-6 py-4 text-sm font-semibold text-muted-foreground border-t border-border hover:bg-accent transition-colors"
          >
            <ChevronDown className="w-4 h-4 mr-2" /> Cancel
          </button>
        </div>
      </div>,
      document.body
    );
  }

  // ── Desktop glassmorphic dropdown ────────────────────────────────────────
  const position = (() => {
    if (!anchorRef.current) return {};
    const rect = anchorRef.current.getBoundingClientRect();
    return {
      top: rect.bottom + 6,
      right: window.innerWidth - rect.right,
    };
  })();

  async function handleDeleteClick() {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    if (!onDeleteConfirm) return;
    setDeleting(true);
    try { await onDeleteConfirm(); onClose(); }
    catch { /* toast handled upstream */ }
    finally { setDeleting(false); setConfirmDelete(false); }
  }

  const desktopItems: Array<{
    key: string;
    icon: ReactNode;
    label: string;
    kbd?: string;
    action: () => void;
    href?: string;
  }> = [];

  if (actions.includes("openFull") && onOpenFull) {
    desktopItems.push({
      key: "openFull",
      icon: <Maximize2 size={15} />,
      label: "Open Full Resolution",
      action: () => { onOpenFull(); onClose(); },
    });
  }
  if (actions.includes("copyLink") && onCopy) {
    desktopItems.push({
      key: "copy",
      icon: <Link2 size={15} />,
      label: "Copy Link",
      kbd: "⌘C",
      action: () => { onCopy(); onClose(); },
    });
  }
  if (actions.includes("makeMerch") && (zazzleUrl ?? onMakeMerch)) {
    desktopItems.push({
      key: "makeMerch",
      icon: <ShoppingBag size={15} />,
      label: "Make Merch on Zazzle",
      action: () => { onMakeMerch?.(); onClose(); },
      href: zazzleUrl,
    });
  }

  const hasDelete = actions.includes("delete") && !!onDeleteConfirm;

  return createPortal(
    <>
      <style dangerouslySetInnerHTML={{ __html: GLASSMORPHIC_KEYFRAMES }} />
      <div
        ref={menuRef}
        role="menu"
        className="fixed z-[9998] min-w-[200px]"
        style={{
          ...position,
          background: "rgba(18, 18, 22, 0.92)",
          backdropFilter: "blur(24px) saturate(1.4)",
          WebkitBackdropFilter: "blur(24px) saturate(1.4)",
          border: "1px solid rgba(255, 255, 255, 0.08)",
          borderRadius: 12,
          padding: "4px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3)",
          animation: "kebabSlideIn 0.18s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        {/* Non-destructive actions */}
        {desktopItems.map(item => {
          const itemStyle = {
            display: "flex",
            alignItems: "center",
            gap: 10,
            width: "100%",
            padding: "8px 12px",
            border: "none",
            borderRadius: 8,
            background: "transparent",
            color: "rgba(255, 255, 255, 0.92)",
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
            transition: "background 0.15s ease",
            textAlign: "left" as const,
            outline: "none",
            textDecoration: "none",
          };
          const innerContent = (
            <>
              <span style={{ color: "rgba(255,255,255,0.5)", flexShrink: 0, display: "flex" }}>
                {item.icon}
              </span>
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.kbd && (
                <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontFamily: "monospace", letterSpacing: "0.05em" }}>
                  {item.kbd}
                </span>
              )}
            </>
          );
          return item.href ? (
            <a
              key={item.key}
              role="menuitem"
              href={item.href}
              target="_blank"
              rel="noreferrer"
              onClick={e => { e.stopPropagation(); onClose(); }}
              style={itemStyle}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
            >
              {innerContent}
            </a>
          ) : (
            <button
              key={item.key}
              role="menuitem"
              onClick={e => { e.stopPropagation(); item.action(); }}
              style={itemStyle}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
            >
              {innerContent}
            </button>
          );
        })}

        {/* Divider */}
        {hasDelete && desktopItems.length > 0 && (
          <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "4px 8px" }} />
        )}

        {/* Delete — two-step inline confirm */}
        {hasDelete && (
          <button
            role="menuitem"
            onClick={e => { e.stopPropagation(); void handleDeleteClick(); }}
            disabled={deleting}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              padding: "8px 12px",
              border: "none",
              borderRadius: 8,
              background: confirmDelete ? "rgba(255,71,87,0.15)" : "transparent",
              color: "#ff4757",
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
              transition: "all 0.15s ease",
              textAlign: "left",
              outline: "none",
            }}
            onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,71,87,0.12)"; }}
            onMouseLeave={e => {
              e.currentTarget.style.background = confirmDelete ? "rgba(255,71,87,0.15)" : "transparent";
            }}
          >
            <span style={{ display: "flex", flexShrink: 0 }}>
              {deleting
                ? <Loader2 size={15} className="animate-spin" />
                : <Trash2 size={15} />}
            </span>
            <span>{confirmDelete ? "Confirm Delete" : "Delete"}</span>
          </button>
        )}

        {/* Inline cancel for delete confirm */}
        {confirmDelete && (
          <button
            onClick={e => { e.stopPropagation(); setConfirmDelete(false); }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "100%",
              padding: "5px 12px",
              border: "none",
              borderRadius: 8,
              background: "transparent",
              color: "rgba(255,255,255,0.38)",
              fontSize: 11,
              cursor: "pointer",
              transition: "background 0.15s ease",
              outline: "none",
            }}
            onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
          >
            Cancel
          </button>
        )}
      </div>
    </>,
    document.body
  );
}

// ─── ImageCard ─────────────────────────────────────────────────────────────

export function ImageCard({
  src,
  alt,
  isAuthProtected = false,
  aspectRatio = "aspect-square",
  href,
  onSelect,
  selected = false,
  compact = false,
  actions = ["delete", "copyLink", "openFull"],
  onDelete,
  onMakeMerch,
  zazzleUrl,
  deleteConfirmMessage = "Permanently delete this image? This cannot be undone.",
  permalink,
  footer,
  imageOverlay,
  className,
}: ImageCardProps) {
  const displaySrc = useBlobSrc(src, isAuthProtected);
  const isMobile = useIsMobile();
  const { toast } = useToast();

  const [menuOpen, setMenuOpen] = useState(false);
  // confirmingDelete drives the card overlay: compact mini overlay always; non-compact only on mobile
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const kebabRef = useRef<HTMLButtonElement>(null);

  const openLightbox = useCallback(() => {
    const target = displaySrc ?? src;
    window.open(target, "_blank", "noopener,noreferrer");
  }, [displaySrc, src]);

  const handleCopy = useCallback(async () => {
    if (!permalink) return;
    await navigator.clipboard.writeText(permalink);
    setCopied(true);
    toast({ title: "Link copied", duration: 2000 });
    setTimeout(() => setCopied(false), 2000);
  }, [permalink, toast]);

  // Compact bottom bar + mobile menu: triggers card overlay
  const handleDeleteRequest = useCallback(() => {
    setMenuOpen(false);
    setConfirmingDelete(true);
  }, []);

  // Desktop glassmorphic menu: executes the actual delete
  const handleDeleteConfirm = useCallback(async () => {
    if (!onDelete) return;
    setDeleting(true);
    try { await onDelete(); }
    catch { toast({ variant: "destructive", title: "Delete failed" }); }
    finally { setDeleting(false); setConfirmingDelete(false); }
  }, [onDelete, toast]);

  const visibleActions = actions.filter(a => {
    if (a === "delete" && !onDelete) return false;
    if (a === "copyLink" && !permalink) return false;
    if (a === "makeMerch" && !onMakeMerch && !zazzleUrl) return false;
    return true;
  });

  const hasActions = visibleActions.length > 0;

  // compact: always visible; non-compact: desktop hover only
  const showActionBar = compact
    ? hasActions && !confirmingDelete
    : !isMobile && isHovered && !confirmingDelete && !menuOpen;

  const imageEl = displaySrc ? (
    <img
      src={displaySrc}
      alt={alt}
      className={cn(
        "w-full h-full object-cover transition-transform duration-300",
        isHovered && !compact && "scale-105",
      )}
      loading="lazy"
    />
  ) : (
    <div className="w-full h-full bg-muted animate-pulse" />
  );

  const handleImageClick = useCallback(() => {
    if (confirmingDelete) return;
    if (onSelect) { onSelect(); return; }
    openLightbox();
  }, [confirmingDelete, onSelect, openLightbox]);

  const clickableArea = href ? (
    <Link href={href} className="block">
      <div className={cn("relative overflow-hidden", aspectRatio)}>
        {imageEl}
        {imageOverlay}
      </div>
      {footer}
    </Link>
  ) : (
    <>
      <div
        className={cn(
          "relative overflow-hidden",
          aspectRatio,
          "cursor-pointer",
        )}
        onClick={handleImageClick}
      >
        {imageEl}
        {imageOverlay}
      </div>
      {footer}
    </>
  );

  const borderClass = selected
    ? "border-primary ring-2 ring-primary/30 scale-[1.03]"
    : "border-border hover:border-primary/60";

  return (
    <div
      className={cn("group relative border-2 rounded-sm overflow-hidden transition-all", borderClass, className)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {clickableArea}

      {/* Permanent top gradient scrim — keeps kebab readable over any image */}
      {hasActions && (
        <div
          className="absolute top-0 left-0 right-0 z-10 h-14 pointer-events-none"
          style={{ background: "linear-gradient(rgba(0,0,0,0.45) 0%, transparent 100%)" }}
        />
      )}

      {/* Kebab — rounded-rect, dims at rest, brightens on hover/open */}
      {hasActions && !confirmingDelete && (
        <button
          ref={kebabRef}
          aria-label="Image actions"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          onClick={e => { e.preventDefault(); e.stopPropagation(); setMenuOpen(o => !o); }}
          className="absolute top-1.5 right-1.5 z-20 flex items-center justify-center transition-all duration-200"
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: menuOpen ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.55)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            opacity: isHovered || menuOpen ? 1 : 0.6,
            border: "none",
            cursor: "pointer",
            outline: "none",
            color: "white",
          }}
        >
          {/* Filled circle three-dots — more prominent than stroke circles */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="rgba(255,255,255,0.92)">
            <circle cx="12" cy="5"  r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="12" cy="19" r="1.8" />
          </svg>
        </button>
      )}

      {/* Bottom action bar
           compact: always visible, corner icons (openFull / copyLink / delete)
           non-compact: hover-only gradient bar (openFull / copyLink only — delete lives in kebab) */}
      {showActionBar && (
        <div
          className={cn(
            "absolute bottom-0 z-10 flex items-center justify-end pointer-events-none",
            compact
              ? "right-0 gap-0.5 px-1 py-1"
              : "left-0 right-0 gap-1 px-2 py-1.5",
          )}
          style={compact ? undefined : { background: "linear-gradient(transparent, rgba(0,0,0,0.65))" }}
        >
          {visibleActions.includes("openFull") && !href && (
            <button
              aria-label="Open full resolution"
              tabIndex={0}
              onClick={e => { e.preventDefault(); e.stopPropagation(); openLightbox(); }}
              className={cn(
                "pointer-events-auto rounded-full text-white transition-colors",
                compact ? "p-1 bg-black/55 hover:bg-black/75" : "p-1.5 bg-white/10 hover:bg-white/25",
              )}
              title="Open full resolution"
            >
              <Maximize2 className={compact ? "w-3 h-3" : "w-3.5 h-3.5"} />
            </button>
          )}
          {visibleActions.includes("copyLink") && permalink && (
            <button
              aria-label="Copy link"
              tabIndex={0}
              onClick={e => { e.preventDefault(); e.stopPropagation(); void handleCopy(); }}
              className={cn(
                "pointer-events-auto rounded-full text-white transition-colors",
                compact ? "p-1 bg-black/55 hover:bg-black/75" : "p-1.5 bg-white/10 hover:bg-white/25",
              )}
              title={copied ? "Copied!" : "Copy link"}
            >
              {copied
                ? <CheckCircle2 className={compact ? "w-3 h-3 text-green-400" : "w-3.5 h-3.5 text-green-400"} />
                : <Link2 className={compact ? "w-3 h-3" : "w-3.5 h-3.5"} />}
            </button>
          )}
          {/* Delete in bar: compact mode only — non-compact delete is in the kebab menu */}
          {compact && visibleActions.includes("delete") && onDelete && (
            <button
              aria-label="Delete"
              tabIndex={0}
              onClick={e => { e.preventDefault(); e.stopPropagation(); handleDeleteRequest(); }}
              className="pointer-events-auto rounded-full text-white transition-colors p-1 bg-black/55 hover:bg-red-600"
              title="Delete"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      )}

      {/* Delete confirm overlay
           compact → mini overlay within card (compact bar's delete button)
           non-compact → full card overlay (mobile menu's delete, preserves mobile UX) */}
      {confirmingDelete && compact && (
        <div className="absolute inset-0 z-30 bg-black/80 flex flex-col items-center justify-center gap-1 p-1">
          <p className="text-[9px] font-bold text-white uppercase tracking-wide">Delete?</p>
          <div className="flex gap-1">
            <button
              onClick={e => { e.stopPropagation(); setConfirmingDelete(false); }}
              className="px-2 py-0.5 text-[9px] font-semibold rounded bg-white/20 text-white hover:bg-white/30 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={e => { e.stopPropagation(); void handleDeleteConfirm(); }}
              disabled={deleting}
              className="px-2 py-0.5 text-[9px] font-semibold rounded bg-red-600 text-white hover:bg-red-500 transition-colors flex items-center gap-0.5 disabled:opacity-60"
            >
              {deleting && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
              Delete
            </button>
          </div>
        </div>
      )}

      {confirmingDelete && !compact && (
        <div className="absolute inset-0 z-30 bg-black/85 flex flex-col items-center justify-center gap-3 p-4">
          <Trash2 className="w-6 h-6 text-red-400" />
          <p className="text-xs font-bold text-white text-center uppercase tracking-wider">Delete image?</p>
          <p className="text-[11px] text-white/60 text-center leading-relaxed">{deleteConfirmMessage}</p>
          <div className="flex gap-2 w-full">
            <button
              onClick={e => { e.stopPropagation(); setConfirmingDelete(false); }}
              className="flex-1 py-2 text-xs font-semibold rounded-sm bg-white/20 text-white hover:bg-white/30 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={e => { e.stopPropagation(); void handleDeleteConfirm(); }}
              disabled={deleting}
              className="flex-1 py-2 text-xs font-semibold rounded-sm bg-red-600 text-white hover:bg-red-500 transition-colors flex items-center justify-center gap-1 disabled:opacity-60"
            >
              {deleting && <Loader2 className="w-3 h-3 animate-spin" />}
              Delete
            </button>
          </div>
        </div>
      )}

      {/* Action menu: glassmorphic dropdown (desktop) / bottom sheet (mobile) */}
      {menuOpen && (
        <ActionMenu
          actions={visibleActions}
          onDeleteConfirm={visibleActions.includes("delete") && onDelete ? handleDeleteConfirm : undefined}
          onDeleteRequest={visibleActions.includes("delete") && onDelete ? handleDeleteRequest : undefined}
          onCopy={visibleActions.includes("copyLink") && permalink ? () => { void handleCopy(); } : undefined}
          onOpenFull={visibleActions.includes("openFull") ? openLightbox : undefined}
          onMakeMerch={visibleActions.includes("makeMerch") && onMakeMerch ? onMakeMerch : undefined}
          zazzleUrl={visibleActions.includes("makeMerch") ? zazzleUrl : undefined}
          onClose={() => setMenuOpen(false)}
          anchorRef={kebabRef as React.RefObject<HTMLElement | null>}
        />
      )}

    </div>
  );
}
