/**
 * @purpose Development only: unlocks this browser for the dev preview's API (launch Phase 14, increment 3; api-server middlewares/devPreviewGate.ts). Opening the preview once with ?devPreviewKey=<key> stores the key in localStorage, strips it from the address, and sends it in a header to POST /api/dev-preview-gate so the gate sets its cookie. devPreviewKey() is what the fetch interceptor and the admin shortcut send.
 * @subsystem security
 *
 * Imported first in main.tsx, before error monitoring exists, so the key in
 * the page address is gone before anything can record it. It never travels in
 * an API address. Production builds compile this to nothing
 * (`import.meta.env.DEV` is false there).
 */
export const DEV_PREVIEW_KEY_STORAGE = "dev_preview_key";
export const DEV_PREVIEW_HEADER = "X-Dev-Preview-Key";

/** The stored key, or null outside development or when none is stored. */
export function devPreviewKey(): string | null {
  if (!import.meta.env.DEV) return null;
  try {
    return localStorage.getItem(DEV_PREVIEW_KEY_STORAGE);
  } catch {
    return null;
  }
}

/** Reads ?devPreviewKey= from `href`, stores it, and returns the address without it; null when absent. */
export function takeKeyFromAddress(href: string, storage: Pick<Storage, "setItem">): { key: string; cleaned: string } | null {
  const url = new URL(href);
  const key = url.searchParams.get("devPreviewKey");
  if (!key) return null;
  storage.setItem(DEV_PREVIEW_KEY_STORAGE, key);
  url.searchParams.delete("devPreviewKey");
  return { key, cleaned: url.pathname + url.search + url.hash };
}

if (import.meta.env.DEV) {
  try {
    const taken = takeKeyFromAddress(window.location.href, localStorage);
    if (taken) {
      window.history.replaceState(null, "", taken.cleaned);
      void fetch("/api/dev-preview-gate", {
        method: "POST",
        credentials: "include",
        headers: { [DEV_PREVIEW_HEADER]: taken.key },
      }).catch(() => {});
    }
  } catch {
    // No storage (a locked-down browser): the preview stays locked.
  }
}
