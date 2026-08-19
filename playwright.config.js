import { defineConfig, devices } from '@playwright/test';

/**
 * Breakpoints are a test axis rather than a stylesheet detail.
 *
 * The whole suite runs at every width, so the narrow layout cannot quietly rot
 * while someone develops against a desktop window. 360 is the narrow Android
 * floor, 390 an iPhone, 768 a tablet, 1280 a laptop.
 */
const VIEWPORTS = {
  'mobile-360': { width: 360, height: 780 },
  'mobile-390': { width: 390, height: 844 },
  'tablet-768': { width: 768, height: 1024 },
  'desktop-1280': { width: 1280, height: 900 },
};

/**
 * Point the suite at a deployed site with MACSMITH_BASE_URL to smoke-test what
 * users actually get, rather than what the local files say they should get:
 *
 *   MACSMITH_BASE_URL=https://stewalexander-com.github.io/macsmith npx playwright test
 */
const LOCAL_URL = 'http://127.0.0.1:8791';
const BASE_URL = process.env.MACSMITH_BASE_URL || LOCAL_URL;
const isRemote = BASE_URL !== LOCAL_URL;

export default defineConfig({
  testDir: './tests/web',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI || isRemote ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Needed to assert that the copy buttons actually reach the clipboard.
    permissions: ['clipboard-read', 'clipboard-write'],
  },

  projects: Object.entries(VIEWPORTS).map(([name, viewport]) => ({
    name,
    use: { ...devices['Desktop Chrome'], viewport, isMobile: false },
  })),

  // No local server needed when testing a deployed site.
  webServer: isRemote ? undefined : {
    command: 'python3 -m http.server 8791 --directory web',
    url: `${LOCAL_URL}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});

export { BASE_URL, VIEWPORTS };
