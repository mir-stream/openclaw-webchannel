import { defineConfig } from "vite";

// Dev server for the vanilla demo (no React plugin — this package has no
// framework). The demo connects with a same-origin relative WS path, so proxy
// /clawchannel/ws to the OpenClaw gateway port (matches the widget example's
// dev setup: PLAN.md / RESEARCH.md §1).
export default defineConfig({
  server: {
    proxy: {
      "/clawchannel/ws": {
        target: "ws://127.0.0.1:18789",
        ws: true,
      },
    },
  },
});
