// Before any schema is built: zod must never probe `new Function` under the
// web CSP (lib/zodConfig.ts).
import "./lib/zodConfig";
// Then: in development, take the preview key out of the page address before
// error monitoring starts and could record it (launch Phase 14, increment 3).
import { devPreviewKey, DEV_PREVIEW_HEADER } from "./lib/devPreviewUnlock";
// Telemetry must start before App renders so error monitoring can capture render errors.
import { startTelemetry } from "./lib/telemetry";
import { inspectForReadOnly } from "./lib/readOnlyNotice";
import { readBearerToken } from "./lib/bearerToken";
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

    // Development only: the dev preview's API needs its key (lib/devPreviewUnlock.ts).
    const previewKey = devPreviewKey();
    if (previewKey && !headers.has(DEV_PREVIEW_HEADER)) headers.set(DEV_PREVIEW_HEADER, previewKey);

    const token = readBearerToken();
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

    // Read-only mode (launch Phase 16, increment 4): a refused write raises
    // the site-wide notice; the caller still reads the response as before.
    return _originalFetch(input, init).then((response) => {
      void inspectForReadOnly(response);
      return response;
    });
  }

  return _originalFetch(input, init);
};

startTelemetry();

createRoot(document.getElementById("root")!).render(<App />);
