import { useState, useEffect } from "react";

interface AuthenticatedImageProps {
  src: string;
  alt?: string;
  className?: string;
  loading?: "lazy" | "eager";
  onError?: React.EventHandler<React.SyntheticEvent<HTMLImageElement>>;
}

/**
 * Renders an auth-protected image URL by fetching it via the global auth
 * interceptor (which injects the Authorization header) and returning a blob URL.
 * Use this instead of a plain <img> for any /api/memes/ai-user/image URLs.
 */
export function AuthenticatedImage({ src, alt, className, loading, onError }: AuthenticatedImageProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!src) return;
    let url: string | null = null;
    fetch(src, { credentials: "include" })
      .then(r => r.ok ? r.blob() : null)
      .then(blob => {
        if (blob) { url = URL.createObjectURL(blob); setBlobUrl(url); }
      })
      .catch(() => {});
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [src]);
  return <img src={blobUrl ?? undefined} alt={alt} className={className} loading={loading} onError={onError} />;
}
