import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('bbm-onboarding-v1', '1'));
  await page.goto('http://127.0.0.1:5173/');
  await page.locator('.series-spotlight').first().waitFor({ timeout: 45000 });
  await page
    .waitForFunction(
      () => [...document.querySelectorAll('.poster img')].slice(0, 5).every((i) => i.complete),
      {},
      { timeout: 15000 },
    )
    .catch(() => {});
  mkdirSync('bangumi-backlog/qa', { recursive: true });
  await page.screenshot({ path: 'bangumi-backlog/qa/series-discovery-live.png' });
  console.log(
    JSON.stringify({
      highlighted: await page.locator('.series-spotlight').count(),
      progress: await page.locator('#series-scan-status').textContent(),
      errors,
    }),
  );
} finally {
  await browser.close();
}
