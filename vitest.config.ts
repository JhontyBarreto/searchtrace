import { configDefaults, defineConfig } from 'vitest/config';

// Unit, contract and offline e2e tests. The real-property e2e test is opt-in
// and runs only through vitest.e2e.config.ts.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/e2e/seoengico.test.ts'],
    environment: 'node',
  },
});
