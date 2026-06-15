import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Library build for the reusable widget (@clawchannel/widget). Emits ESM to
// dist-lib/ with React externalized (consumers bring their own React via the
// declared peerDependencies). This is SEPARATE from vite.config.ts, which
// builds the example app into dist/ for the gateway to static-serve.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist-lib",
    emptyOutDir: true,
    lib: {
      entry: "src/lib/index.ts",
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      external: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
      ],
    },
  },
});
