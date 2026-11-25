import { defineConfig, devices } from '@playwright/test';

const iPhone = devices['iPhone 13'];

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:43117',
    ...iPhone,
    defaultBrowserType: 'chromium',
    hasTouch: true,
  },
  webServer: {
    command: 'CI=1 npx expo export --platform web && npx --yes serve dist -l tcp://127.0.0.1:43117 --no-clipboard -s',
    url: 'http://127.0.0.1:43117',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
