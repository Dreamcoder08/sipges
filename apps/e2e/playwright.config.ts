import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end parity suite (ODD T14, specs S3/S7). One synthetic MASCLI instance is started by
 * global-setup.ts; specs share it, so they run in one worker in file order.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'es-PE',
    timezoneId: 'America/Lima',
    // Tests never download public OSM tiles. Resolving the host to nothing keeps request
    // interception off, which would report the SPA's manual 303 fetches as aborted.
    launchOptions: { args: ['--host-resolver-rules=MAP tile.openstreetmap.org ~NOTFOUND'] },
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /mobile\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
  ],
});
