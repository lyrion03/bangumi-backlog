import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const out = 'bangumi-backlog/qa';
mkdirSync(out, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:5173/');
  await page.getByRole('dialog').waitFor();
  await page.screenshot({ path: `${out}/onboarding-desktop.png` });
  await page.getByRole('button', { name: '前往同步中心' }).click();
  await page.screenshot({ path: `${out}/account-sidebar-sync.png` });
  await page.locator('.nav-item[data-view="discover"]').click();
  await page.locator('.anime-card').first().waitFor({ timeout: 45000 });
  await page.waitForFunction(
    () =>
      /关联缓存|已缓存|预计算完成/.test(
        document.querySelector('#series-scan-status')?.textContent || '',
      ),
    {},
    { timeout: 60000 },
  );
  await page.screenshot({ path: `${out}/series-priority-desktop.png` });
  const status = await page.locator('#series-scan-status').textContent();
  const hints = await page.locator('.series-spotlight').count();
  const cached = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('bbm-series-cache-v1') || '{}').records?.filter(
        (r) => r.result,
      ).length || 0,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-select]').first().check();
  await page.screenshot({ path: `${out}/account-mobile-batch.png` });
  const box = await page.locator('#account-chip').boundingBox();
  const batch = await page.locator('#batch-bar').boundingBox();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  const report = {
    status,
    hints,
    cached,
    mobileAccountBox: box,
    mobileBatchBox: batch,
    overflow,
    errors,
  };
  writeFileSync(`${out}/onboarding-series-check.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (errors.length || overflow || box.y + box.height > batch.y)
    throw Error('Visual layout regression');
} finally {
  await browser.close();
}
