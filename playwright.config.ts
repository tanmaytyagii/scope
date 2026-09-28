import { defineConfig, devices } from '@playwright/test';

/**
 * Dashboard end-to-end tests. They run against real data: tests/e2e/serve.mjs seeds a project
 * with the CLI and serves it with `scope ui` and `scope server`. Build the dashboard first:
 *
 *   npm run build -w @scope-ai/web && npm run test:e2e
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4799',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: 'node tests/e2e/serve.mjs',
    url: 'http://127.0.0.1:4799/healthz',
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
