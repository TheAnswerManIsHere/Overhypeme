import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { useDesktopModality } from "../hooks/useDesktopModality";
import { useMyImages, type MyImageRow } from "../hooks/useMyImages";
import { useAutoSelectDefault } from "../hooks/useAutoSelectDefault";
import { SelfUploadZone } from "./SelfUploadZone";
import type { MyImageSource } from "../types";

interface Props {
  factId: string;
  /** Show the AI stylings tab. */
  showAiStylings: boolean;
  selected: MyImageSource | null;
  onSelect: (next: MyImageSource) => void;
  /** Tabs to hide entirely. Useful when a parent wants to restrict available choices. */
  hideTabs?: Tab[];
}

type Tab = "library" | "ai" | "upload";

/**
 * Task #507 — the "Profile photo" tab is gone. The user's profile photo now
 * appears as the first tile in the "My photos" grid with a small "PROFILE"
 * badge (the server tags it via `upload_image_metadata.is_profile=true` and
 * sorts it first). The library tab auto-selects whichever image is first
 * (so the profile photo is the implicit default on tab activation).
 */
export function MyImagePicker({ factId, showAiStylings, selected, onSelect, hideTabs }: Props) {
  const [tab, setTab] = useState<Tab>(() => {
    const preferred: Tab = "library";
    if (!hideTabs?.includes(preferred)) return preferred;
    const candidates: Tab[] = ["library", "ai", "upload"];
    return (
      candidates.find((t) => {
        if (hideTabs?.includes(t)) return false;
        if (t === "ai") return showAiStylings;
        return true;
      }) ?? "upload"
    );
  });
  const [reloadKey, setReloadKey] = useState(0);
  const isDesktop = useDesktopModality();

  const library = useMyImages({ enabled: tab === "library", transform: "raw", reloadKey });
  const stylings = useMyImages({ enabled: tab === "ai", transform: "ai", factId, reloadKey });

  // Auto-pick the first library image on tab activation so the preview lights
  // up immediately without an extra tap. The server already sorts the profile
  // photo first (is_profile DESC, created_at DESC), so this is also how the
  // old "primary" default is preserved.
  const firstLibraryPath = !library.isLoading && library.rows.length > 0 ? library.rows[0].objectPath : null;
  useAutoSelectDefault<MyImageSource>({
    enabled: tab === "library" && !selected && !!firstLibraryPath,
    identityKey: firstLibraryPath,
    resolveDefault: () => firstLibraryPath ? { kind: "library", objectPath: firstLibraryPath } : null,
    onSelect,
  });

  const isSelectedObject = (objectPath: string) =>
    selected !== null && (selected.kind === "library" || selected.kind === "fresh" || selected.kind === "ai-styling")
      && selected.objectPath === objectPath;

  const tabs: { value: Tab; label: string; visible: boolean }[] = [
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

      {tab === "library" && (
        <ImageGrid
          isDesktop={isDesktop}
          isLoading={library.isLoading}
          isError={library.isError}
          rows={library.rows.map((r) => ({ objectPath: r.objectPath, url: storageUrlFor(r.objectPath), isProfile: r.isProfile }))}
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
          rows={stylings.rows.map((r) => ({ objectPath: r.objectPath, url: storageUrlFor(r.objectPath), isProfile: false }))}
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

interface ImageGridRow {
  objectPath: string;
  url: string;
  isProfile: boolean;
}

interface ImageGridProps {
  isDesktop: boolean;
  isLoading: boolean;
  isError: boolean;
  rows: ImageGridRow[];
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
          {r.isProfile && (
            <span
              aria-label="Profile photo"
              data-testid="my-image-profile-badge"
              className="absolute left-1 top-1 rounded-sm bg-primary/90 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-primary-foreground"
            >
              Profile
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export type { MyImageRow };
