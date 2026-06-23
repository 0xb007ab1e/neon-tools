import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev server is TAILNET-ONLY by default (loopback); set SIGNUP_HOST to the host's Tailscale IP to
// reach it from a tailnet device. NEVER bind 0.0.0.0 / use Funnel (public).
export default defineConfig({
  root: import.meta.dirname,
  // Served under /signup by the control-plane server, so assets are referenced absolutely from there
  // (in dev too: Vite serves the app at http://<host>:5174/signup/).
  base: '/signup/',
  plugins: [react()],
  server: {
    host: process.env.SIGNUP_HOST ?? '127.0.0.1',
    port: 5174,
    // The signup backend is mounted on the control-plane HTTP server.
    proxy: { '/signup/api': process.env.SIGNUP_API_ORIGIN ?? 'http://127.0.0.1:3000' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
