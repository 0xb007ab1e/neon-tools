import { defineConfig } from 'vitest/config';

// Integration tests hit live Neon + the embeddings endpoint, so they are intentionally NOT hermetic and
// live outside the unit suite/coverage gate. They self-skip when credentials are absent.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['./test/integration/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
