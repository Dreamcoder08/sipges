import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config.ts';

// Supplemental feature verification on WebKit over the isolated fixture's local HTTP.
// This affects only the synthetic instance, not production or the Secure-cookie suite.
process.env.SIPGES_E2E_COOKIE_SECURE = '0';
export default defineConfig({
  ...base,
  // The *.mobile specs set their own phone viewports: the sticky composer strip of Inicio, the
  // stacked alert inbox (CSS `content` with alternative text) and text that keeps to its box
  // must hold on Safari too. 35, 37 and 38 are the functional-10 walk-through (T11): not-found
  // pages, console errors per screen, and targets, headings, axe and no sideways scroll on every
  // screen at 360, 930 and 1440 px. 40 is Inicio's conversation with the analyst (chat-first-ui
  // T16): thread, stop, new conversation, AI off, 503, the stream's step and the shortcuts.
  testMatch:
    /(?:11-functional-audit|15-record-insights|17-quality-followup|18-territorial-intelligence|33-intelligence-table|35-routes-not-found|37-console-per-screen|38-targets-headings|40-inicio-conversation|focus-not-obscured\.mobile|intelligence-table\.mobile|text-fit\.mobile)\.spec\.ts/,
  outputDir: './test-results/webkit',
  // WebKit has no --host-resolver-rules, so the public map tiles, elevation tiles and cadastre
  // the default config resolves to nothing would be downloaded for real (slow, rate-limited,
  // answered without CORS). A proxy that nothing listens on keeps every host but the suite's own
  // instance offline, without request interception.
  use: {
    ...base.use,
    launchOptions: {},
    proxy: { server: 'http://127.0.0.1:9', bypass: 'localhost,127.0.0.1' },
  },
  projects: [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }],
});
