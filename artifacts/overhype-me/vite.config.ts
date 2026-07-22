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
    alias: [
      { find: "@", replacement: path.resolve(import.meta.dirname, "src") },
      { find: "@assets", replacement: path.resolve(import.meta.dirname, "..", "..", "attached_assets") },
      // use-sync-external-store is CJS-only; with noDiscovery (below) it is
      // never pre-bundled, and its named exports break in the dev server
      // ("Indirectly exported binding name 'useSyncExternalStore' is not
      // found"). React 19 has the hook built in — route both shim specifiers
      // (wouter uses ".../shim/index.js", Radix uses ".../shim") to a local
      // ESM re-export instead. The regex must cover the full subpaths: a
      // bare-name alias would break their resolution.
      {
        find: /^use-sync-external-store\/shim(\/index\.js)?$/,
        replacement: path.resolve(import.meta.dirname, "src/lib/use-sync-external-store-shim.ts"),
      },
    ],
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
  optimizeDeps: {
    // Disable automatic dependency scanning in the dev server.
    // The full esbuild dep scan spawns thousands of goroutines which exhausts
    // the container's OS thread limit (~1024 total) and panics. With noDiscovery
    // set, Vite skips the dep-graph scan and only pre-bundles the packages
    // listed explicitly in `include` below, then transforms everything else
    // on-demand.
    //
    // On-demand transform cannot expose named exports from CJS-only packages.
    // CJS packages that export named bindings must be pre-bundled here so
    // esbuild can convert them to ESM. `use-sync-external-store` (used by
    // wouter/Radix) is handled via resolve.alias to a local ESM shim instead
    // because its subpath specifiers (`/shim/index.js`) aren't pre-bundleable
    // without also bundling the CJS caller. react and react-dom/client are
    // pure CJS with no subpath complications — pre-bundle them directly.
    noDiscovery: true,
    include: [
      // CJS-only runtimes — must be pre-bundled so esbuild can convert to ESM.
      "react",
      "react-dom",
      "react-dom/client",
      // Heavy deps used on admin/moderation pages. Pre-bundling these means
      // esbuild processes them ONCE at dev-server startup rather than spawning
      // a fresh goroutine burst for every on-demand transform when the page
      // loads. recharts pulls in a forest of d3-* sub-packages; collapsing
      // them here avoids dozens of concurrent transform requests that push
      // esbuild past the container's OS thread limit (GOMAXPROCS=2 helps too,
      // but pre-bundling is the more targeted fix).
      "recharts",
      "lucide-react",
    ],
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
    // On Replit, the platform's path router (.replit `router = "path"`) sends
    // /api to the api-server workflow before requests ever reach Vite, so no
    // proxy is needed (or used) there. Outside Replit — CI's e2e smoke job and
    // bare local dev — nothing plays that role, so this env-gated proxy is the
    // stand-in. Unset E2E_API_PROXY_TARGET → config is byte-for-byte inert.
    ...(process.env.E2E_API_PROXY_TARGET
      ? { proxy: { "/api": { target: process.env.E2E_API_PROXY_TARGET } } }
      : {}),
  },
  preview: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
