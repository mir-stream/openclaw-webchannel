import { defineConfig } from "vite";

// Build + dev server for the vanilla demo (no React plugin — this package has no
// framework).
//
// `base` differs by command: the production build is static-served by the
// gateway under the `/clawchannel/` path prefix, so built asset URLs must be
// prefixed to resolve there. Dev keeps base `/` so Vite's own server (+ HMR)
// works normally.
//
// The demo connects with a same-origin relative WS path. In dev that needs a
// proxy to the gateway port; when served BY the gateway (prod build) it is
// already same-origin, so no proxy is involved.
//
// Output goes to `dist-demo/` to stay clear of the LIBRARY build (`dist/`, from
// tsconfig.build.json). The gateway serves `dist-demo/` (see repo-root index.ts).
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/clawchannel/" : "/",
  build: {
    outDir: "dist-demo",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/clawchannel/ws": {
        target: "ws://127.0.0.1:18789",
        ws: true,
      },
    },
  },
}));
