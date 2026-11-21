// Builds the playground UI into playground/web/dist, which playground/server.ts serves. `pnpm run playground:dev`
// runs this with a proxy to a playground server on 127.0.0.1:4317 (start that one first).
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = { target: "http://127.0.0.1:4317", changeOrigin: true,
  // The API refuses foreign origins; the dev page's origin is the Vite port, so the proxy drops it.
  configure: (proxy: { on: (event: "proxyReq", fn: (req: { removeHeader: (name: string) => void }) => void) => void }) =>
    proxy.on("proxyReq", req => req.removeHeader("origin")) };

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 5317, strictPort: true, proxy: { "/api": api, "/logos": api } },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
