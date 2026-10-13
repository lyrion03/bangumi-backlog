import { test, expect, type Page } from '@playwright/test';
import fixtures from '../fixtures/radar-subjects.json' with { type: 'json' };
const subjects = [51, 237, 321, 211311, 207195, 93739].map((id) =>
  fixtures.subjects.find((s) => s.id === id)!,
);
async function setup(page: Page, slow = false) {
  const state = {
    version: 1,
    preferencesVersion: 2,
    owner: 100,
    account: { id: 100, username: 'testuser', nickname: '测试用户' },
    settings: { realtime: false, completeEpisodes: true, autoNext: false },
    items: Object.fromEntries(
      subjects.map((s, i) => [
        s.id,
        {
          ...s,
          status: i === 3 ? 'dropped' : 'collect',
          dirty: false,
          episodeMarks: {},
          episodeChanges: {},
          updatedAt: 100 + i,
        },
      ]),
    ),
  };
  await page.addInitScript((state) => {
    localStorage.setItem('bbm-onboarding-v1', '1');
    if (!localStorage.getItem('bangumi-batch-marker-v1'))
      localStorage.setItem('bangumi-batch-marker-v1', JSON.stringify(state));
  }, state);
  const calls: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let release = () => {};
  await page.route('**/__bangumi/registration/*', (route) => {
    calls.push('registration');
    return route.fulfill({ json: { id: 100, registered: '2012-06-01' } });
  });
  await page.route('https://api.bgm.tv/**', async (route) => {
    const req = route.request(),
      u = new URL(req.url()),
      path = u.pathname;
    const respond = (data: unknown, status = 200) =>
      route.fulfill({ status, json: data, headers: { 'access-control-allow-origin': '*' } });
    if (req.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'GET,POST,PATCH',
        },
      });
    if (path === '/v0/search/subjects' || path === '/v0/subjects')
      return respond({ data: [], total: 0 });
    calls.push(req.method() + ' ' + path);
    if (/^\/v0\/subjects\/\d+$/.test(path)) {
      if (slow) {
        slow = false;
        await new Promise<void>((resolve) => (release = resolve));
      }
      const id = Number(path.split('/').pop());
      return respond({
        ...subjects.find((s) => s.id === id),
        eps: 12,
        infobox: [{ key: '放送结束', value: '2020年1月1日' }],
      });
    }
    if (path === '/v0/episodes')
      return respond({
        data: Array.from({ length: 12 }, (_, i) => ({
          id: Number(u.searchParams.get('subject_id')) * 100 + i,
          type: 0,
          sort: i + 1,
          ep: i + 1,
          airdate: '2020-01-01',
          duration: '00:24:00',
        })),
        total: 12,
      });
    if (path.endsWith('/subjects') || path.endsWith('/characters')) return respond([]);
    return respond({ data: [], total: 0 });
  });
  await page.goto('/#records');
  await expect(page.locator('.record-row')).toHaveCount(6);
  return { calls, errors, release: () => release() };
}
test('radar is click-only, renders six dimensions with tooltips, and reuses caches across reloads', async ({
  page,
}) => {
  const { calls, errors } = await setup(page);
  const before = await page.evaluate(() => localStorage.getItem('bangumi-batch-marker-v1'));
  expect(calls).toEqual([]);
  expect(
    await page.evaluate(() =>
      performance.getEntriesByType('resource').some((x) => x.name.includes('radar-view')),
    ),
  ).toBe(false);
  await page.getByRole('button', { name: '图一乐雷达图' }).click();
  await expect(page.locator('.radar-axis')).toHaveCount(6, { timeout: 20000 });
  await expect(page.locator('.radar-chart svg')).toHaveAttribute(
    'aria-label',
    /老资历.*婆罗门.*小众.*猎奇.*完坑.*现充/,
  );
  await expect(page.locator('.radar-facts')).toContainText('2012-06-01');
  await page.locator('.radar-help').nth(4).hover();
  await expect(page.locator('#radar-tip-4')).toBeVisible();
  await expect(page.locator('#radar-tip-4')).toContainText('SP');
  await page.mouse.move(10, 10);
  await page.screenshot({ path: 'qa/radar-desktop.png', fullPage: true });
  const count = calls.length;
  expect(count).toBeGreaterThan(10);
  const scores = await page.locator('.radar-axis strong').allTextContents();
  expect(scores.every((s) => /^\d+$/.test(s) && Number(s) <= 100)).toBe(true);
  expect(calls.every((s) => s === 'registration' || s.startsWith('GET '))).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('bangumi-batch-marker-v1'))).toBe(before);
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '图一乐雷达图' }).click();
  await expect(page.locator('.radar-axis')).toHaveCount(6);
  expect(await page.locator('.radar-axis strong').allTextContents()).toEqual(scores);
  expect(calls.length).toBe(count);
  expect(errors).toEqual([]);
});
test('radar fits a narrow phone and tooltip stays inside its viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await setup(page);
  await page.getByRole('button', { name: '图一乐雷达图' }).click();
  await expect(page.locator('.radar-axis')).toHaveCount(6, { timeout: 20000 });
  await page.locator('.radar-help').nth(5).focus();
  const box = await page.locator('#radar-tip-5').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.getByRole('dialog').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'qa/radar-mobile.png' });
  await page.getByRole('button', { name: '重新计算', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '重新计算', exact: true })).toBeInViewport();
});
for (const close of ['button', 'escape', 'backdrop'])
  test(
    'closing radar by ' + close + ' stops requests and leaves normal marking usable',
    async ({ page }) => {
      const { calls, errors, release } = await setup(page, true);
      await page.getByRole('button', { name: '图一乐雷达图' }).click();
      await expect.poll(() => calls.some((c) => c === 'GET /v0/subjects/51')).toBe(true);
      if (close === 'button')
        await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
      else if (close === 'escape') await page.keyboard.press('Escape');
      else await page.mouse.click(5, 5);
      await expect(page.getByRole('dialog')).not.toBeVisible();
      const count = calls.length;
      release();
      await page.waitForTimeout(650);
      expect(calls.length).toBe(count);
      await page.getByRole('button', { name: '编辑', exact: true }).first().click();
      await expect(page.locator('#edit-status')).toBeVisible();
      await page.locator('#edit-status').selectOption('on_hold');
      await page.getByRole('button', { name: '保存记录', exact: true }).click();
      await expect(page.getByRole('dialog')).not.toBeVisible();
      await expect(page.locator('.record-row').first()).toContainText('搁置');
      expect(errors).toEqual([]);
    },
  );

