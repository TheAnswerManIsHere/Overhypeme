/**
 * Dev-server shim for the CJS-only `use-sync-external-store` package.
 *
 * `wouter` (via its react-deps) imports `use-sync-external-store/shim/index.js`
 * and `@radix-ui/react-use-is-hydrated` imports `use-sync-external-store/shim`.
 * Our vite config runs with `optimizeDeps.noDiscovery: true` (the esbuild dep
 * scan exhausts the container's OS thread limit), so those CJS files would be
 * served raw to the browser — and a named re-export from raw CJS fails with
 * "Indirectly exported binding name 'useSyncExternalStore' is not found".
 *
 * On React >= 18 the shim package just delegates to React's built-in hook, so
 * aliasing both specifiers here (see resolve.alias in vite.config.ts) is
 * semantically identical and removes the CJS module from the graph entirely.
 */
export { useSyncExternalStore } from "react";
