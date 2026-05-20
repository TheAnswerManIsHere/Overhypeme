import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../ui/dialog";
import { Button } from "@/components/ui/Button";

interface Props {
  /** Open state — controlled by the parent. */
  open: boolean;
  /**
   * Called when the user picks "Try a different photo." Parent should cancel
   * the PuLID job (DELETE /api/memes/pulid-jobs/:jobId) and reset the source
   * picker so the user can choose a new upload.
   */
  onPickDifferentPhoto: () => void;
  /**
   * Called when the user picks "Use an abstract image." Parent should POST to
   * /api/memes/pulid-jobs/:jobId/proceed-with-no-face-fallback to fire the
   * standalone (no-reference) generator, then re-mount the loading takeover.
   */
  onUseAbstract: () => void;
  /**
   * Called when the dialog is dismissed (X / ESC / outside click). Treated as
   * "try a different photo" semantically — the user backs out of the failed
   * generation. Parent should also cancel the PuLID job.
   */
  onDismiss: () => void;
}

/**
 * No-face fallback modal for image-mode generation.
 *
 * Surfaced when the server returns phase="no_face_review" from the PuLID job.
 * Replaces the prior silent fallback behavior: the platform expects every
 * photo upload to contain a face, so when PuLID's detector misses we now ask
 * the user explicitly rather than swapping in a generic image without notice.
 */
export function NoFaceFallbackModal({
  open,
  onPickDifferentPhoto,
  onUseAbstract,
  onDismiss,
}: Props) {
  const [submitting, setSubmitting] = useState(false);

  const handleAbstract = () => {
    setSubmitting(true);
    onUseAbstract();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>We couldn't find a face</DialogTitle>
          <DialogDescription>
            Overhype is built around your face — but we couldn't see one in this photo. Try a different shot, or we can render an abstract image based on the fact instead.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex flex-col gap-2 sm:flex-col">
          <Button
            type="button"
            onClick={onPickDifferentPhoto}
            disabled={submitting}
            data-testid="no-face-try-different"
          >
            Try a different photo
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={handleAbstract}
            disabled={submitting}
            data-testid="no-face-use-abstract"
          >
            {submitting ? "Generating…" : "Use an abstract image"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
