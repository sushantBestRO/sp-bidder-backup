import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Dev: serve the console on :4330, proxy /api -> the Express backend on :4103.
// Build: emit static into dist/, which the Express server serves in production.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: {
    port: 4330,
    proxy: {
      // The bidder rejects mutating POSTs whose Origin host != Host (a CSRF guard). Under this
      // dev proxy the browser's Origin is :4330 but the request reaches Express as Host :4103,
      // so saves 403. Rewrite the forwarded Origin to the target so the two match. Prod (nginx,
      // same host) never hits this.
      "/api": {
        target: "http://localhost:4103",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) =>
            proxyReq.setHeader("origin", "http://localhost:4103"),
          );
        },
      },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
