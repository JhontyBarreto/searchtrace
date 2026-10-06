import { defineConfig } from 'vitest/config';

// End-to-end tests only. test/e2e/seoengico.test.ts talks to real APIs and
// skips itself unless SEARCHTRACE_E2E=1 is set.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
