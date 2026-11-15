import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config.ts';

// Supplemental feature verification on WebKit over the isolated fixture's local HTTP.
// This affects only the synthetic instance, not production or the Secure-cookie suite.
process.env.SIPGES_E2E_COOKIE_SECURE = '0';
export default defineConfig({
  ...base,
  // The last three set their own phone viewports: the sticky composer strip of Inicio and the
  // stacked alert inbox (CSS `content` with alternative text) must hold on Safari too.
  testMatch:
    /(?:11-functional-audit|15-record-insights|17-quality-followup|18-territorial-intelligence|33-intelligence-table|focus-not-obscured\.mobile|intelligence-table\.mobile)\.spec\.ts/,
  outputDir: './test-results/webkit',
  use: { ...base.use, launchOptions: {} },
  projects: [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }],
});
