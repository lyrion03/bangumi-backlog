import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const target = join(root, 'qa', 'go-package-test');
const entries = unzipSync(
  readFileSync(join(root, 'release', 'bangumi-backlog-v' + version + '-windows-x64.zip')),
);
assert.deepEqual(Object.keys(entries).sort(), ['README.md', 'bangumi-backlog.exe']);
for (const [name, bytes] of Object.entries(entries)) {
  const path = resolve(target, name);
  if (!path.startsWith(target + sep)) throw Error('Invalid archive path');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}
const exe = join(target, 'bangumi-backlog.exe');
const bytes = readFileSync(exe),
  pe = bytes.readUInt32LE(0x3c);
assert.equal(bytes.readUInt16LE(pe + 4), 0x8664);
assert.equal(bytes.readUInt16LE(pe + 24 + 68), 2, 'must be Windows GUI, with no console');
const port = '4175',
  url = 'http://127.0.0.1:' + port;
// Deliberately remove Node and Go from PATH: the shipped executable must stand alone.
const env = { ...process.env, PORT: port, PATH: join(process.env.SystemRoot, 'System32') };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const exited = (child) =>
  new Promise((resolve, reject) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', reject);
  });
async function start() {
  const child = spawn(exe, ['--no-open'], { env, cwd: target, windowsHide: true, stdio: 'ignore' });
  const exit = exited(child);
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(url + '/__backlog/status');
      const data = await res.json();
      if (data.app === 'bangumi-backlog' && data.version === version) return { child, exit };
    } catch {}
    await wait(100);
  }
  child.kill();
  throw Error('Launcher not ready');
}
async function stop(server) {
  spawnSync(exe, ['--quit'], { env, windowsHide: true, timeout: 5000 });
  const code = await Promise.race([
    server.exit,
    wait(5000).then(() => {
      throw Error('Tray exit timed out');
    }),
  ]);
  assert.equal(code, 0);
}
let server, browser;
try {
  server = await start();
  const duplicate = spawn(exe, ['--no-open'], { env, windowsHide: true, stdio: 'ignore' });
  assert.equal(
    await Promise.race([
      exited(duplicate),
      wait(5000).then(() => {
        throw Error('Duplicate hung');
      }),
    ]),
    0,
  );
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = JSON.parse(readFileSync(join(root, 'tests/e2e/subjects.json'), 'utf8'));
  await page.route('https://api.bgm.tv/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/subjects') && path != '/v0/search/subjects')
      return route.fulfill({ json: [] });
    return route.fulfill({
      json: { data: fixture.data, total: 10 },
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  await page.goto(url + '/#records');
  await page.getByRole('button', { name: '稍后连接', exact: true }).click();
  const seeded = await page.evaluate((subject) => {
    const state = {
      version: 1,
      preferencesVersion: 2,
      owner: null,
      items: {
        [subject.id]: {
          ...subject,
          status: 'doing',
          dirty: false,
          episodeMarks: { 501: { type: 3, markedAt: 1700000000000 } },
          episodeChanges: {},
        },
      },
      settings: { realtime: false, completeEpisodes: true, autoNext: false },
    };
    const values = {
      'bangumi-batch-marker-v1': JSON.stringify(state),
      'bbm-series-cache-v5': JSON.stringify({
        version: 1,
        records: [{ scope: 'public', id: subject.id, at: Date.now(), hint: false }],
      }),
      'bbm-radar-data-v1': JSON.stringify([
        ['user-100:registered', { at: Date.now(), data: '2012-01-01' }],
      ]),
      'bbm-episode-snapshots-v1': JSON.stringify([['100:51', { at: Date.now(), rows: [] }]]),
    };
    for (const [k, v] of Object.entries(values)) localStorage.setItem(k, v);
    return values;
  }, fixture.data[0]);
  await page.reload();
  await page.locator('.record-row').first().waitFor();
  const before = await page.evaluate(
    (keys) => Object.fromEntries(keys.map((k) => [k, localStorage.getItem(k)])),
    Object.keys(seeded),
  );
  assert.deepEqual(before, seeded);
  await stop(server);
  server = await start();
  await page.reload();
  await page.locator('.record-row').first().waitFor();
  const after = await page.evaluate(
    (keys) => Object.fromEntries(keys.map((k) => [k, localStorage.getItem(k)])),
    Object.keys(seeded),
  );
  assert.deepEqual(after, seeded);
  // Empty records exercise rendering without depending on a real Bangumi account or changing one.
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('bangumi-batch-marker-v1'));
    state.items = {};
    localStorage.setItem('bangumi-batch-marker-v1', JSON.stringify(state));
  });
  await page.reload();
  await page.getByRole('button', { name: '图一乐雷达图' }).click();
  await page.locator('.radar-chart svg').waitFor();
  assert.equal(await page.locator('.radar-axis').count(), 6);
  const invalid = await fetch(url + '/__bangumi/registration/invalid');
  assert.equal(invalid.status, 400);
  const blocked = await fetch(url + '/', { headers: { Origin: 'https://example.com' } });
  assert.equal(blocked.status, 403);
  assert.equal(errors.length, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const checks = {
    version,
    standalone: true,
    guiSubsystem: true,
    duplicate: true,
    trayExit: true,
    recordAndCacheRetention: true,
    radar: 6,
    errors,
  };
  writeFileSync(join(root, 'qa', 'release-smoke.json'), JSON.stringify(checks, null, 2));
  console.log(JSON.stringify(checks));
} finally {
  if (browser) await browser.close();
  if (server) await stop(server).catch(() => server.child.kill());
}
