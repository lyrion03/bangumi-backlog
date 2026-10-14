import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const folder = 'bangumi-backlog-v' + version + '-windows-x64';
const target = join(root, 'qa', 'package-' + version + '-' + Date.now());
const entries = unzipSync(readFileSync(join(root, 'release', folder + '.zip')));
assert.deepEqual(Object.keys(entries).sort(), [
  folder + '/README.md',
  folder + '/bangumi-backlog.exe',
  folder + '/data/',
]);
for (const [name, bytes] of Object.entries(entries)) {
  const path = resolve(target, name);
  if (!path.startsWith(target + sep)) throw Error('Invalid archive path');
  if (name.endsWith('/')) mkdirSync(path, { recursive: true });
  else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
}
const appDir = join(target, folder),
  exe = join(appDir, 'bangumi-backlog.exe');
const diskPath = join(appDir, 'data', 'browser-cache.json');
assert.equal(existsSync(diskPath), false, 'release must not contain user data');
const bytes = readFileSync(exe),
  pe = bytes.readUInt32LE(0x3c);
assert.equal(bytes.readUInt16LE(pe + 4), 0x8664);
assert.equal(bytes.readUInt16LE(pe + 24 + 68), 2, 'must be Windows GUI, with no console');
const port = '4175',
  url = 'http://127.0.0.1:' + port;
// The executable must work without Node or Go, even when launched from a different directory.
const env = { ...process.env, PORT: port, PATH: join(process.env.SystemRoot, 'System32') };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const exited = (child) =>
  new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
async function until(check, message, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await check()) return;
    } catch {}
    await wait(100);
  }
  throw Error(message);
}
async function start() {
  const child = spawn(exe, ['--no-open'], { env, cwd: target, windowsHide: true, stdio: 'ignore' });
  const exit = exited(child);
  try {
    await until(
      async () => {
        const data = await (await fetch(url + '/__backlog/status')).json();
        return data.app === 'bangumi-backlog' && data.version === version;
      },
      'Launcher not ready',
      5000,
    );
    return { child, exit };
  } catch (error) {
    child.kill();
    throw error;
  }
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
const fixture = JSON.parse(readFileSync(join(root, 'tests/e2e/subjects.json'), 'utf8'));
const RECORDS = 'bangumi-batch-marker-v1',
  SERIES = 'bbm-series-cache-v5',
  RADAR = 'bbm-radar-data-v1',
  EPISODES = 'bbm-episode-snapshots-v1';
const state = (owner, items) => ({
  version: 1,
  preferencesVersion: 2,
  owner,
  account: owner ? { id: owner, username: 'test-' + owner, nickname: '测试用户' } : null,
  items,
  settings: { realtime: false, completeEpisodes: true, autoNext: false },
});
const subject = fixture.data[0];
const item = {
  ...subject,
  status: 'doing',
  dirty: false,
  markedAt: 1700000000000,
  episodeMarks: { 501: { type: 3, markedAt: 1700000000001 } },
  episodeChanges: {},
};
const seeded = {
  [RECORDS]: JSON.stringify(state(42, { [subject.id]: item })),
  [SERIES]: JSON.stringify({
    version: 1,
    records: [{ scope: 'public', id: subject.id, at: Date.now(), hint: false }],
  }),
  [RADAR]: JSON.stringify([['user-42:registered', { at: Date.now(), data: '2012-01-01' }]]),
  [EPISODES]: JSON.stringify([['42:' + subject.id, { at: Date.now(), rows: [] }]]),
};
const errors = [];
let server, browser;
async function open(values) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('https://api.bgm.tv/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json:
        path.endsWith('/subjects') && path !== '/v0/search/subjects'
          ? []
          : { data: fixture.data, total: 10 },
    });
  });
  await context.route('https://lain.bgm.tv/**', (route) => route.abort());
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  if (values)
    await page.addInitScript((values) => {
      if (!sessionStorage.getItem('test-seeded')) {
        for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
        localStorage.setItem('bbm-onboarding-v1', '1');
        sessionStorage.setItem('test-seeded', '1');
      }
    }, values);
  await page.goto(url + '/#records');
  await page.locator('#records').waitFor();
  return { page, context };
}
const browserValues = (page) =>
  page.evaluate(
    (keys) => Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])),
    Object.keys(seeded),
  );
