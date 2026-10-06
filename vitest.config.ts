import { configDefaults, defineConfig } from 'vitest/config';

// Unit, contract and offline e2e tests. The real-property e2e test is opt-in
// and runs only through vitest.e2e.config.ts.
//
// Several suites do real work: disk writes with fsync, SQLite, thousands of bootstrap replicates
// and null-series simulations (changepoint test 29). Under a full parallel run on a busy machine
// they can pass 5 s, Vitest's default, so the limit is 60 s per test and per hook. A test that
// truly hangs still fails, just later.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/e2e/seoengico.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
