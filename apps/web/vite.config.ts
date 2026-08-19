// SPDX-License-Identifier: MIT
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// VITE_DEV_PORT/VITE_API_PORT let a scratch dev session run on alternate ports (e.g. to avoid
// colliding with a real docker stack already using 5173/7373) without editing this tracked file
// — export them before `npm run dev` instead. Defaults match the rest of the stack's convention.
const devPort = Number(process.env.VITE_DEV_PORT) || 5173;
const apiPort = Number(process.env.VITE_API_PORT) || 7373;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: devPort,
    proxy: {
      "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true },
      "/health": { target: `http://localhost:${apiPort}`, changeOrigin: true },
    },
  },
});
