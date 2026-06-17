import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests are non-hermetic (live Neon control-plane DB + Neon API); run via test:int.
    exclude: [...configDefaults.exclude, 'test/integration/**'],
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
        // I/O adapters (the imperative shell): validated by the integration suite,
        // not unit coverage. Pure helpers (response schemas) stay in the denominator.
        'src/adapters/neon-api/**',
        'src/adapters/neon-pg/**',
      ],
      thresholds: {
        // Master §4 baseline (≥90% line + branch elsewhere).
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
        // Critical path: the pure core (slug/region validation, lifecycle state machine,
        // fleet-migration planner) is enforced at 100% — tenant isolation correctness.
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
