import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    // .ts (pure api client tests) + .tsx (React view/state tests).
    include: ['test/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      // Exclude the entry shim, type-only declarations, and the third-party-script loader (Stripe.js
      // + Cloudflare Turnstile are loaded from THEIR domains via injected <script> tags and mocked in
      // tests; the real network path isn't unit-coverable) from the denominator — mirrors portal.
      exclude: ['src/main.tsx', 'src/vite-env.d.ts', 'src/loaders.ts'],
      thresholds: {
        // Master §4 baseline (≥90% line/function/statement) for the SPA's own logic.
        lines: 90,
        functions: 90,
        statements: 90,
        // Branch coverage is held at 80 (documented deviation, same floor as the portal SPA): the
        // residual uncovered branches are presentational `&&` step guards in the JSX render tree (the
        // wizard only ever shows one step at a time, so the inactive-step short-circuits and the
        // `busy && <spinner/>` fallbacks can't all be exercised from a single mounted view) plus the
        // step-heading focus null-guard. None are logic or security paths — the security-critical
        // signup funnel (captcha verification, email-code exchange, payment intent, slug/region
        // re-validation) is enforced server-side and covered at the backend gate
        // (test/app/signup*.test.ts).
        branches: 80,
      },
    },
  },
});