const diskFile = () => JSON.parse(readFileSync(diskPath, 'utf8'));
function compareValues(actual, expected) {
  for (const key of Object.keys(expected))
    assert.deepEqual(JSON.parse(actual[key]), JSON.parse(expected[key]), key);
}
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
  let { page, context } = await open(seeded);
  await page.locator('.record-row').first().waitFor();
  // Test credentials never reach disk, without attempting a login or contacting a real account.
  await page.evaluate(() => localStorage.setItem('bbm-token', 'private-test-token'));
  await until(
    () => diskFile().profiles['user-42']?.values[RECORDS] === seeded[RECORDS],
    'Periodic save did not reach executable directory',
  );
  compareValues(diskFile().profiles['user-42'].values, seeded);
  assert.equal(readFileSync(diskPath, 'utf8').includes('private-test-token'), false);
  const savedAt = diskFile().profiles['user-42'].updatedAt;
  await wait(5500);
  assert.equal(
    diskFile().profiles['user-42'].updatedAt,
    savedAt,
    'unchanged data should not write again',
  );
  compareValues(await browserValues(page), seeded);
  // Keep this browser open across a launcher restart, then make a real UI change.
  await stop(server);
  server = await start();
  await page.evaluate(() => {
    localStorage.removeItem('bbm-token');
    location.hash = 'sync';
  });
  await page.locator('#complete-episodes').uncheck();
  await until(
    () =>
      JSON.parse(diskFile().profiles['user-42'].values[RECORDS]).settings.completeEpisodes ===
      false,
    'Live tab failed to recover after launcher restart',
  );
  const updated = diskFile().profiles['user-42'].values;
  assert.equal(
    JSON.parse(updated[RECORDS]).items[subject.id].episodeMarks[501].markedAt,
    1700000000001,
  );
  await context.close();

  ({ page, context } = await open());
  await page.locator('.record-row').first().waitFor();
  compareValues(await browserValues(page), updated);
  assert.equal(await page.evaluate(() => localStorage.getItem('bbm-token')), null);
  assert.equal(await page.getByRole('button', { name: '稍后连接', exact: true }).count(), 0);
  await context.close();

  // An existing empty state/cache wins; only the missing episode cache is restored.
  const empty = {
    [RECORDS]: JSON.stringify(state(42, {})),
    [SERIES]: '{"version":1,"records":[]}',
    [RADAR]: '[]',
  };
  ({ page, context } = await open(empty));
  compareValues(await browserValues(page), { ...empty, [EPISODES]: updated[EPISODES] });
  assert.equal(await page.locator('.record-row').count(), 0);
  await until(
    () => diskFile().profiles['user-42'].values[RECORDS] === empty[RECORDS],
    'Intentional empty records were not saved',
  );
  await context.close();
  ({ page, context } = await open());
  assert.equal(await page.locator('.record-row').count(), 0);
  assert.deepEqual(JSON.parse((await browserValues(page))[RECORDS]).items, {});
  await context.close();

  const second = {
    [RECORDS]: JSON.stringify(state(90, { [subject.id]: { ...item, status: 'wish' } })),
  };
  ({ page, context } = await open(second));
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), EPISODES),
    null,
    'another account cache was restored',
  );
  await until(() => diskFile().active === 'user-90', 'Second account was not saved');
  assert.deepEqual(JSON.parse(diskFile().profiles['user-42'].values[RECORDS]).items, {});
  await context.close();
  ({ page, context } = await open());
  assert.equal(JSON.parse((await browserValues(page))[RECORDS]).owner, 90);
  await context.close();

  ({ page, context } = await open({ [RECORDS]: JSON.stringify(state(null, {})) }));
  await page.getByRole('button', { name: '图一乐雷达图' }).click();
  await page.locator('.radar-chart svg').waitFor();
  assert.equal(await page.locator('.radar-axis').count(), 6);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const invalid = await fetch(url + '/__bangumi/registration/invalid');
  assert.equal(invalid.status, 400);
  assert.equal(
    (await fetch(url + '/__backlog/data', { headers: { Origin: 'https://example.com' } })).status,
    403,
  );
  assert.equal((await fetch(url + '/data/browser-cache.json')).status, 404);
  assert.deepEqual(errors, []);
  const checks = {
    version,
    standalone: true,
    guiSubsystem: true,
    duplicate: true,
    trayExit: true,
    nestedReleaseFolder: true,
    emptyDataFolder: true,
    periodicSave: true,
    unchangedNoWrite: true,
    browserPriority: true,
    automaticRestore: true,
    accountIsolation: true,
    restartLiveTab: true,
    tokenExcluded: true,
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
