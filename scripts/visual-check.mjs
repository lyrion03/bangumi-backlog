import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto('http://127.0.0.1:5173/');
await page.locator('.anime-card').first().waitFor({ timeout: 30000 });
await page
  .waitForFunction(
    () => [...document.querySelectorAll('.poster img')].slice(0, 5).every((img) => img.complete),
    {},
    { timeout: 20000 },
  )
  .catch(() => {});
await page.evaluate(() => scrollTo(0, 0));
mkdirSync('bangumi-backlog/qa', { recursive: true });
await page.screenshot({ path: 'bangumi-backlog/qa/desktop-live.png' });
console.log(
  JSON.stringify(
    await page.evaluate(() => ({
      cards: document.querySelectorAll('.anime-card').length,
      loaded: [...document.querySelectorAll('.poster img')].filter(
        (i) => i.complete && i.naturalWidth > 0,
      ).length,
      sidebarTop: document.querySelector('.sidebar').getBoundingClientRect().top,
      scrollY,
      overflow: document.documentElement.scrollWidth > innerWidth,
    })),
    null,
    2,
  ),
);
await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => scrollTo(0, 0));
await page.screenshot({ path: 'bangumi-backlog/qa/mobile-live.png' });
await page.locator('.nav-item[data-view="sync"]').click();
await page.screenshot({ path: 'bangumi-backlog/qa/sync-mobile.png', fullPage: true });
writeFileSync('bangumi-backlog/qa/browser-errors.json', JSON.stringify(errors, null, 2));
await browser.close();
