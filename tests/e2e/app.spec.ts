import { test, expect, type Page } from '@playwright/test';
import fixture from './subjects.json' with { type: 'json' };
const subjects = fixture.data;
async function mock(
  page: Page,
  options: { searchError?: boolean; writes?: unknown[]; firstVisit?: boolean } = {},
) {
  if (!options.firstVisit)
    await page.addInitScript(() => localStorage.setItem('bbm-onboarding-v1', '1'));
  await page.route('https://api.bgm.tv/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'GET,POST,PATCH,PUT',
        },
      });
    const respond = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(data),
        headers: { 'access-control-allow-origin': '*' },
      });
    if (p === '/v0/search/subjects')
      return options.searchError
        ? respond({ title: 'offline' }, 503)
        : respond({ data: subjects, total: 32 });
    if (req.method() === 'GET' && /^\/v0\/users\/-\/collections\/\d+$/.test(p))
      return respond({}, 404);
    if (p === '/v0/me') return respond({ id: 100, username: 'testuser', nickname: '测试用户' });
    if (p === '/v0/episodes')
      return respond({
        data: [
          {
            id: 501,
            type: 0,
            sort: 1,
            ep: 1,
            name: '第一集',
            duration: '00:24:00',
            airdate: '2020-01-01',
          },
          {
            id: 502,
            type: 0,
            sort: 2,
            ep: 2,
            name: '第二集',
            duration: '00:24:00',
            airdate: '2099-01-01',
          },
        ],
        total: 2,
      });
    if (p.endsWith('/characters')) return respond([]);
    if (p.endsWith('/subjects'))
      return respond([{ id: subjects[1].id, type: 2, relation: '续集' }]);
    if (p.match(/^\/v0\/subjects\/\d+$/))
      return respond(subjects.find((s) => s.id === Number(p.split('/').pop())) || subjects[0]);
    if (req.method() === 'POST' || req.method() === 'PATCH') {
      options.writes?.push({ path: p, body: req.postDataJSON() });
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    }
    if (p.endsWith('/episodes')) return respond({ data: [], total: 0 });
    if (p.endsWith('/collections')) return respond({ data: [], total: 0 });
    return respond({});
  });
}
test('batch selection, confirmation, persistence, local-only exclusion and records', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await mock(page);
  await page.goto('/');
  await expect(page.locator('.anime-card')).toHaveCount(10);
  await page.locator('[data-select]').nth(0).check();
  await page.locator('[data-select]').nth(1).check();
  await page.getByRole('button', { name: '标记看过', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('批量标记 2 部作品');
  await page.getByRole('button', { name: '确认标记', exact: true }).click();
  await expect(page.locator('#stat-watched')).toContainText('2');
  await page.reload();
  await expect(page.locator('#stat-watched')).toContainText('2');
  await expect(page.locator('.anime-card')).toHaveCount(10);
  await page.locator('[data-action="dismiss"]').nth(2).click();
  await expect(page.locator('.anime-card')).toHaveCount(9);
  await page.locator('.nav-item[data-view="records"]').click();
  await expect(page.locator('.record-row')).toHaveCount(3);
  await expect(page.locator('.record-row')).toContainText(['仅本地', '待同步', '待同步']);
  expect(errors).toEqual([]);
});
test('detail editor preserves typed text during asynchronous loads and sync uses correct payload', async ({
  page,
}) => {
  const writes: unknown[] = [];
  await mock(page, { writes });
  await page.goto('/');
  await page.locator('.card-title').first().click();
  await expect(page.locator('#edit-status')).toHaveValue('');
  await page.locator('#edit-status').selectOption('collect');
  await page.locator('#edit-rate').selectOption('8');
  await page.locator('#edit-comment').fill('补标：非常喜欢');
  await expect(page.locator('#episodes .episode')).toHaveCount(2);
  await expect(page.locator('#edit-comment')).toHaveValue('补标：非常喜欢');
  await expect(page.locator('#episodes .episode').nth(1)).toBeDisabled();
  await page.getByRole('button', { name: '保存记录', exact: true }).click();
  await page.locator('.nav-item[data-view="sync"]').click();
  await page.locator('#token').fill('fixture-only-token');
  await page.getByRole('button', { name: '验证并连接' }).click();
  await expect(page.locator('#account-name')).toHaveText('测试用户');
  await page.getByRole('button', { name: '推送待同步', exact: true }).click();
  await expect(page.locator('#pending-total')).toHaveText('0');
  expect(writes).toEqual([
    {
      path: `/v0/users/-/collections/${subjects[0].id}`,
      body: { type: 2, rate: 8, comment: '补标：非常喜欢', private: false },
    },
    {
      path: `/v0/users/-/collections/${subjects[0].id}/episodes`,
      body: { episode_id: [501], type: 2 },
    },
  ]);
  expect(await page.evaluate(() => localStorage.getItem('bbm-token'))).toBeNull();
});
test('search errors can be retried and local records stay available', async ({ page }) => {
  await mock(page, { searchError: true });
  await page.goto('/');
  await expect(page.getByText('暂时无法加载动画')).toBeVisible();
  await page.unroute('https://api.bgm.tv/**');
  await mock(page);
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(page.locator('.anime-card')).toHaveCount(10);
});
test('legacy JSON imports are reviewed and repeated ids are preserved', async ({ page }) => {
  await mock(page);
  await page.goto('/#sync');
  await page.locator('#import-file').setInputFiles({
    name: 'legacy.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        type: 'bangumi-tracker',
        items: [{ id: 42, name: '旧版记录', status: 'on_hold', rate: 7, dirty: false }],
      }),
    ),
  });
  await expect(page.getByRole('dialog')).toContainText('读取到 1 条记录');
  await page.getByRole('button', { name: '确认导入' }).click();
  await expect(page.locator('#pending-total')).toHaveText('1');
  await page.locator('.nav-item[data-view="records"]').click();
  await expect(page.locator('.record-row')).toContainText('旧版记录');
});
test('series review defaults to unhandled aired subjects', async ({ page }) => {
  await mock(page);
  await page.goto('/');
  await page.locator('[data-action="series"]').first().click();
  await expect(page.locator('.series-row')).toHaveCount(2);
  await page.getByRole('button', { name: '检查并标记' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('#stat-watched')).toContainText('2');
});
test('desktop and mobile layouts have no horizontal overflow', async ({ page }) => {
  await mock(page);
  await page.goto('/');
  await expect(page.locator('.anime-card')).toHaveCount(10);
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    for (const view of ['discover', 'records', 'sync']) {
      await page.locator(`.nav-item[data-view="${view}"]`).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
  await page.locator('.nav-item[data-view="discover"]').click();
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  await page.locator('.card-title').first().click();
  await expect(page.locator('#detail-form')).toBeVisible();
  expect(await page.locator('#dialog').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(
    true,
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('discovery always uses the compact layout without a view switch', async ({ page }) => {
  await mock(page);
  await page.goto('/');
  await expect(page.locator('.hero')).toHaveCount(0);
  await expect(page.locator('#focus-button')).toHaveCount(0);
  await expect(page.locator('.anime-card')).toHaveCount(10);
  await page.reload();
  await expect(page.locator('.hero')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /完整视图|专注补标/ })).toHaveCount(0);
});

test('series discovery confirms filtered works before highlighting without losing selection', async ({
  page,
}) => {
  await mock(page);
  const calls: number[] = [];
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const second = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  await page.route('https://api.bgm.tv/v0/subjects/*/subjects', async (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    calls.push(id);
    if (id === subjects[0].id) await first;
    if (id === subjects[1].id) await second;
    await route.fulfill({
      json: [{ id: 999999, type: id === subjects[1].id ? 1 : 2, relation: '续集' }],
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  await page.route('https://api.bgm.tv/v0/subjects/999999', (route) =>
    route.fulfill({
      json: { ...subjects[0], id: 999999, platform: 'TV' },
      headers: { 'access-control-allow-origin': '*' },
    }),
  );
  await page.goto('/');
  await page.locator('[data-select]').first().check();
  releaseFirst();
  const firstCard = page.locator('.anime-card').first();
  await expect.poll(() => calls).toEqual([subjects[0].id, subjects[1].id]);
  await expect(firstCard.locator('.series-spotlight')).toHaveCount(0);
  await expect(firstCard.locator('.card-meta [data-action="series"]')).toHaveCount(0);
  await expect(firstCard.locator('[data-select]')).toBeChecked();
  await expect.poll(() => calls).toEqual([subjects[0].id, subjects[1].id]);
  await expect(page.locator('.anime-card').nth(2).locator('.series-spotlight')).toHaveCount(0);
  releaseSecond();
  await expect(firstCard.locator('.series-spotlight')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.anime-card').nth(2).locator('.series-spotlight')).toBeVisible({
    timeout: 15000,
  });
  await expect(page.locator('.anime-card').nth(1).locator('.series-spotlight')).toHaveCount(0);
  expect(calls.slice(0, 3)).toEqual(subjects.slice(0, 3).map((s) => s.id));
});

test('series quick marks uncheck only their own row and remaining batch preserves them', async ({
  page,
}) => {
  await mock(page);
  await page.goto('/');
  await page.locator('.series-spotlight').first().click();
  await expect(page.locator('.series-row')).toHaveCount(2);
  const row = page.locator(`.series-row[data-series-id="${subjects[0].id}"]`);
  await expect(row.locator('.series-select')).toBeChecked();
  await expect(row.locator('.series-quick button')).toHaveCount(4);
  for (const status of ['collect', 'on_hold', 'dropped', 'not_interested']) {
    await row.locator('.series-select').check();
    await row.locator(`[data-action="series-mark"][data-status="${status}"]`).click();
    await expect(row.locator('.series-select')).not.toBeChecked();
    await expect(row.locator(`[data-status="${status}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(row.locator('.series-row-status .status')).toHaveClass(
      new RegExp(`status-${status}`),
    );
    await expect(page.locator('#series-selected-count')).toHaveText('批量已选 1 部');
  }
  await page.locator('#dialog').screenshot({ path: 'test-results/series-quick-desktop.png' });
  await page.setViewportSize({ width: 360, height: 844 });
  expect(await page.locator('#dialog').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(
    true,
  );
  await page.locator('#dialog').screenshot({ path: 'test-results/series-quick-mobile.png' });
  await page.getByRole('button', { name: '检查并标记' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem('bangumi-batch-marker-v1')!).items,
  );
  expect(saved[subjects[0].id].status).toBe('not_interested');
  expect(saved[subjects[1].id].status).toBe('collect');
});

test('fixed tag policy ignores weak votes and grouped tags remain selectable', async ({ page }) => {
  await mock(page);
  const payloads: any[] = [];
  const data = subjects.slice(0, 3).map((s, i) => ({
    ...s,
    tags:
      i === 0
        ? [
            { name: '科幻', count: 100 },
            { name: '恋爱', count: 1 },
          ]
        : i === 1
          ? [
              { name: '日常', count: 100 },
              { name: '恋爱', count: 40 },
            ]
          : [
              { name: '科幻', count: 3 },
              { name: '恋爱', count: 1 },
            ],
  }));
  await page.route('https://api.bgm.tv/v0/search/subjects?*', async (route) => {
    payloads.push(route.request().postDataJSON());
    await route.fulfill({
      json: { data, total: 3 },
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  await page.goto('/');
  await expect(page.locator('.anime-card')).toHaveCount(3);
  await expect(page.locator('.quick-actions .marked')).toHaveCount(0);
  await expect(page.locator('.quick-actions button[aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator('.quick-actions svg')).toHaveCount(0);
  await page.getByRole('button', { name: '屏蔽恋爱', exact: true }).click();
  await expect(page.locator('.anime-card')).toHaveCount(2);
  expect(payloads.at(-1).filter).not.toHaveProperty('meta_tags');
  await expect(page.locator('#tag-ratio, #tag-minimum')).toHaveCount(0);
  await page.getByText('更多标签', { exact: false }).click();
  await expect(page.getByRole('button', { name: '音乐', exact: true })).toBeVisible();
  await expect(page.locator('#tags [data-action="tag"]')).toHaveCount(46);
  await page.getByRole('button', { name: '科幻', exact: true }).click();
  await expect(page.locator('.anime-card')).toHaveCount(1);
  await expect(page.locator('.anime-card')).toHaveAttribute('data-id', String(subjects[0].id));
  await page.locator('.dismiss').hover();
  const hover = await page.locator('.dismiss').evaluate((e) => ({
    transform: getComputedStyle(e).transform,
    background: getComputedStyle(e).backgroundColor,
  }));
  expect(hover.transform).not.toBe('none');
  await expect(page.locator('.card-meta [data-action="series"]')).toHaveCount(0);
});

test('first visit guide leads to connection and remains dismissed on reload', async ({ page }) => {
  await mock(page, { firstVisit: true });
  await page.goto('/');
  await expect(page.getByRole('dialog')).toContainText('请自行配置科学上网');
  await expect(page.getByRole('dialog')).toContainText('自动推送标记默认开启');
  await page.getByRole('button', { name: '前往同步中心' }).click();
  await expect(page.locator('#sync')).toBeVisible();
  await expect(page.locator('#token')).toBeFocused();
  await expect(page.locator('#realtime')).toBeChecked();
  await expect(page.locator('.topbar')).toHaveCount(0);
  await expect(page.locator('.sidebar-bottom #account-chip')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('connection pulls official records and fresh marks auto-push without sending old local edits', async ({
  page,
}) => {
  const writes: any[] = [];
  await mock(page, { writes });
  let pulls = 0;
  await page.route('https://api.bgm.tv/v0/users/testuser/collections?**', async (route) => {
    pulls++;
    await route.fulfill({
      json: {
        data: [
          {
            subject_id: subjects[2].id,
            subject: subjects[2],
            type: 2,
            rate: 7,
            comment: '官方记录',
            private: false,
            tags: [],
          },
        ],
        total: 1,
      },
    });
  });
  await page.goto('/');
  await page
    .locator('.anime-card')
    .first()
    .locator('[data-action="mark"][data-status="on_hold"]')
    .click();
  await page.locator('#account-chip').click();
  await page.locator('#token').fill('fixture-only-token');
  await page.getByRole('button', { name: '验证并连接' }).click();
  await expect(page.locator('#last-pull')).toContainText('上次拉取');
  expect(pulls).toBe(1);
  expect(writes).toEqual([]);
  await expect(page.locator('#pending-total')).toHaveText('1');
  await page.locator('.nav-item[data-view="discover"]').click();
  await expect(
    page.locator(`.anime-card[data-id="${subjects[2].id}"] [data-status="collect"]`),
  ).toHaveAttribute('aria-pressed', 'true');
  await page
    .locator('.anime-card')
    .nth(1)
    .locator('[data-action="mark"][data-status="on_hold"]')
    .click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    path: `/v0/users/-/collections/${subjects[1].id}`,
    body: { type: 4 },
  });
  await expect(page.locator('#pending-total')).toHaveText('1');
  await page.locator('.anime-card').nth(3).locator('[data-action="dismiss"]').click();
  await page.locator('#account-chip').click();
  await page.locator('#realtime').uncheck();
  await page.locator('.nav-item[data-view="discover"]').click();
  await page
    .locator('.anime-card')
    .nth(4)
    .locator('[data-action="mark"][data-status="dropped"]')
    .click();
  await expect(page.locator('#pending-total')).toHaveText('2');
  await page.waitForTimeout(800);
  expect(writes).toHaveLength(1);
});

test('tiered preparation limits full series, probes, posters and distant page requests', async ({
  page,
}) => {
  test.setTimeout(90000);
  await mock(page);
  const calls: string[] = [];
  const posters: number[] = [];
  await page.route('https://lain.bgm.tv/**/prefetch-*.png', (route) => {
    posters.push(
      Number(
        route
          .request()
          .url()
          .match(/prefetch-(\d+)/)![1],
      ),
    );
    return route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8X8AAAAASUVORK5CYII=',
        'base64',
      ),
    });
  });
  const make = (id: number) => ({
    ...subjects[0],
    id,
    name_cn: `测试系列${id}`,
    date: '2020-01-01',
    image: 'https://lain.bgm.tv/pic/cover/l/prefetch-' + id + '.png',
  });
  await page.route('https://api.bgm.tv/v0/search/subjects?**', async (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
    calls.push(`search:${offset}`);
    await route.fulfill({
      json: { data: Array.from({ length: 20 }, (_, i) => make(offset + i + 1)), total: 120 },
    });
  });
  await page.route(/https:\/\/api.bgm.tv\/v0\/subjects\/\d+(\/subjects)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const id = Number(path.split('/')[3]);
    calls.push(path.endsWith('/subjects') ? `related:${id}` : `subject:${id}`);
    await route.fulfill({
      json: path.endsWith('/subjects')
        ? id === 1 || id === 21 || id === 41
          ? [{ id: id + 100, type: 2, relation: '续集' }]
          : []
        : make(id),
    });
  });
  await page.goto('/');
  await expect(page.locator('#series-scan-status')).toHaveText(
    '已缓存至第 2 页 · 已探查第 3 页 · 海报已准备至第 4 页 · 系列准备完成',
    {
      timeout: 40000,
    },
  );
  expect(calls.filter((c) => c.startsWith('search:'))).toEqual([
    'search:0',
    'search:20',
    'search:40',
    'search:60',
  ]);
  expect(calls.indexOf('related:20')).toBeLessThan(calls.indexOf('subject:1'));
  expect(calls.indexOf('related:101')).toBeLessThan(calls.indexOf('search:20'));
  expect(calls.indexOf('related:40')).toBeLessThan(calls.indexOf('subject:21'));
  expect(calls.indexOf('related:121')).toBeLessThan(calls.indexOf('search:40'));
  expect(calls.indexOf('related:60')).toBeLessThan(calls.indexOf('search:60'));
  expect(calls).not.toContain('subject:41');
  expect(calls).not.toContain('related:141');
  expect(calls).not.toContain('related:61');
  expect(calls).not.toContain('search:80');
  expect(posters).toEqual(expect.arrayContaining(Array.from({ length: 60 }, (_, i) => i + 21)));
  expect(posters.some((id) => id > 80)).toBe(false);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.anime-card[data-id="21"] [data-action="series"]')).toBeVisible();
  expect(calls.filter((c) => c === 'search:20')).toHaveLength(1);
  await page.locator('.anime-card[data-id="21"] [data-action="series"]').click();
  await expect(page.locator('.series-row')).toHaveCount(2);
  await page.getByRole('button', { name: '关闭弹窗' }).click();
  await expect(page.locator('#series-scan-status')).toHaveText(
    '已缓存至第 3 页 · 已探查第 4 页 · 海报已准备至第 5 页 · 系列准备完成',
    { timeout: 30000 },
  );
  expect(calls).toContain('subject:41');
  expect(calls.filter((c) => c === 'related:41')).toHaveLength(1);
  expect(calls).toContain('search:80');
  expect(calls).not.toContain('related:81');
  expect(calls).not.toContain('search:100');
  calls.length = 0;
  await page.reload();
  await expect(page.locator('.anime-card[data-id="1"] [data-action="series"]')).toBeVisible();
  await page.locator('.anime-card[data-id="1"] [data-action="series"]').click();
  await expect(page.locator('.series-row')).toHaveCount(2);
  expect(calls.filter((c) => c.startsWith('subject:') || c.startsWith('related:'))).toEqual([]);
});

test('series detail close returns to the same selection and backdrop exits to discover', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mock(page);
  await page.goto('/');
  await expect(page.locator('.anime-card')).toHaveCount(10);
  await page.evaluate(() => window.scrollTo(0, 300));
  const originalScroll = await page.evaluate(() => window.scrollY);
  expect(originalScroll).toBeGreaterThan(0);

  await page.locator('[data-action="series"]').first().click();
  await expect(page.locator('.series-row')).toHaveCount(2);
  await page.locator('.series-select').first().uncheck();
  await page.locator('#series-status').selectOption('on_hold');
  await page.locator('.series-detail').first().click();
  await expect(page.getByRole('dialog')).toContainText('作品详情');
  await page.getByRole('button', { name: '返回系列补标', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('系列补标');
  await expect(page.locator('.series-select').first()).not.toBeChecked();
  await expect(page.locator('.series-select').nth(1)).toBeChecked();
  await expect(page.locator('#series-status')).toHaveValue('on_hold');
  await page.locator('.series-detail').first().click();
  await page.mouse.click(2, 2);
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('#discover')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(originalScroll);
  await page.locator('[data-action="series"]').first().click();
  await expect(page.locator('.series-row')).toHaveCount(2);
  await page.mouse.click(2, 2);
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(originalScroll);
  await page.locator('.card-title').first().click();
  await expect(page.getByRole('button', { name: '关闭弹窗', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('auto-next waits for all visible cards and ignores off-page series entries', async ({
  page,
}) => {
  await mock(page);
  const data = Array.from({ length: 11 }, (_, i) => ({
    ...subjects[0],
    id: i === 0 ? subjects[0].id : 8000 + i,
    tags: [{ name: '科幻', count: 100 }],
  }));
  data.push({ ...subjects[1], tags: [{ name: '恋爱', count: 100 }] });
  await page.route('https://api.bgm.tv/v0/search/subjects?**', (route) =>
    route.fulfill({ json: { data, total: data.length } }),
  );
  await page.goto('/');
  await page.locator('#page-size').selectOption('10');
  await page.getByRole('button', { name: '科幻', exact: true }).click();
  await expect(page.locator('.anime-card')).toHaveCount(10);
  await page.locator('#auto-next').check();
  await page.locator('#select-page').check();
  await page.locator('[data-select]').first().uncheck();
  await page.getByRole('button', { name: '标记看过', exact: true }).click();
  await page.getByRole('button', { name: '确认标记', exact: true }).click();
  await expect(page.locator('#pager')).toContainText('第 1 / 2 页');
  await page.locator('[data-action="series"]').first().click();
  await expect(page.locator('.series-row')).toHaveCount(2);
  await page
    .locator('.series-row[data-series-id="' + subjects[0].id + '"] [data-status="collect"]')
    .click();
  await expect(page.locator('#pager')).toContainText('第 2 / 2 页');
  await expect(
    page.locator('.series-row[data-series-id="' + subjects[1].id + '"] .series-row-status'),
  ).toContainText('待整理');
});

test('hidden handled cards compact in place and auto-next never skips the replacement', async ({
  page,
}) => {
  await mock(page);
  await page.route('https://api.bgm.tv/v0/search/subjects?**', (route) =>
    route.fulfill({ json: { data: subjects.slice(0, 2), total: 2 } }),
  );
  await page.goto('/');
  await expect(page.locator('.anime-card')).toHaveCount(2);
  await page.locator('#auto-next').check();
  await page.locator('#hide-handled').check();
  await page
    .locator('.anime-card')
    .first()
    .locator('[data-action="mark"][data-status="on_hold"]')
    .click();
  await expect(page.locator('.anime-card')).toHaveCount(1);
  await expect(page.locator('#pager')).toContainText('第 1 / 1 页');
  await page.locator('[data-action="dismiss"]').click();
  await expect(page.locator('.anime-card')).toHaveCount(0);
  await expect(page.locator('#grid')).toContainText('没有符合当前条件的作品');
  await page.locator('#auto-next').uncheck();
  await page.locator('#auto-next').check();
  await expect(page.locator('#pager')).toContainText('第 1 / 1 页');
});

test('empty rank mode shows global ranks across pages and matching only exists with a keyword', async ({
  page,
}) => {
  await mock(page);
  await page.route('https://api.bgm.tv/v0/subjects?**', (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
    return route.fulfill({
      json: {
        total: 9000,
        data: Array.from({ length: 20 }, (_, i) => ({
          ...subjects[0],
          id: offset + i + 10000,
          rating: { rank: offset + i + 1, score: 8.5 },
        })),
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('#sort option')).toHaveText(['热度优先', '排名优先', '日期优先']);
  await page.locator('#sort').selectOption('rank');
  await expect(page.locator('.score')).toHaveText(
    Array.from({ length: 20 }, (_, i) => '#' + (i + 1)),
  );
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.score')).toHaveText(
    Array.from({ length: 20 }, (_, i) => '#' + (i + 21)),
  );
  await expect(page.locator('#pager')).toContainText('第 2 /');
  await page.locator('#keyword').fill('CLANNAD');
  await expect(page.locator('#sort option')).toHaveText([
    '热度优先',
    '排名优先',
    '日期优先',
    '匹配度',
  ]);
  await page.locator('#sort').selectOption('match');
  await expect(page.locator('.score').first()).toHaveAttribute('title', 'Bangumi 评分');
  await page.locator('#keyword').fill('   ');
  await expect(page.locator('#sort option')).toHaveText(['热度优先', '排名优先', '日期优先']);
  await expect(page.locator('#sort')).toHaveValue('heat');
});

test('NSFW changes reload immediately and compact results across source pages', async ({
  page,
}) => {
  await mock(page);
  await page.addInitScript(() => sessionStorage.setItem('bbm-token', 'fixture-token'));
  const catalogs: string[] = [];
  const data = Array.from({ length: 80 }, (_, i) => ({
    ...subjects[0],
    id: 9000 + i,
    nsfw: !!(i % 2),
    rating: { rank: i + 1, score: 8 },
  }));
  const payloads: any[] = [];
  const respond = (route: any) => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get('offset'));
    if (url.searchParams.get('limit') === '100') catalogs.push(url.pathname);
    return route.fulfill({
      json: { total: 80, data: data.slice(offset, offset + Number(url.searchParams.get('limit'))) },
    });
  };
  await page.route('https://api.bgm.tv/v0/search/subjects?**', (route) => {
    payloads.push(route.request().postDataJSON());
    return respond(route);
  });
  await page.route('https://api.bgm.tv/v0/subjects?**', respond);
  await page.goto('/');
  await expect(page.locator('.anime-card')).toHaveCount(20);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.anime-card').first()).toHaveAttribute('data-id', '9040');
  await page.locator('#nsfw').selectOption('all');
  await expect(page.locator('.anime-card').first()).toHaveAttribute('data-id', '9000');
  await expect(page.locator('#pager')).toContainText('第 1 /');
  await page.locator('#nsfw').selectOption('only');
  await expect(page.locator('.anime-card')).toHaveCount(20);
  await expect(page.locator('.anime-card').first()).toHaveAttribute('data-id', '9001');
  expect(catalogs.length).toBeGreaterThan(0);
  await page.locator('#nsfw').selectOption('hide');
  await page.locator('#sort').selectOption('rank');
  await expect(page.locator('.score')).toHaveText(
    Array.from({ length: 20 }, (_, i) => '#' + (i * 2 + 1)),
  );
  await page.locator('#nsfw').selectOption('all');
  await expect(page.locator('.score')).toHaveText(
    Array.from({ length: 20 }, (_, i) => '#' + (i + 1)),
  );
  await page.locator('#nsfw').selectOption('only');
  await expect(page.locator('.score')).toHaveText(
    Array.from({ length: 20 }, (_, i) => '#' + (i * 2 + 2)),
  );
});

test('year range drag previews, commits on release, clamps and resets', async ({ page }) => {
  await mock(page);
  const queries: any[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/v0/search/subjects?') && req.method() === 'POST')
      queries.push(req.postDataJSON());
  });
  await page.goto('/');
  await expect(page.locator('.anime-card')).toHaveCount(10);
  const from = page.getByRole('slider', { name: '起始年份', exact: true });
  const to = page.getByRole('slider', { name: '结束年份', exact: true });
  const max = new Date().getFullYear() + 1;
  await expect(page.locator('#year-label')).toHaveText('全部年份');
  expect(queries[0].filter.air_date).toBeUndefined();
  const box = (await from.boundingBox())!;
  const startQueries = queries.length;
  await page.mouse.move(box.x + 9, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + 9 + ((box.width - 18) * (2010 - 1990)) / (max - 1990),
    box.y + box.height / 2,
    { steps: 8 },
  );
  await expect(from).toHaveValue('2010');
  await expect(page.locator('#year-label')).toHaveText('2010 – ' + max);
  expect(queries).toHaveLength(startQueries);
  await page.mouse.up();
  await expect
    .poll(() => queries.at(-1)?.filter.air_date)
    .toEqual(['>=2010-01-01', '<=' + max + '-12-31']);
  await to.focus();
  await to.press('Home');
  await expect(to).toHaveValue('2010');
  await expect(page.locator('#year-label')).toHaveText('2010 年');
  await from.focus();
  await from.press('End');
  await expect(from).toHaveValue('2010');
  await page.getByRole('button', { name: '重置筛选' }).click();
  await expect(from).toHaveValue('1990');
  await expect(to).toHaveValue(String(max));
  await expect(page.locator('#year-label')).toHaveText('全部年份');
  await expect(page.locator('.anime-card')).toHaveCount(10); // Full-range results may come from the candidate cache.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(from).toBeInViewport();
  await expect(to).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('filtered pagination fills 10 or 20 cards and hiding handled starts from the first remaining result', async ({
  page,
}) => {
  await mock(page);
  const candidates = Array.from({ length: 65 }, (_, i) => ({
    ...subjects[0],
    id: 7000 + i,
    name_cn: '分页测试 ' + i,
    rating: { rank: i + 1, score: 8 },
    tags: [{ name: '科幻', count: 100 }],
    nsfw: false,
  }));
  await page.route('https://api.bgm.tv/v0/search/subjects?**', (route) => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
    return route.fulfill({
      json: { total: candidates.length, data: candidates.slice(offset, offset + limit) },
    });
  });
  await page.goto('/');
  await expect(page.locator('.anime-card')).toHaveCount(20);
  await page.locator('#select-page').check();
  await page.getByRole('button', { name: '标记看过', exact: true }).click();
  await page.getByRole('button', { name: '确认标记', exact: true }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.anime-card').first()).toHaveAttribute('data-id', '7020');
  await page.locator('#hide-handled').check();
  await expect(page.locator('#pager')).toContainText('第 1 /');
  await expect(page.locator('.anime-card')).toHaveCount(20);
  await expect(page.locator('.anime-card').first()).toHaveAttribute('data-id', '7020');
  await page
    .locator('.anime-card')
    .first()
    .locator('[data-action="mark"][data-status="collect"]')
    .click();
  await expect(page.locator('.anime-card')).toHaveCount(20);
  await expect(page.locator('.anime-card').first()).toHaveAttribute('data-id', '7021');
  await page.locator('#page-size').selectOption('10');
  await expect(page.locator('.anime-card')).toHaveCount(10);
  await page.getByRole('button', { name: '科幻', exact: true }).click();
  await expect(page.locator('.anime-card')).toHaveCount(10);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.anime-card').first()).toHaveAttribute('data-id', '7031');
  await page.locator('#hide-handled').uncheck();
  await expect(page.locator('.anime-card')).toHaveCount(10);
  await expect(page.locator('.anime-card').first()).toHaveAttribute('data-id', '7000');
});

test('sync conflict dialog reviews the full batch on pull and manual push', async ({ page }) => {
  const writes: unknown[] = [];
  await mock(page, { writes });
  await page.addInitScript(
    (rows) => {
      sessionStorage.setItem('bbm-token', 'fixture-token');
      localStorage.setItem(
        'bangumi-batch-marker-v1',
        JSON.stringify({
          version: 1,
          preferencesVersion: 2,
          owner: 100,
          items: Object.fromEntries(
            rows.map((s) => [s.id, { ...s, status: 'on_hold', dirty: true, revision: 1 }]),
          ),
          settings: { realtime: false, completeEpisodes: false, autoNext: false },
        }),
      );
    },
    subjects.slice(0, 2),
  );
  let returnCollections = false;
  const remote = subjects.slice(0, 2).map((subject) => ({
    subject_id: subject.id,
    subject,
    type: 2,
    rate: 0,
    comment: '',
    private: false,
    tags: [],
  }));
  await page.route('https://api.bgm.tv/v0/users/testuser/collections?**', (route) =>
    route.fulfill({
      json: { total: returnCollections ? 2 : 0, data: returnCollections ? remote : [] },
    }),
  );
  await page.route('https://api.bgm.tv/v0/users/-/collections/*', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { type: 2 } }) : route.fallback(),
  );
  await page.goto('/#sync');
  await expect(page.getByRole('button', { name: '拉取账号收藏', exact: true })).toBeEnabled();
  returnCollections = true;
  await page.getByRole('button', { name: '拉取账号收藏', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('收藏状态冲突');
  await expect(page.locator('.conflict-list tbody tr')).toHaveCount(2);
  await expect(page.locator('.conflict-list tbody tr').first()).toContainText('搁置');
  await expect(page.locator('.conflict-list tbody tr').first()).toContainText('看过');
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: '取消本次同步', exact: true }).click();
  await expect(page.locator('#pending-total')).toHaveText('2');
  await page.getByRole('button', { name: '拉取账号收藏', exact: true }).click();
  await page.getByRole('button', { name: '全部采用云端状态', exact: true }).click();
  await expect(page.locator('#pending-total')).toHaveText('0');
  expect(writes).toHaveLength(0);
  await page.locator('.nav-item[data-view="discover"]').click();
  await expect(page.locator('.anime-card')).toHaveCount(10);
  for (const subject of subjects.slice(0, 2))
    await page
      .locator(
        '.anime-card[data-id="' + subject.id + '"] [data-action="mark"][data-status="on_hold"]',
      )
      .click();
  await page.locator('.nav-item[data-view="sync"]').click();
  await page.getByRole('button', { name: '推送待同步', exact: true }).click();
  await expect(page.locator('.conflict-list tbody tr')).toHaveCount(2);
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: '全部保留本地状态', exact: true }).click();
  await expect(page.locator('#pending-total')).toHaveText('0');
  expect(writes).toHaveLength(2);
  expect(writes).toEqual(
    expect.arrayContaining(
      subjects
        .slice(0, 2)
        .map((s) => ({ path: '/v0/users/-/collections/' + s.id, body: { type: 4 } })),
    ),
  );
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('series lists persist for every member across keywords, page sizes and reloads', async ({
  page,
}) => {
  await mock(page);
  await page.route('https://api.bgm.tv/v0/search/subjects?**', (route) =>
    route.fulfill({ json: { data: subjects.slice(0, 2), total: 2 } }),
  );
  const calls: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (
      url.hostname === 'api.bgm.tv' &&
      (url.pathname.startsWith('/v0/subjects/') || url.pathname === '/v0/episodes')
    )
      calls.push(url.pathname);
  });
  await page.goto('/');
  await expect(page.locator('.anime-card')).toHaveCount(2);
  await page
    .locator('.anime-card[data-id="' + subjects[0].id + '"] [data-action="series"]')
    .click();
  await expect(page.locator('.series-row')).toHaveCount(2);
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  calls.length = 0;
  await page.locator('#page-size').selectOption('10');
  await page.locator('#keyword').fill('测试筛选');
  await page.getByRole('button', { name: '搜索动画' }).click();
  await expect(page.locator('.anime-card')).toHaveCount(2);
  await page
    .locator('.anime-card[data-id="' + subjects[1].id + '"] [data-action="series"]')
    .click();
  await expect(page.locator('.series-row')).toHaveCount(2);
  expect(calls).toEqual([]);
  await page.reload();
  await expect(page.locator('.anime-card')).toHaveCount(2);
  await page
    .locator('.anime-card[data-id="' + subjects[1].id + '"] [data-action="series"]')
    .click();
  await expect(page.locator('.series-row')).toHaveCount(2);
  expect(calls).toEqual([]);
});

test('raw cached relationships never flash a series badge when the sequel is excluded', async ({
  page,
}) => {
  await mock(page);
  const root = subjects[0];
  await page.addInitScript(
    (id) =>
      localStorage.setItem(
        'bbm-series-cache-v5',
        JSON.stringify({
          version: 1,
          records: [{ scope: 'public', id, at: Date.now(), hint: true }],
        }),
      ),
    root.id,
  );
  await page.route('https://api.bgm.tv/v0/search/subjects**', (route) =>
    route.fulfill({
      json: { data: [root], total: 1 },
      headers: { 'access-control-allow-origin': '*' },
    }),
  );
  await page.route('https://api.bgm.tv/v0/subjects/*/subjects', (route) =>
    route.fulfill({
      json: [{ id: 999999, type: 2, relation: '续集' }],
      headers: { 'access-control-allow-origin': '*' },
    }),
  );
  await page.route('https://api.bgm.tv/v0/subjects/999999', (route) =>
    route.fulfill({
      json: { ...root, id: 999999, platform: 'WEB' },
      headers: { 'access-control-allow-origin': '*' },
    }),
  );
  await page.addInitScript(() => {
    (window as any).seriesBadgeAppeared = false;
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (
            node instanceof Element &&
            (node.matches('.series-spotlight') || node.querySelector('.series-spotlight'))
          )
            (window as any).seriesBadgeAppeared = true;
        }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto('/');
  await expect(page.locator('.anime-card')).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('bbm-series-cache-v5')!).records.find(
            (r: any) => r.scope === 'public',
          )?.result?.entries.length,
      ),
    )
    .toBe(1);
  await expect(page.locator('.series-spotlight')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).seriesBadgeAppeared)).toBe(false);
});

async function setupSeriesBatch(page: Page, realtime = true) {
  const writes: Array<{ path: string; body: { type: number } }> = [];
  await mock(page, { writes });
  await page.addInitScript(
    ({ rows, realtime }) => {
      sessionStorage.setItem('bbm-token', 'fixture-token');
      localStorage.setItem(
        'bangumi-batch-marker-v1',
        JSON.stringify({
          version: 1,
          preferencesVersion: 2,
          owner: 100,
          items: {},
          settings: { realtime, completeEpisodes: false, autoNext: false },
        }),
      );
      localStorage.setItem(
        'bbm-series-cache-v5',
        JSON.stringify({
          version: 1,
          records: rows.map((s) => ({
            scope: 'user-100',
            id: s.id,
            at: Date.now(),
            hint: true,
            result: { entries: rows, truncated: false },
          })),
        }),
      );
    },
    { rows: subjects.slice(0, 2), realtime },
  );
  await page.goto('/#sync');
  await expect(page.getByRole('button', { name: '拉取账号收藏', exact: true })).toBeEnabled();
  await page.locator('.nav-item[data-view="discover"]').click();
  await page.locator('.series-spotlight').first().click();
  await expect(page.locator('.series-row')).toHaveCount(2);
  return writes;
}

for (const [status, type] of [
  ['doing', 3],
  ['wish', 1],
] as const) {
  test(
    'series batch directly saves and pushes ' + status + ' without confirmation when cloud agrees',
    async ({ page }) => {
      const writes = await setupSeriesBatch(page);
      await page.route('https://api.bgm.tv/v0/users/-/collections/*', (route) =>
        route.request().method() === 'GET' ? route.fulfill({ json: { type } }) : route.fallback(),
      );
      await page.locator('.series-select').first().uncheck();
      await page.getByRole('button', { name: '选择全部已播作品', exact: true }).click();
      await expect(page.locator('.series-select:checked')).toHaveCount(2);
      await page.locator('#series-status').selectOption(status);
      await page.getByRole('button', { name: '检查并标记' }).click();
      await expect(page.getByRole('dialog')).not.toBeVisible();
      await expect.poll(() => writes.length).toBe(2);
      expect(writes.every((w) => w.body.type === type)).toBe(true);
      await expect(page.locator('#pending-total')).toHaveText('0');
      await expect(page.getByRole('dialog')).not.toBeVisible();
    },
  );
}
for (const choice of ['local', 'remote', 'cancel'] as const) {
  test('series batch reviews cloud conflicts together and respects ' + choice, async ({ page }) => {
    const writes = await setupSeriesBatch(page);
    await page.route('https://api.bgm.tv/v0/users/-/collections/*', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: { type: 2 } }) : route.fallback(),
    );
    await page.locator('#series-status').selectOption('wish');
    await page.getByRole('button', { name: '检查并标记' }).click();
    await expect(page.locator('.conflict-list tbody tr')).toHaveCount(2);
    await expect(page.locator('.conflict-list tbody tr').first()).toContainText('想看');
    await expect(page.locator('.conflict-list tbody tr').first()).toContainText('看过');
    expect(writes).toHaveLength(0);
    await page
      .getByRole('button', {
        name:
          choice === 'local'
            ? '全部保留本地状态'
            : choice === 'remote'
              ? '全部采用云端状态'
              : '取消本次同步',
        exact: true,
      })
      .click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.locator('#pending-total')).toHaveText(choice === 'cancel' ? '2' : '0');
    expect(writes).toHaveLength(choice === 'local' ? 2 : 0);
    const statuses = await page.evaluate(() =>
      Object.values(JSON.parse(localStorage.getItem('bangumi-batch-marker-v1')!).items).map(
        (i: any) => i.status,
      ),
    );
    expect(statuses).toEqual([
      choice === 'remote' ? 'collect' : 'wish',
      choice === 'remote' ? 'collect' : 'wish',
    ]);
  });
}
test('series batch stays local with automatic push disabled and reviews conflicts on manual push', async ({
  page,
}) => {
  const writes = await setupSeriesBatch(page, false);
  let checks = 0;
  await page.route('https://api.bgm.tv/v0/users/-/collections/*', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    checks++;
    return route.fulfill({ json: { type: 2 } });
  });
  await page.locator('#series-status').selectOption('doing');
  await page.getByRole('button', { name: '检查并标记' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('#pending-total')).toHaveText('2');
  expect(checks).toBe(0);
  expect(writes).toHaveLength(0);
  await page.locator('.nav-item[data-view="sync"]').click();
  await page.getByRole('button', { name: '推送待同步', exact: true }).click();
  await expect(page.locator('.conflict-list tbody tr')).toHaveCount(2);
  expect(checks).toBe(2);
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: '全部保留本地状态', exact: true }).click();
  await expect(page.locator('#pending-total')).toHaveText('0');
  expect(writes.every((w) => w.body.type === 3)).toBe(true);
});

for (const size of [10, 20]) {
  test(
    'NSFW demand loading shows ' +
      size +
      ' cards before scanning more and prepares current series before prefetch',
    async ({ page }) => {
      test.setTimeout(60000);
      await mock(page);
      await page.addInitScript(() => sessionStorage.setItem('bbm-token', 'fixture-token'));
      const events: string[] = [];
      const offsets: number[] = [];
      let releaseProbe!: () => void;
      const probe = new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      let releaseNext!: () => void;
      const next = new Promise<void>((resolve) => {
        releaseNext = resolve;
      });
      const row = (id: number) => ({
        ...subjects[0],
        id,
        platform: 'TV',
        nsfw: true,
        date: '2020-01-01',
      });
      await page.route('https://api.bgm.tv/v0/subjects?**', async (route) => {
        const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
        offsets.push(offset);
        events.push('catalog:' + offset);
        if (offset === 100) await next;
        await route.fulfill({
          json: {
            total: 200,
            data: Array.from({ length: 100 }, (_, i) => ({
              ...row(20000 + offset + i),
              nsfw: i < size,
            })),
          },
        });
      });
      await page.route('https://api.bgm.tv/v0/subjects/*/subjects', async (route) => {
        const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
        if (id === 20000) await probe;
        events.push('related:' + id);
        await route.fulfill({
          json: id === 20000 ? [{ id: 999888, type: 2, relation: '续集' }] : [],
        });
      });
      await page.route('https://api.bgm.tv/v0/subjects/*', async (route) => {
        const id = Number(new URL(route.request().url()).pathname.split('/').pop());
        await route.fulfill({ json: row(id) });
      });
      await page.goto('/#sync');
      await expect(page.getByRole('button', { name: '拉取账号收藏', exact: true })).toBeEnabled();
      await page.locator('.nav-item[data-view="discover"]').click();
      await page.locator('#page-size').selectOption(String(size));
      await page.locator('#nsfw').selectOption('only');
      await expect(page.locator('.anime-card')).toHaveCount(size);
      await expect(page.locator('.anime-card').first()).toHaveAttribute('data-id', '20000');
      await expect(page.locator('#sort')).toHaveValue('date');
      expect(offsets).toEqual([0]);
      releaseProbe();
      await expect(page.locator('.anime-card').first().locator('.series-spotlight')).toBeVisible({
        timeout: 20000,
      });
      await expect.poll(() => offsets, { timeout: 20000 }).toEqual([0, 100]);
      expect(events.indexOf('catalog:100')).toBeGreaterThan(events.indexOf('related:999888'));
      await page.locator('.anime-card').first().locator('.series-spotlight').click();
      await expect(page.locator('.series-row')).toHaveCount(2);
      releaseNext();
      await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
      await expect(page.locator('#series-scan-status')).toHaveText(
        '已缓存至第 2 页 · 系列准备完成',
        {
          timeout: 20000,
        },
      );
      expect(offsets).toEqual([0, 100]);
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await expect(page.locator('.anime-card')).toHaveCount(size);
      await expect(page.locator('.anime-card').first()).toHaveAttribute('data-id', '20100');
      expect(offsets.filter((n) => n === 100)).toHaveLength(1);
    },
  );
}

test('changing NSFW filters stops the obsolete catalog scan after its in-flight chunk', async ({
  page,
}) => {
  await mock(page);
  await page.addInitScript(() => sessionStorage.setItem('bbm-token', 'fixture-token'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const offsets: number[] = [];
  await page.route('https://api.bgm.tv/v0/subjects?**', async (route) => {
    offsets.push(Number(new URL(route.request().url()).searchParams.get('offset')));
    await gate;
    await route.fulfill({
      json: {
        total: 32828,
        data: Array.from({ length: 100 }, (_, i) => ({
          ...subjects[0],
          id: 20000 + i,
          nsfw: false,
        })),
      },
    });
  });
  await page.goto('/#sync');
  await expect(page.getByRole('button', { name: '拉取账号收藏', exact: true })).toBeEnabled();
  await page.locator('.nav-item[data-view="discover"]').click();
  await page.locator('#nsfw').selectOption('only');
  await expect.poll(() => offsets).toEqual([0]);
  await expect(page.locator('#results-count')).toHaveText('加载中');
  await page.locator('#nsfw').selectOption('hide');
  release();
  await expect(page.locator('.anime-card')).toHaveCount(20);
  await expect(page.locator('#sort option[value="heat"]')).toHaveText('热度优先');
  expect(offsets).toEqual([0]);
});

test('headline and date priority are available with NSFW hidden and remain ordered across pages', async ({
  page,
}) => {
  await mock(page);
  const rows = Array.from({ length: 30 }, (_, i) => ({
    ...subjects[0],
    id: 70000 + i,
    name: '日期测试' + i,
    name_cn: '日期测试' + i,
    nsfw: i === 0,
    date: '2025-01-' + String(30 - i).padStart(2, '0'),
  }));
  const queries: string[] = [];
  await page.route('https://api.bgm.tv/v0/subjects?**', (route) => {
    queries.push(route.request().url());
    return route.fulfill({ json: { total: 30, data: rows } });
  });
  await page.route('https://api.bgm.tv/v0/subjects/*/subjects', (route) =>
    route.fulfill({ json: [] }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '让每一次补番都有迹可循' })).toBeVisible();
  await page.locator('#sort').selectOption('date');
  await expect(page.locator('.anime-card')).toHaveCount(20);
  await expect(page.locator('.anime-card').first()).toHaveAttribute('data-id', '70001');
  expect(queries[0]).toContain('sort=date');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.anime-card')).toHaveCount(9);
  await expect(page.locator('.anime-card').first()).toHaveAttribute('data-id', '70021');
});

test('clicking a current card pauses later pages until the foreground detail closes', async ({
  page,
}) => {
  test.setTimeout(60000);
  await mock(page);
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('https://api.bgm.tv/v0/search/subjects?**', (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
    events.push('search:' + offset);
    return route.fulfill({
      json: {
        total: 60,
        data: Array.from({ length: 20 }, (_, i) => ({ ...subjects[0], id: 80000 + offset + i })),
      },
    });
  });
  await page.route('https://api.bgm.tv/v0/subjects/*/subjects', async (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    if (id === 80020) await gate;
    events.push('related:' + id);
    await route.fulfill({ json: [] });
  });
  await page.route('https://api.bgm.tv/v0/subjects/*', (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/').pop());
    events.push('detail:' + id);
    return route.fulfill({ json: { ...subjects[0], id } });
  });
  await page.goto('/');
  await expect.poll(() => events.includes('search:20'), { timeout: 20000 }).toBe(true);
  await page.locator('.card-title').first().click();
  await expect(page.locator('#detail-form')).toBeVisible();
  release();
  await expect(page.locator('#episodes .episode')).toHaveCount(2);
  expect(events).toContain('detail:80000');
  expect(events).not.toContain('related:80021');
  expect(events).not.toContain('search:40');
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await expect.poll(() => events.includes('search:40'), { timeout: 20000 }).toBe(true);
  expect(events.indexOf('related:80039')).toBeLessThan(events.indexOf('search:40'));
});

test('formal branding and compact backup download include identity and mixed episode marks only', async ({
  page,
}) => {
  await mock(page);
  await page.addInitScript((subject) => {
    sessionStorage.setItem('bbm-token', 'fixture-token');
    localStorage.setItem(
      'bangumi-batch-marker-v1',
      JSON.stringify({
        version: 1,
        preferencesVersion: 2,
        owner: 100,
        items: {
          [subject.id]: {
            ...subject,
            status: 'doing',
            dirty: false,
            markedAt: 1700000000000,
            episodeChanges: { 501: 0 },
          },
        },
        settings: { realtime: false, completeEpisodes: true },
      }),
    );
  }, subjects[0]);
  await page.route('https://api.bgm.tv/v0/users/-/collections/*/episodes?**', (route) =>
    route.fulfill({
      json: {
        total: 2,
        data: [
          { episode: { id: 501 }, type: 2, updated_at: 1700000000 },
          { episode: { id: 502 }, type: 3, updated_at: 0 },
        ],
      },
    }),
  );
  await page.goto('/#sync');
  await expect(page).toHaveTitle('bangumi动画补标工具');
  await expect(page.locator('.brand')).toHaveText('bangumi动画补标工具');
  await expect(page.getByRole('button', { name: '拉取账号收藏', exact: true })).toBeEnabled();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#sync [data-action="export"]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^bangumi-backlog-backup-/);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const backup = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(backup).toMatchObject({
    type: 'bangumi-backlog',
    version: 2,
    account: { id: 100, username: '测试用户' },
  });
  expect(backup.items[0].episodes.map((ep: any) => ep.type)).toEqual([0, 3]);
  expect(backup.items[0].episodes[1].markedAt).toBeNull();
  expect(backup.items[0]).not.toHaveProperty('tags');
  expect(backup.items[0]).not.toHaveProperty('tagVotes');
  await page.locator('#import-file').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.getByRole('dialog')).toContainText('读取到 1 条记录');
});

test('quarter picker disables years, fills filtered pages and restores the previous range on clearing', async ({
  page,
}) => {
  await mock(page);
  const data = Array.from({ length: 80 }, (_, i) => ({
    ...subjects[0],
    id: 90000 + i,
    date: '2024-' + String(Math.floor(i / 20) * 3 + 1).padStart(2, '0') + '-01',
  }));
  const queries: any[] = [];
  await page.route('https://api.bgm.tv/v0/search/subjects?**', (route) => {
    queries.push(route.request().postDataJSON());
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
    return route.fulfill({ json: { total: data.length, data: data.slice(offset, offset + 20) } });
  });
  await page.route('https://api.bgm.tv/v0/subjects/*/subjects', (route) =>
    route.fulfill({ json: [] }),
  );
  await page.goto('/');
  await page.locator('#year-from').evaluate((el: HTMLInputElement) => {
    el.value = '2010';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#year-to').evaluate((el: HTMLInputElement) => {
    el.value = '2012';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#quarter-year')).toHaveValue('');
  await expect(page.locator('#quarter')).toHaveValue('');
  await page.locator('.quarter-filter').screenshot({ path: 'test-results/quarter-empty.png' });
  const selectSeason = async (quarter: string) => {
    await page.locator('#season-trigger').click();
    await page.locator('[data-action="season-year"][data-year="2024"]').click();
    await page.locator('[data-action="season-quarter"][data-quarter="' + quarter + '"]').click();
  };
  await page.locator('#season-trigger').click();
  await page.locator('[data-action="season-year"][data-year="2024"]').click();
  await expect(page.locator('#quarter-year')).toHaveValue('');
  await expect(page.locator('#year-from')).toBeEnabled();
  await page.getByRole('button', { name: '4月番', exact: true }).click();
  await expect(page.locator('#year-from')).toBeDisabled();
  await expect(page.locator('#year-to')).toBeDisabled();
  await expect(page.locator('.year-filter')).toHaveClass(/disabled/);
  await expect.poll(() => queries.at(-1)?.filter.air_date).toEqual(['>=2024-04-01', '<2024-07-01']);
  await expect(page.locator('.anime-card')).toHaveCount(20);
  await expect(page.locator('.anime-card').first()).toHaveAttribute('data-id', '90020');
  await expect(page.locator('.anime-card').last()).toHaveAttribute('data-id', '90039');
  await page.locator('#page-size').selectOption('10');
  await expect(page.locator('.anime-card')).toHaveCount(10);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.locator('.anime-card').first()).toHaveAttribute('data-id', '90030');
  await selectSeason('10');
  await expect(page.locator('.anime-card').first()).toHaveAttribute('data-id', '90060');
  await expect(page.locator('#pager')).toContainText('第 1 /');
  await selectSeason('all');
  await expect(page.locator('.anime-card').first()).toHaveAttribute('data-id', '90000');
  await expect(page.locator('#year-from')).toBeDisabled();
  await expect.poll(() => queries.at(-1)?.filter.air_date).toEqual(['>=2024-01-01', '<2025-01-01']);
  await page.locator('#season-trigger').click();
  await page.screenshot({ path: 'test-results/quarter-desktop.png' });
  await page.setViewportSize({ width: 360, height: 844 });
  await expect(page.locator('#season-menu')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await page.locator('#season-menu').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
  await page.screenshot({ path: 'test-results/quarter-mobile.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('#season-menu')).toBeHidden();
  await page.locator('#season-clear').click();
  await expect(page.locator('#year-from')).toBeEnabled();
  await expect(page.locator('#year-to')).toBeEnabled();
  await expect(page.locator('#year-from')).toHaveValue('2010');
  await expect(page.locator('#year-to')).toHaveValue('2012');
  await selectSeason('1');
  await page.getByRole('button', { name: '重置筛选' }).click();
  await expect(page.locator('#quarter')).toHaveValue('');
  await expect(page.locator('#year-from')).toBeEnabled();
  await expect(page.locator('#year-label')).toHaveText('全部年份');
});

test('movie series skip duration checks and rediscover obsolete negative caches', async ({
  page,
}) => {
  await mock(page);
  const movies = [
    {
      id: 9979,
      name_cn: '机动警察 剧场版',
      date: '1989-07-15',
      runtime: '98分钟',
      duration: '98m',
      other: 321,
    },
    {
      id: 321,
      name_cn: '机动警察 剧场版2',
      date: '1993-08-07',
      runtime: '113分钟',
      duration: '',
      other: 9979,
    },
    {
      id: 237,
      name_cn: '攻壳机动队',
      date: '1995-11-18',
      runtime: '82分钟',
      duration: '',
      other: 238,
    },
    {
      id: 238,
      name_cn: '攻壳机动队2 无罪',
      date: '2004-03-06',
      runtime: '100分钟',
      duration: '',
      other: 237,
    },
  ];
  const detail = (m: (typeof movies)[number]) => ({
    ...subjects[0],
    id: m.id,
    name_cn: m.name_cn,
    date: m.date,
    platform: '剧场版',
    infobox: [],
  });
  await page.addInitScript(() =>
    localStorage.setItem(
      'bbm-series-cache-v4',
      JSON.stringify({
        version: 1,
        records: [9979, 237].map((id) => ({
          scope: 'public',
          id,
          at: Date.now(),
          hint: false,
          result: { entries: [], truncated: false },
        })),
      }),
    ),
  );
  await page.route('https://api.bgm.tv/v0/search/subjects?**', (route) =>
    route.fulfill({ json: { data: [detail(movies[0]), detail(movies[2])], total: 2 } }),
  );
  await page.route('https://api.bgm.tv/v0/subjects/*', (route) => {
    const movie = movies.find(
      (m) => m.id === Number(new URL(route.request().url()).pathname.split('/').pop()),
    );
    return movie ? route.fulfill({ json: detail(movie) }) : route.fallback();
  });
  await page.route('https://api.bgm.tv/v0/subjects/*/subjects', (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    return route.fulfill({
      json: [{ id: movies.find((m) => m.id === id)!.other, type: 2, relation: '续集' }],
    });
  });
  await page.route('https://api.bgm.tv/v0/episodes?**', (route) => {
    const id = Number(new URL(route.request().url()).searchParams.get('subject_id'));
    return route.fulfill({
      json: {
        data: [
          {
            id: id * 10,
            type: 0,
            duration: movies.find((m) => m.id === id)!.duration,
            sort: 1,
            airdate: '1990-01-01',
          },
        ],
        total: 1,
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('.anime-card')).toHaveCount(2);
  for (const [root, sequel] of [
    [9979, 321],
    [237, 238],
  ]) {
    const button = page.locator('.anime-card[data-id="' + root + '"] [data-action="series"]');
    await expect(button).toBeVisible({ timeout: 15000 });
    await button.click();
    await expect(page.locator('.series-row')).toHaveCount(2);
    await expect(page.locator('.series-row[data-series-id="' + sequel + '"]')).toBeVisible();
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  }
  await page.reload();
  await expect(page.locator('.series-spotlight')).toHaveCount(2);
});