for (const first of ['backup', 'radar'])
  test(
    'shared chapter snapshots work from ' +
      first +
      ' to the other feature and survive login after reload',
    async ({ page }) => {
      await setup(page);
      let chapterReads = 0;
      const remote = subjects.map((subject, i) => ({
        subject,
        subject_id: subject.id,
        type: i === 3 ? 5 : 2,
        updated_at: new Date(100 + i).toISOString(),
        rate: 0,
        comment: '',
        private: false,
        tags: [],
      }));
      await page.route('https://api.bgm.tv/v0/me', (route) =>
        route.fulfill({ json: { id: 100, username: 'testuser', nickname: '测试用户' } }),
      );
      await page.route('https://api.bgm.tv/v0/users/testuser/collections?**', (route) =>
        route.fulfill({ json: { total: remote.length, data: remote } }),
      );
      await page.route('https://api.bgm.tv/v0/users/-/collections/*/episodes?**', (route) => {
        chapterReads++;
        const id = Number(new URL(route.request().url()).pathname.split('/')[5]);
        return route.fulfill({
          json: {
            total: 12,
            data: Array.from({ length: 12 }, (_, i) => ({
              episode: {
                id: id * 100 + i,
                type: 0,
                ep: i + 1,
                sort: i + 1,
                airdate: '2020-01-01',
                name: '单集',
                name_cn: '',
              },
              type: 2,
              updated_at: 1700000000,
            })),
          },
        });
      });
      await page.evaluate(() => sessionStorage.setItem('bbm-token', 'fixture'));
      await page.reload();
      const ready = async () => {
        await page.locator('nav [data-view="sync"]').click();
        await expect(page.getByRole('button', { name: '拉取账号收藏', exact: true })).toBeEnabled();
      };
      const backup = async () => {
        await ready();
        const download = page.waitForEvent('download');
        await page.locator('#sync [data-action="export"]').click();
        await download;
      };
      const radar = async () => {
        await page.locator('nav [data-view="records"]').click();
        await page.getByRole('button', { name: '图一乐雷达图' }).click();
        await expect(page.locator('.radar-axis')).toHaveCount(6, { timeout: 20000 });
        await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
      };
      await ready();
      if (first === 'backup') {
        await backup();
        await radar();
      } else {
        await radar();
        await backup();
      }
      expect(chapterReads).toBe(6);
      await page.reload();
      await ready();
      await backup();
      await radar();
      expect(chapterReads).toBe(6);
    },
  );
