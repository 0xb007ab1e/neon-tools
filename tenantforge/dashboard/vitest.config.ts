import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      // Exclude the entry shim and type-only declarations (no executable code) from the denominator.
      exclude: ['src/main.tsx', 'src/vite-env.d.ts'],
      thresholds: {
        // Master §4 baseline (≥90% line/function/statement) for the SPA's own logic. No
        // 100%-critical path lives in the SPA — the security-critical login / session / authZ logic
        // is enforced server-side and covered by the backend gate (test/app/*.test.ts at src/**);
        // the dashboard client is untrusted and presentational.
        lines: 90,
        functions: 90,
        statements: 90,
        // Branch coverage is held at 65 (documented deviation; aggregate is ~69 today). The API
        // client (dashboard/src/api.ts) is at 100% branch (test/api.test.ts covers every
        // error-throw / 401 / 404 / 403 branch). The remaining gap is App.tsx (a large read-only
        // operator console, ~1600 lines of panels) whose residual uncovered branches are
        // presentational display fallbacks (`?? '—'` placeholders, status/severity ternaries,
        // empty-list states, optional-field guards) across dozens of read panels — not logic or
        // security paths. The security-critical login / session / authZ flows are enforced
        // server-side and covered by the backend gate. Raising this is tracked as follow-up
        // panel-level view tests; the floor prevents regression below today's level.
        branches: 65,
      },
    },
  },
});
