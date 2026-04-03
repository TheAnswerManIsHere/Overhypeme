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
  MoreVertical,
  Trash2,
  Link2,
  Maximize2,
  X,
  CheckCircle2,
  ChevronDown,
  Loader2,
} from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type ActionType = "delete" | "copyLink" | "openFull";

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

interface LightboxProps {
  src: string;
  alt?: string;
  actions: ActionType[];
  onDelete?: () => Promise<void> | void;
  deleteConfirmMessage?: string;
  permalink?: string;
  onClose: () => void;
}

function Lightbox({ src, alt, actions, onDelete, deleteConfirmMessage, permalink, onClose }: LightboxProps) {
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleDelete() {
    if (!onDelete) return;
    setDeleting(true);
    try { await onDelete(); onClose(); }
    catch { toast({ variant: "destructive", title: "Delete failed" }); }
    finally { setDeleting(false); setConfirming(false); }
  }

  async function handleCopy() {
    if (!permalink) return;
    await navigator.clipboard.writeText(permalink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      className="fixed inset-0 z-[9999] flex flex-col bg-black/90 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* toolbar */}
      <div
        className="flex items-center justify-between px-4 py-3 shrink-0"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          {actions.includes("copyLink") && permalink && (
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 text-white/80 hover:text-white text-sm font-medium px-3 py-1.5 rounded-sm bg-white/10 hover:bg-white/20 transition-colors"
              aria-label="Copy link"
            >
              {copied ? <><CheckCircle2 className="w-4 h-4 text-green-400" /> Copied</> : <><Link2 className="w-4 h-4" /> Copy Link</>}
            </button>
          )}
          {actions.includes("delete") && onDelete && !confirming && (
            <button
              onClick={() => setConfirming(true)}
              className="flex items-center gap-1.5 text-white/80 hover:text-red-400 text-sm font-medium px-3 py-1.5 rounded-sm bg-white/10 hover:bg-white/20 transition-colors"
              aria-label="Delete image"
            >
              <Trash2 className="w-4 h-4" /> Delete
            </button>
          )}
          {confirming && (
            <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
              <span className="text-white/70 text-sm">{deleteConfirmMessage ?? "Delete this image?"}</span>
              <button onClick={() => setConfirming(false)} className="text-white/60 hover:text-white px-2 py-1 text-sm rounded-sm bg-white/10">Cancel</button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex items-center gap-1 px-3 py-1 text-sm rounded-sm bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-50"
              >
                {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Confirm
              </button>
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-2 text-white/60 hover:text-white transition-colors rounded-full hover:bg-white/10"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* image */}
      <div
        className="flex-1 flex items-center justify-center p-4 min-h-0"
        onClick={onClose}
      >
        <img
          src={src}
          alt={alt ?? "Full resolution image"}
          className="max-w-full max-h-full object-contain rounded-sm"
          onClick={e => e.stopPropagation()}
        />
      </div>
    </div>,
    document.body
  );
}

interface ActionMenuProps {
  actions: ActionType[];
  onDelete?: () => void;
  onCopy?: () => void;
  onOpenFull?: () => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

function ActionMenu({ actions, onDelete, onCopy, onOpenFull, onClose, anchorRef }: ActionMenuProps) {
  const isMobile = useIsMobile();
  const menuRef = useRef<HTMLDivElement>(null);
  useClickOutside(menuRef as React.RefObject<HTMLElement | null>, onClose);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const items = [
    actions.includes("openFull") && onOpenFull && { icon: <Maximize2 className="w-4 h-4" />, label: "Open Full Resolution", action: onOpenFull },
    actions.includes("copyLink") && onCopy && { icon: <Link2 className="w-4 h-4" />, label: "Copy Link", action: onCopy },
    actions.includes("delete") && onDelete && { icon: <Trash2 className="w-4 h-4 text-red-400" />, label: <span className="text-red-400">Delete</span>, action: onDelete },
  ].filter(Boolean) as { icon: ReactNode; label: ReactNode; action: () => void }[];

  if (isMobile) {
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
          {items.map((item, i) => (
            <button
              key={i}
              role="menuitem"
              onClick={() => { item.action(); onClose(); }}
              className="flex items-center gap-4 w-full px-6 py-4 text-left text-sm font-medium hover:bg-accent transition-colors"
            >
              {item.icon}
              {item.label}
            </button>
          ))}
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

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[9998] min-w-[180px] bg-popover border border-border rounded-sm shadow-lg py-1 animate-in fade-in zoom-in-95 duration-150"
      style={(() => {
        if (!anchorRef.current) return {};
        const rect = anchorRef.current.getBoundingClientRect();
        const right = window.innerWidth - rect.right;
        const top = rect.bottom + 4;
        return { top, right };
      })()}
    >
      {items.map((item, i) => (
        <button
          key={i}
          role="menuitem"
          onClick={() => { item.action(); onClose(); }}
          className="flex items-center gap-3 w-full px-4 py-2.5 text-left text-sm font-medium hover:bg-accent transition-colors"
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  );
}

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
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const kebabRef = useRef<HTMLButtonElement>(null);

  const openLightbox = useCallback(() => {
    if (href) { window.location.href = href; return; }
    setLightboxOpen(true);
  }, [href]);

  const handleCopy = useCallback(async () => {
    if (!permalink) return;
    await navigator.clipboard.writeText(permalink);
    setCopied(true);
    toast({ title: "Link copied", duration: 2000 });
    setTimeout(() => setCopied(false), 2000);
  }, [permalink, toast]);

  const handleDeleteRequest = useCallback(() => {
    setMenuOpen(false);
    setConfirmingDelete(true);
  }, []);

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
    return true;
  });

  const hasActions = visibleActions.length > 0;

  // compact thumbnails: action bar is always visible
  // non-compact: only appears on desktop hover
  const showActionBar = compact
    ? hasActions && !confirmingDelete
    : !isMobile && isHovered && !confirmingDelete && !menuOpen;

  const imageEl = displaySrc ? (
    <img
      src={displaySrc}
      alt={alt}
      className={cn("w-full h-full object-cover transition-transform duration-300", isHovered && !compact && "scale-105")}
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
        className={cn("relative overflow-hidden", aspectRatio, onSelect ? "cursor-pointer" : "cursor-zoom-in")}
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

      {/* Kebab button — top-right, always shown when there are actions */}
      {hasActions && !confirmingDelete && (
        <button
          ref={kebabRef}
          aria-label="Image actions"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          onClick={e => { e.preventDefault(); e.stopPropagation(); setMenuOpen(o => !o); }}
          className="absolute top-1.5 right-1.5 z-20 w-8 h-8 rounded-full flex items-center justify-center text-white transition-opacity"
          style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }}
        >
          <MoreVertical className="w-4 h-4 shrink-0" />
        </button>
      )}

      {/* Action bar — bottom edge
           compact: always visible, small corner icons
           non-compact: desktop hover only, full-width gradient */}
      {showActionBar && (
        <div
          className={cn(
            "absolute bottom-0 z-10 flex items-center justify-end pointer-events-none",
            compact
              ? "right-0 gap-0.5 px-1 py-1"
              : "left-0 right-0 gap-1 px-2 py-1.5"
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
                compact
                  ? "p-1 bg-black/55 hover:bg-black/75"
                  : "p-1.5 bg-white/10 hover:bg-white/25"
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
                compact
                  ? "p-1 bg-black/55 hover:bg-black/75"
                  : "p-1.5 bg-white/10 hover:bg-white/25"
              )}
              title={copied ? "Copied!" : "Copy link"}
            >
              {copied ? <CheckCircle2 className={compact ? "w-3 h-3 text-green-400" : "w-3.5 h-3.5 text-green-400"} /> : <Link2 className={compact ? "w-3 h-3" : "w-3.5 h-3.5"} />}
            </button>
          )}
          {visibleActions.includes("delete") && onDelete && (
            <button
              aria-label="Delete"
              tabIndex={0}
              onClick={e => { e.preventDefault(); e.stopPropagation(); handleDeleteRequest(); }}
              className={cn(
                "pointer-events-auto rounded-full text-white transition-colors",
                compact
                  ? "p-1 bg-black/55 hover:bg-red-600"
                  : "p-1.5 bg-white/10 hover:bg-red-600/80"
              )}
              title="Delete"
            >
              <Trash2 className={compact ? "w-3 h-3" : "w-3.5 h-3.5"} />
            </button>
          )}
        </div>
      )}

      {/* Delete confirmation overlay */}
      {confirmingDelete && (
        compact ? (
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
        ) : (
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
        )
      )}

      {/* Action menu (bottom sheet mobile / dropdown desktop) */}
      {menuOpen && (
        <ActionMenu
          actions={visibleActions}
          onDelete={visibleActions.includes("delete") && onDelete ? handleDeleteRequest : undefined}
          onCopy={visibleActions.includes("copyLink") && permalink ? () => { void handleCopy(); } : undefined}
          onOpenFull={visibleActions.includes("openFull") ? openLightbox : undefined}
          onClose={() => setMenuOpen(false)}
          anchorRef={kebabRef as React.RefObject<HTMLElement | null>}
        />
      )}

      {/* Lightbox */}
      {lightboxOpen && displaySrc && (
        <Lightbox
          src={displaySrc}
          alt={alt}
          actions={visibleActions}
          onDelete={onDelete}
          deleteConfirmMessage={deleteConfirmMessage}
          permalink={permalink}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </div>
  );
}
