import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      // Exclude composition roots / entrypoints (thin imperative shell wiring) and
      // type-only declarations (ports, domain types) from the coverage denominator —
      // they transpile to no executable code.
      exclude: [
        'src/app/**',
        'src/ports/**',
        'src/core/domain.ts',
        'src/**/index.ts', // barrel re-exports: no executable logic
        'src/**/*.d.ts',
        // I/O adapters (the imperative shell): validated by the integration test (task #7),
        // not unit coverage. Pure helpers (e.g. serde) stay in the unit denominator.
        'src/adapters/neon-pg/vector-store.ts',
        'src/adapters/ai-gateway/**',
        'src/adapters/loaders/**',
      ],
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
