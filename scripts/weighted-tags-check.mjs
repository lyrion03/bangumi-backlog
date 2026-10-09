import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('bbm-onboarding-v1', '1'));
  await page.goto('http://127.0.0.1:5173/');
  await page.locator('.anime-card').first().waitFor();
  const before = await page.locator('.anime-card').count();
  const response = page.waitForResponse((r) => r.url().includes('/search/subjects'));
  await page.getByRole('button', { name: '屏蔽恋爱', exact: true }).click();
  await response;
  await page.locator('.anime-card').first().waitFor();
  const after = await page.locator('.anime-card').count();
  await page.locator('.series-spotlight').first().waitFor();
  await page.locator('.dismiss').first().hover();
  await page.screenshot({ path: 'bangumi-backlog/qa/weighted-tags-live.png' });
  console.log(
    JSON.stringify({
      before,
      after,
      lowerSeries: await page.locator('.card-meta [data-action="series"]').count(),
      initialMarked: await page.locator('.quick-actions .marked').count(),
      errors,
    }),
  );
  if (!after || errors.length) throw new Error('Live verification failed');
} finally {
  await browser.close();
}
