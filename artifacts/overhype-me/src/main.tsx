// Sentry init must run before App is imported so it can capture render errors.
import "./lib/sentry";
import { createRoot } from "react-dom/client";
import App from "./App";
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
