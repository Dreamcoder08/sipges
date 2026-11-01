import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config.ts';

// Supplemental feature verification on WebKit over the isolated fixture's local HTTP.
// This affects only the synthetic instance, not production or the Secure-cookie suite.
process.env.SIPGES_E2E_COOKIE_SECURE = '0';
export default defineConfig({
  ...base,
  testMatch:
    /(?:11-functional-audit|15-record-insights|17-quality-followup|18-territorial-intelligence)\.spec\.ts/,
  outputDir: './test-results/webkit',
  use: { ...base.use, launchOptions: {} },
  projects: [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }],
});
