import { defineConfig } from 'vitest/config';

// Integration tests hit live Neon + the embeddings endpoint, so they are intentionally NOT hermetic and
// live outside the unit suite/coverage gate. They self-skip when credentials are absent.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['./test/integration/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // These hit one shared live database — run files sequentially to avoid cross-file races
    // on global state (active model, registered models).
    fileParallelism: false,
  },
});
