import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { unzipSync } from 'fflate';
import { chromium } from '@playwright/test';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const target = join(root, 'qa', 'package-test');
const entries = unzipSync(
  readFileSync(join(root, 'release', `bangumi-backlog-v${pkg.version}.zip`)),
);
for (const [name, bytes] of Object.entries(entries)) {
  const path = resolve(target, name);
  if (!path.startsWith(target + sep)) throw new Error('Invalid archive path');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  if (name.startsWith('web/')) {
    const subpath = join(target, 'web', 'subdirectory', name.slice(4));
    mkdirSync(dirname(subpath), { recursive: true });
    writeFileSync(subpath, bytes);
  }
}
const server = spawn(process.execPath, [join(target, 'serve.mjs')], {
  env: { ...process.env, PORT: '4175' },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  server.stdout.once('data', resolve);
  server.once('error', reject);
  server.once('exit', (code) => reject(new Error(`Server exited ${code}`)));
});
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = JSON.parse(readFileSync(join(root, 'tests/e2e/subjects.json'), 'utf8'));
  await page.route('https://api.bgm.tv/**', (route) =>
    route.fulfill({
      json: { data: fixture.data, total: 10 },
      headers: { 'access-control-allow-origin': '*' },
    }),
  );
  await page.goto('http://127.0.0.1:4175/subdirectory/');
  await page.getByRole('button', { name: '稍后连接', exact: true }).click();
  await page.locator('.anime-card').first().waitFor();
  const checks = {
    title: await page.title(),
    cards: await page.locator('.anime-card').count(),
    overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    errors,
  };
  if (checks.cards !== 10 || checks.overflow || errors.length)
    throw new Error(JSON.stringify(checks));
  writeFileSync(join(root, 'qa', 'release-smoke.json'), JSON.stringify(checks, null, 2));
  console.log(JSON.stringify(checks));
} finally {
  if (browser) await browser.close();
  server.kill();
}
