import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built files go to ../web, which the Python server serves. Users never need Node.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "../web", emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:7865", changeOrigin: true } } },
});
