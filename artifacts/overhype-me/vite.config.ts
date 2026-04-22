import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { sentryVitePlugin } from "@sentry/vite-plugin";

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

// PORT and BASE_PATH are only required for the dev server, not during `vite build`.
const isBuild = process.argv.includes("build");

const rawPort = process.env.PORT;
if (!rawPort && !isBuild) {
  throw new Error("PORT environment variable is required but was not provided.");
}
const port = rawPort ? Number(rawPort) : 3000;
if (!isBuild && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;
if (!basePath && !isBuild) {
  throw new Error("BASE_PATH environment variable is required but was not provided.");
}

export default defineConfig({
  base: basePath ?? "/",
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
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Core React runtime — tiny and loaded first
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/") || id.includes("node_modules/scheduler/")) {
            return "vendor-react";
          }
          // Routing + data-fetching — needed on every page
          if (id.includes("node_modules/wouter/") || id.includes("node_modules/@tanstack/")) {
            return "vendor-query";
          }
          // Recharts + d3 helpers — only used on admin pages
          if (id.includes("node_modules/recharts/") || id.includes("node_modules/d3-") || id.includes("node_modules/victory-")) {
            return "vendor-charts";
          }
          // Framer Motion — animation library, not needed immediately
          if (id.includes("node_modules/framer-motion/")) {
            return "vendor-animation";
          }
          // Radix UI primitives
          if (id.includes("node_modules/@radix-ui/")) {
            return "vendor-radix";
          }
          // Icon libraries
          if (id.includes("node_modules/lucide-react/") || id.includes("node_modules/react-icons/")) {
            return "vendor-icons";
          }
          // Forms + validation
          if (id.includes("node_modules/react-hook-form/") || id.includes("node_modules/@hookform/") || id.includes("node_modules/zod/")) {
            return "vendor-forms";
          }
          // Everything else from node_modules in one shared vendor chunk
          if (id.includes("node_modules/")) {
            return "vendor-misc";
          }
        },
      },
    },
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
