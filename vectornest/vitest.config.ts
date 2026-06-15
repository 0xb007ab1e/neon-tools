import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      // Exclude composition roots / entrypoints (thin imperative shell wiring) and
      // type-only port declarations from the coverage denominator.
      exclude: ['src/app/**', 'src/ports/**', 'src/**/*.d.ts'],
      thresholds: {
        // Master §4 baseline (≥90% line + branch elsewhere).
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
        // Critical path: the pure core (chunking, ranking, swap state machine,
        // model registry) is enforced at 100%.
        'src/core/**': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
      },
    },
  },
});
