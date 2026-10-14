import { defineConfig } from '@playwright/test';
const packaged = process.env.BACKLOG_PACKAGED === '1';
const baseURL = packaged ? 'http://127.0.0.1:4176' : 'http://127.0.0.1:5173';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  fullyParallel: true,
  workers: 2,
  use: {
    baseURL,
    browserName: 'chromium',
    channel: process.env.CI ? undefined : 'msedge',
    headless: true,
    viewport: { width: 1440, height: 1100 },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: packaged ? 'node scripts/launcher-test-server.mjs' : 'npm run dev',
    url: baseURL,
    reuseExistingServer: !packaged && !process.env.CI,
  },
  reporter: [['list']],
});
