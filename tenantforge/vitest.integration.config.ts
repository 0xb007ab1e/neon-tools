import { defineConfig } from 'vitest/config';

// Integration tests hit a live Neon control-plane DB + the Neon API, so they are intentionally NOT
// hermetic and live outside the unit suite/coverage gate. They self-skip when credentials are absent.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['./test/integration/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // These touch one shared control-plane database — run files sequentially to avoid cross-file
    // races on global state (the tenant registry).
    fileParallelism: false,
  },
});
