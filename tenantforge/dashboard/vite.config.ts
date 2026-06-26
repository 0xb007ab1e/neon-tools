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
    // Vite blocks non-local Host headers by default (anti-DNS-rebinding). Allow the tailnet
    // MagicDNS host(s) when fronted by Tailscale HTTPS via DASHBOARD_ALLOWED_HOSTS (comma-separated;
    // a leading-dot entry like ".ts.net" allows that domain + subdomains). Unset = local only.
    ...(process.env.DASHBOARD_ALLOWED_HOSTS !== undefined
      ? { allowedHosts: process.env.DASHBOARD_ALLOWED_HOSTS.split(',') }
      : {}),
    // The dashboard backend is mounted on the control-plane HTTP server.
    proxy: { '/dashboard/api': process.env.DASHBOARD_API_ORIGIN ?? 'http://127.0.0.1:3000' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
