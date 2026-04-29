import { useState, useEffect } from "react";
import { useAuth } from "@workspace/replit-auth-web";

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function getFileNameFromUrl(url: string): string {
  try {
    const pathname = new URL(url, "http://x").pathname;
    return decodeURIComponent(pathname.split("/").pop() ?? "") || url;
  } catch {
    return url.split("/").pop() ?? url;
  }
}

export function getMimeTypeFromUrl(url: string): string | null {
  const clean = (url.split("?")[0] ?? "").split("#")[0] ?? "";
  const ext = clean.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    avi: "video/avi",
    mkv: "video/x-matroska",
  };
  return map[ext] ?? null;
}

export interface AdminMediaInfoProps {
  fileName?: string | null;
  fileSizeBytes?: number | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
}

export function AdminMediaInfo({ fileName, fileSizeBytes, mimeType, width, height }: AdminMediaInfoProps) {
  const { role } = useAuth();
  if (role !== "admin") return null;

  const parts: [string, string][] = [];
  if (fileName) parts.push(["file", fileName]);
  if (fileSizeBytes != null && fileSizeBytes > 0) parts.push(["size", formatFileSize(fileSizeBytes)]);
  if (mimeType) parts.push(["type", mimeType]);
  if (width != null && height != null && width > 0 && height > 0) parts.push(["res", `${width}×${height}`]);

  if (parts.length === 0) return null;

  return (
    <div className="bg-black/80 border-t border-yellow-500/30 px-1.5 py-0.5 font-mono text-[9px] leading-relaxed text-yellow-400 flex flex-wrap gap-x-2 gap-y-0 min-w-0">
      {parts.map(([label, val]) => (
        <span key={label} className="min-w-0">
          <span className="text-yellow-500/50">{label}:</span>{" "}
          <span className="break-all">{val}</span>
        </span>
      ))}
    </div>
  );
}

export function useImageDimensions(url: string | null | undefined): { width: number; height: number } | null {
  const { role } = useAuth();
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (role !== "admin" || !url) {
      setDims(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => { if (!cancelled) setDims({ width: img.naturalWidth, height: img.naturalHeight }); };
    img.onerror = () => { if (!cancelled) setDims(null); };
    img.src = url;
    return () => { cancelled = true; };
  }, [url, role]);
  return dims;
}

export function AdminMediaInfoForUrl({
  url,
  fileName,
  fileSizeBytes,
  mimeType,
}: {
  url: string;
  fileName?: string | null;
  fileSizeBytes?: number | null;
  mimeType?: string | null;
}) {
  const { role } = useAuth();
  const dims = useImageDimensions(role === "admin" ? url : null);
  if (role !== "admin") return null;
  return (
    <AdminMediaInfo
      fileName={fileName ?? getFileNameFromUrl(url)}
      fileSizeBytes={fileSizeBytes}
      mimeType={mimeType ?? getMimeTypeFromUrl(url)}
      width={dims?.width}
      height={dims?.height}
    />
  );
}
