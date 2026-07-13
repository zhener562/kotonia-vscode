import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Builds the chat webview (webview-ui/) into a single self-contained IIFE
// bundle + one CSS file under media/chat/, loaded by src/webview.ts with a
// per-render CSP nonce. No hashing/code-splitting so the filenames the
// extension references stay stable, and no inline scripts so the strict CSP
// (script-src 'nonce-…') holds.
export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "media/chat",
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    minify: true,
    lib: {
      entry: resolve(__dirname, "webview-ui/src/main.tsx"),
      formats: ["iife"],
      name: "KotoniaChat",
      fileName: () => "main.js",
    },
    rollupOptions: {
      output: { assetFileNames: "main.[ext]" },
    },
  },
});
