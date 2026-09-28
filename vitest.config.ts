import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources (see docs/decisions/0001).
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/server/src/**/*.test.ts',
      'apps/web/src/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 20_000,
    // Tests create temporary directories and databases; keep output quiet unless debugging.
    silent: 'passed-only',
  },
});
