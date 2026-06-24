import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      // Exclude the entry shim, type-only declarations, and the third-party-script loader (Stripe.js
      // is mocked in tests; its real network path isn't unit-coverable) from the denominator.
      exclude: ['src/main.tsx', 'src/vite-env.d.ts', 'src/loaders.ts'],
      thresholds: {
        // Master §4 baseline (≥90% line/function/statement) for the SPA's own logic.
        lines: 90,
        functions: 90,
        statements: 90,
        // Branch coverage is held at 80 (documented deviation): the residual uncovered branches are
        // presentational display fallbacks (e.g. `ctx.amount ?? '—'`, status ternaries, empty-list
        // states) in the read views — not logic or security paths. The security-critical login /
        // code-exchange + CSRF logic lives in the backend (test/app/portal*.test.ts +
        // test/adapters/auth/oidc-code-flow.test.ts) and is covered there at the backend gate.
        branches: 80,
      },
    },
  },
});
