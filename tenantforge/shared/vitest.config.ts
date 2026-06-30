import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Dedicated suite + coverage gate for the shared design system (shared/ui/*), which is reused
// across all three SPAs (portal, dashboard, signup). It lives outside any single SPA root, so it
// needs its own root for v8 to instrument it — a per-SPA coverage config (rooted at portal/ or
// dashboard/) cannot see files above its root and would silently drop shared/ui from the
// denominator (a coverage blind spot). Rooted here, shared/ui is the coverage subject.
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
      include: ['ui/**'],
      // Barrel re-exports and type-only declarations transpile to no executable code.
      exclude: ['ui/index.ts', 'ui/types.ts'],
      thresholds: {
        // Enforce the baseline PER FILE (not just the aggregate): a regression isolated to one
        // small component would otherwise be masked by the high coverage of its neighbours. Each
        // shared/ui component must independently meet the bar.
        perFile: true,
        // Master §4 baseline (≥90% line + branch + function + statement). The shared design system
        // is presentational and prop-driven — it holds no app/business logic and makes no security
        // decision (the client is untrusted; authZ/CSRF/tenant scoping stay server-side). So there
        // is NO 100%-critical path here; the 90% baseline applies (not claimed 100%-critical).
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
