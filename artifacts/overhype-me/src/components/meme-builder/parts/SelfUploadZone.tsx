import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { useUploadModeration } from "../hooks/useUploadModeration";
import { UPLOAD_ERROR_COPY } from "../copy";

interface Props {
  onUploaded: (objectPath: string) => void;
  /** Allow uploading a replacement when an image is already selected. */
  allowReplace?: boolean;
}

export function SelfUploadZone({ onUploaded, allowReplace = true }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const { status, error, image, upload, reset } = useUploadModeration();

  const handleFile = useCallback(
    async (file: File) => {
      const result = await upload(file);
      if (result) onUploaded(result.objectPath);
    },
    [upload, onUploaded],
  );

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const showReplace = image && allowReplace;

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={onDrop}
      className={cn(
        "rounded-md border-2 border-dashed p-6 text-center transition",
        isDragging ? "border-primary bg-primary/5" : "border-border",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={onChange}
      />

      {status === "idle" && !image && (
        <div className="space-y-3">
          <p className="font-display text-lg uppercase">Drop a photo here</p>
          <p className="text-sm text-muted-foreground">JPEG, PNG, or WebP. Up to 15 MB.</p>
          <Button type="button" onClick={() => inputRef.current?.click()}>Choose file</Button>
        </div>
      )}

      {status === "uploading" && (
        <div className="space-y-2">
          <p className="font-display text-lg uppercase">Uploading…</p>
          <p className="text-sm text-muted-foreground">Running moderation checks.</p>
        </div>
      )}

      {status === "error" && error && (
        <div className="space-y-3">
          <p className="text-sm text-destructive">{UPLOAD_ERROR_COPY[error]}</p>
          <Button type="button" variant="secondary" onClick={() => { reset(); inputRef.current?.click(); }}>
            Try another
          </Button>
        </div>
      )}

      {status === "ready" && image && (
        <div className="flex flex-col items-center gap-3">
          <img src={image.previewBlobUrl} alt="" className="max-h-48 rounded-md border border-border" />
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {image.width} × {image.height}
            {image.isLowRes ? " · low-res" : ""}
          </p>
          {showReplace && (
            <Button type="button" variant="secondary" onClick={() => { reset(); inputRef.current?.click(); }}>
              Replace
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
