import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During dev the widget runs on Vite's port; the WebSocket connects directly to
// the OpenClaw gateway port. Proxy /clawchannel/ws to the gateway so the widget
// can use a same-origin relative URL.
//
// `base` differs by command: the production build is served by the gateway under
// the `/clawchannel/` path prefix, so built asset URLs must be prefixed to
// resolve there. Dev keeps base `/` so Vite's own server (and HMR) work normally.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/clawchannel/" : "/",
  plugins: [react()],
  server: {
    proxy: {
      "/clawchannel/ws": {
        // OpenClaw gateway default port (PLAN.md / RESEARCH.md §1).
        target: "ws://127.0.0.1:18789",
        ws: true,
      },
    },
  },
}));
