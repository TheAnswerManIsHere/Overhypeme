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
const _originalFetch = window.fetch.bind(window);
window.fetch = function (input, init) {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;

  if (url.startsWith("/api/") || url.includes("/api/")) {
    const token = localStorage.getItem("auth_token");
    if (token) {
      const headers = new Headers((init?.headers as HeadersInit) ?? {});
      if (!headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${token}`);
      }
      init = { ...init, headers };
    }
  }

  return _originalFetch(input, init);
};

createRoot(document.getElementById("root")!).render(<App />);
