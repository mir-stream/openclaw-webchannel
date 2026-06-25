import { defineConfig } from "vite";

// Run from this directory (`npm run web` sets cwd here, which Vite uses as root).
// protocol.ts lives one level up but inside the same npm workspace, so Vite's
// default workspace-root fs allowance already covers it.
export default defineConfig({
  server: { port: 5273 },
});
