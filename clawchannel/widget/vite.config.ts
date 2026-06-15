import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During dev the widget runs on Vite's port; the WebSocket connects directly to
// the OpenClaw gateway port. Proxy /clawchannel/ws to the gateway so the widget
// can use a same-origin relative URL.
export default defineConfig({
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
});
