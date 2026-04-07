import { useState, useEffect } from "react";
import type { VideoStyleDef } from "@/config/videoStyles";

export function useVideoStyles() {
  const [styles, setStyles] = useState<VideoStyleDef[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/video-styles", { credentials: "include" })
      .then((r) => r.json())
      .then((data: VideoStyleDef[]) => {
        setStyles(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return { styles, loading };
}
