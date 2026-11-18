// Sentry init must run before App is imported so it can capture render errors.
import "./lib/sentry";
import { createRoot } from "react-dom/client";
import App from "./App";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/oswald/500.css";
import "@fontsource/oswald/600.css";
import "@fontsource/oswald/700.css";
import "./index.css";

// ---------------------------------------------------------------------------
// Global fetch interceptor — attaches Authorization: Bearer <token> to every
// /api/ request when a token is stored in localStorage (auth_token key).
// This bypasses iframe cookie restrictions that plague Replit's preview pane.
// ---------------------------------------------------------------------------

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function isMutatingMethod(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

// Development only: the workspace preview address is public, so the dev API
// refuses requests through it without the dev preview key (launch Phase 14,
// increment 3; api-server middlewares/devPreviewGate.ts). Opening the preview
// once with ?devPreviewKey=<key> keeps the key in this browser, sends it on
// every API call (which works inside Replit's preview pane, where cookies are
// unreliable), and sets the gate's cookie for images in a normal tab.
const DEV_PREVIEW_KEY_STORAGE = "dev_preview_key";
if (import.meta.env.DEV) {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("devPreviewKey");
  if (fromUrl) {
    localStorage.setItem(DEV_PREVIEW_KEY_STORAGE, fromUrl);
    url.searchParams.delete("devPreviewKey");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    void fetch(`/api/dev-preview-gate?key=${encodeURIComponent(fromUrl)}`, { credentials: "include", redirect: "manual" }).catch(() => {});
  }
}

const _originalFetch = window.fetch.bind(window);
window.fetch = function (input, init) {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;

  if (url.startsWith("/api/") || url.includes("/api/")) {
    const headers = new Headers((init?.headers as HeadersInit) ?? {});

    if (import.meta.env.DEV) {
      const previewKey = localStorage.getItem(DEV_PREVIEW_KEY_STORAGE);
      if (previewKey && !headers.has("X-Dev-Preview-Key")) headers.set("X-Dev-Preview-Key", previewKey);
    }

    const token = localStorage.getItem("auth_token");
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    const method = (init?.method ?? (input as Request)?.method ?? "GET");
    if (isMutatingMethod(method) && !headers.has("X-CSRF-Token")) {
      const csrfToken = readCookie("csrf_token");
      if (csrfToken) {
        headers.set("X-CSRF-Token", csrfToken);
      }
    }

    init = { ...init, headers };
  }

  return _originalFetch(input, init);
};

createRoot(document.getElementById("root")!).render(<App />);
