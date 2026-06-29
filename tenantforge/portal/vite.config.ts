import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev server is TAILNET-ONLY by default (loopback); set PORTAL_HOST to the host's Tailscale IP
// (e.g. 100.x.y.z) to reach it from a tailnet device. NEVER bind 0.0.0.0 / use Funnel (public).
export default defineConfig({
  root: import.meta.dirname,
  // Served under /portal by the control-plane server, so assets are referenced absolutely from there
  // (in dev too: Vite serves the app at http://<host>:5175/portal/).
  base: '/portal/',
  plugins: [react()],
  server: {
    host: process.env.PORTAL_HOST ?? '127.0.0.1',
    port: 5175,
    // Vite blocks non-local Host headers by default (anti-DNS-rebinding). Allow the tailnet
    // MagicDNS host(s) when fronted by Tailscale HTTPS (e.g. https://<host>.<tailnet>.ts.net/portal/)
    // via PORTAL_ALLOWED_HOSTS (comma-separated; a leading-dot entry like ".ts.net" allows that
    // domain + subdomains). Unset = default (local only); never use this to expose publicly.
    ...(process.env.PORTAL_ALLOWED_HOSTS !== undefined
      ? { allowedHosts: process.env.PORTAL_ALLOWED_HOSTS.split(',') }
      : {}),
    // The portal backend is mounted on the control-plane HTTP server.
    proxy: { '/portal/api': process.env.PORTAL_API_ORIGIN ?? 'http://127.0.0.1:3000' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
