/**
 * The caption style picker, the same in both builders (names-and-fonts plan,
 * question N1): one chip per catalogue face, and a line saying when the
 * chosen face is still loading or failed to load, with a retry.
 *
 * @purpose Lets the visitor pick one of the catalogue's caption fonts in either meme builder, and shows the chosen face's loading or failed state with a retry.
 * @subsystem meme-studio
 */
import { CAPTION_FONTS, type CaptionFontId } from "@workspace/api-zod";
import { useCaptionFont } from "@/lib/captionFontLoader";

interface Props {
  value: CaptionFontId;
  onChange: (id: CaptionFontId) => void;
}

export function CaptionFontPicker({ value, onChange }: Props) {
  const { status, retry: onRetry } = useCaptionFont(value);
  return (
    <div className="space-y-2" data-testid="caption-font-picker">
      <span id="caption-font-label" className="text-xs uppercase tracking-wider text-muted-foreground">
        Caption style
      </span>
      <div role="radiogroup" aria-labelledby="caption-font-label" className="flex flex-wrap gap-2">
        {CAPTION_FONTS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={value === f.id}
            data-testid={`caption-font-${f.id}`}
            onClick={() => onChange(f.id)}
            className={`rounded-full px-3 py-1.5 text-xs ${
              value === f.id ? "bg-[#ff6b35] text-white" : "bg-white/5 text-white/80 hover:text-white"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {status === "loading" && (
        <p className="text-xs text-muted-foreground" role="status" data-testid="caption-font-loading">
          Loading this style…
        </p>
      )}
      {status === "failed" && (
        <p className="text-xs text-destructive" role="alert" data-testid="caption-font-failed">
          This style didn't load.{" "}
          <button type="button" className="underline" onClick={onRetry} data-testid="caption-font-retry">
            Try again
          </button>{" "}
          or pick another.
        </p>
      )}
    </div>
  );
}
