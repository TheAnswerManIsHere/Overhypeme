import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { sentryVitePlugin } from "@sentry/vite-plugin";

const rawPort = process.env.PORT;

// Single source of truth for the Sentry release name. Used by both the source-map
// upload plugin (below) AND injected into the client bundle as
// VITE_SENTRY_RELEASE so the SDK tags events with the matching release. If
// these ever drift, Sentry won't symbolicate frontend stack traces.
const sentryRelease =
  process.env.REPLIT_DEPLOYMENT_ID ??
  process.env.REPLIT_GIT_COMMIT_SHA?.slice(0, 7) ??
  "dev";
// Inject into Vite's env so import.meta.env.VITE_SENTRY_RELEASE picks it up at build time.
process.env.VITE_SENTRY_RELEASE = sentryRelease;

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
    // Upload source maps to Sentry on production builds. Skipped automatically
    // when SENTRY_AUTH_TOKEN is missing (e.g. local dev or contributor builds).
    // Must be the LAST plugin so it runs after the build has emitted assets.
    //
    // CRITICAL: The release name MUST match the value used by the SDK at runtime
    // (src/lib/sentry.ts reads import.meta.env.VITE_SENTRY_RELEASE). We force
    // both to derive from the same env var below so events and uploaded source
    // maps land under the same release in Sentry — otherwise stack traces stay
    // un-symbolicated.
    ...(process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT_FRONTEND
      ? [sentryVitePlugin({
          authToken: process.env.SENTRY_AUTH_TOKEN,
          org: process.env.SENTRY_ORG,
          project: process.env.SENTRY_PROJECT_FRONTEND,
          release: { name: sentryRelease },
          sourcemaps: {
            // Delete .map files after upload so they're not served to end users.
            filesToDeleteAfterUpload: ["./dist/public/**/*.map"],
          },
          telemetry: false,
        })]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // Source maps are required for Sentry to symbolicate production stack traces.
    // The Sentry vite plugin (above) deletes them after upload so they're never served.
    sourcemap: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
