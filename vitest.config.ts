import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'test/unit/**/*.test.ts',
            'test/integration/**/*.test.ts',
            'test/verify/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          // Checks on a real astro dev server (make test-dev).
          // Tests run in order and share one server
          name: 'dev',
          include: ['test/dev/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          // Installs the published tarball into an empty project (make e2e-pack)
          name: 'pack',
          include: ['test/pack/**/*.test.ts'],
          testTimeout: 600_000,
          hookTimeout: 600_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          // Longer, because astro build runs in a child process
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
