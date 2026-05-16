import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { useDesktopModality } from "../hooks/useDesktopModality";
import { useMyImages } from "../hooks/useMyImages";
import { useAutoSelectDefault } from "../hooks/useAutoSelectDefault";
import { SelfUploadZone } from "./SelfUploadZone";
import type { MyImageSource } from "../types";

interface Props {
  factId: string;
  /** From the auth viewer; the user's avatar object_path. */
  primaryImageObjectPath?: string;
  /** Show the AI stylings tab. */
  showAiStylings: boolean;
  selected: MyImageSource | null;
  onSelect: (next: MyImageSource) => void;
  /** Tabs to hide entirely. Useful when a parent wants to restrict available choices. */
  hideTabs?: Tab[];
}

type Tab = "primary" | "library" | "ai" | "upload";

export function MyImagePicker({ factId, primaryImageObjectPath, showAiStylings, selected, onSelect, hideTabs }: Props) {
  const [tab, setTab] = useState<Tab>(() => {
    const preferred: Tab = primaryImageObjectPath ? "primary" : "library";
    if (!hideTabs?.includes(preferred)) return preferred;
    // Preferred tab is hidden — fall back to first visible non-hidden tab.
    const candidates: Tab[] = ["primary", "library", "ai", "upload"];
    return (
      candidates.find((t) => {
        if (hideTabs?.includes(t)) return false;
        if (t === "primary") return !!primaryImageObjectPath;
        if (t === "ai") return showAiStylings;
        return true;
      }) ?? "upload"
    );
  });
  const [reloadKey, setReloadKey] = useState(0);
  const isDesktop = useDesktopModality();

  const library = useMyImages({ enabled: tab === "library", transform: "raw", reloadKey });
  const stylings = useMyImages({ enabled: tab === "ai", transform: "ai", factId, reloadKey });

  // When the picker mounts in the "primary" tab and the viewer has a primary
  // photo, dispatch the selection upward exactly once so `state.myImage`
  // reflects the visible default and the live preview can render immediately.
  // Without this the parent reducer never receives the implicit selection and
  // `useBackgroundUrl` returns null — see task #495.
  useAutoSelectDefault<MyImageSource>({
    enabled: tab === "primary" && !!primaryImageObjectPath && selected?.kind !== "primary",
    identityKey: primaryImageObjectPath ? `primary:${primaryImageObjectPath}` : null,
    resolveDefault: () => ({ kind: "primary" }),
    onSelect,
  });

  const isSelectedObject = (objectPath: string) =>
    selected !== null && (selected.kind === "library" || selected.kind === "fresh" || selected.kind === "ai-styling")
      && selected.objectPath === objectPath;

  const tabs: { value: Tab; label: string; visible: boolean }[] = [
    { value: "primary", label: "Primary",     visible: !!primaryImageObjectPath && !hideTabs?.includes("primary") },
    { value: "library", label: "My photos",   visible: !hideTabs?.includes("library") },
    { value: "ai",      label: "AI stylings", visible: showAiStylings && !hideTabs?.includes("ai") },
    { value: "upload",  label: "Upload new",  visible: !hideTabs?.includes("upload") },
  ];

  return (
    <div className="space-y-3">
      <div className="flex gap-1 rounded-md bg-secondary/40 p-1">
        {tabs.filter((t) => t.visible).map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTab(t.value)}
            className={cn(
              "flex-1 rounded px-3 py-1.5 text-xs font-mono uppercase tracking-widest transition",
              tab === t.value ? "bg-background text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "primary" && primaryImageObjectPath && (
        <button
          type="button"
          onClick={() => onSelect({ kind: "primary" })}
          className={cn(
            "block overflow-hidden rounded-md border-2 transition",
            selected?.kind === "primary" ? "border-primary" : "border-transparent hover:border-secondary",
          )}
        >
          <img
            src={`/api/storage/objects${primaryImageObjectPath.replace(/^\/objects/, "")}`}
            alt=""
            className="h-40 w-full object-cover"
          />
        </button>
      )}

      {tab === "library" && (
        <ImageGrid
          isDesktop={isDesktop}
          isLoading={library.isLoading}
          isError={library.isError}
          rows={library.rows.map((r) => ({ objectPath: r.objectPath, url: storageUrlFor(r.objectPath) }))}
          isSelected={isSelectedObject}
          onSelect={(objectPath) => onSelect({ kind: "library", objectPath })}
          emptyText="You haven't uploaded any photos yet."
        />
      )}

      {tab === "ai" && (
        <ImageGrid
          isDesktop={isDesktop}
          isLoading={stylings.isLoading}
          isError={stylings.isError}
          rows={stylings.rows.map((r) => ({ objectPath: r.objectPath, url: storageUrlFor(r.objectPath) }))}
          isSelected={isSelectedObject}
          onSelect={(objectPath) => onSelect({ kind: "ai-styling", objectPath })}
          emptyText="No AI stylings for this fact yet."
        />
      )}

      {tab === "upload" && (
        <SelfUploadZone
          onUploaded={(objectPath) => {
            onSelect({ kind: "fresh", objectPath });
            setReloadKey((k) => k + 1);
          }}
        />
      )}

      {tab === "library" && library.rows.length === 0 && !library.isLoading && (
        <Button variant="secondary" type="button" onClick={() => setTab("upload")}>
          Upload your first photo
        </Button>
      )}
    </div>
  );
}

function storageUrlFor(objectPath: string): string {
  // Object paths are stored as `/objects/uploads/<uuid>.<ext>`. The auth-gated
  // delivery route is `/api/storage/objects/<rest>`.
  return `/api/storage/objects${objectPath.replace(/^\/objects/, "")}`;
}

interface ImageGridProps {
  isDesktop: boolean;
  isLoading: boolean;
  isError: boolean;
  rows: { objectPath: string; url: string }[];
  isSelected: (objectPath: string) => boolean;
  onSelect: (objectPath: string) => void;
  emptyText: string;
}

function ImageGrid({ isDesktop, isLoading, isError, rows, isSelected, onSelect, emptyText }: ImageGridProps) {
  if (isLoading) return <div className="h-32 animate-pulse rounded-md bg-secondary/40" />;
  if (isError) return <p className="text-sm text-destructive">Could not load images.</p>;
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  return (
    <div
      className={cn(
        isDesktop
          ? "grid grid-cols-3 gap-2 sm:grid-cols-4"
          : "flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1",
      )}
    >
      {rows.map((r) => (
        <button
          key={r.objectPath}
          type="button"
          onClick={() => onSelect(r.objectPath)}
          className={cn(
            "relative shrink-0 snap-start overflow-hidden rounded-md border-2 transition",
            isDesktop ? "aspect-square" : "h-24 w-32",
            isSelected(r.objectPath) ? "border-primary" : "border-transparent hover:border-secondary",
          )}
        >
          <img src={r.url} alt="" loading="lazy" className="h-full w-full object-cover" />
        </button>
      ))}
    </div>
  );
}
