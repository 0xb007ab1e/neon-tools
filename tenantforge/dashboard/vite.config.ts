import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev server is TAILNET-ONLY by default (loopback); set DASHBOARD_HOST to the host's Tailscale IP
// (e.g. 100.x.y.z) to reach it from a tailnet device. NEVER bind 0.0.0.0 / use Funnel (public).
export default defineConfig({
  root: import.meta.dirname,
  // Served under /dashboard by the control-plane server, so assets are referenced absolutely from
  // there (in dev too: Vite serves the app at http://<host>:5173/dashboard/).
  base: '/dashboard/',
  plugins: [react()],
  server: {
    host: process.env.DASHBOARD_HOST ?? '127.0.0.1',
    port: 5173,
    // The dashboard backend is mounted on the control-plane HTTP server.
    proxy: { '/dashboard/api': process.env.DASHBOARD_API_ORIGIN ?? 'http://127.0.0.1:3000' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
