import { afterEach, expect, it, vi } from 'vitest';
import { Api } from '../src/api';
import { defaults } from '../src/domain';
import { FilteredPager } from '../src/filtered-pager';
afterEach(() => vi.unstubAllGlobals());
it('search sends positive candidates but keeps weighted exclusions local, with bounded pagination and sends authentication only to the fixed API host', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ data: [], total: 0 }), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  const api = new Api(0);
  api.token = 'fixture-token';
  await api.search({
    ...defaults(),
    tags: ['科幻'],
    excluded: ['后宫'],
    from: '2020',
    to: '2025',
    page: 2,
  });
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('https://api.bgm.tv/v0/search/subjects?limit=20&offset=20');
  expect(JSON.parse(init.body).filter).toEqual({
    type: [2],
    tag: ['科幻'],

    air_date: ['>=2020-01-01', '<=2025-12-31'],
    nsfw: false,
  });
  expect(init.headers.Authorization).toBe('Bearer fixture-token');
  await expect(api.request('GET', 'https://example.com/v0/me')).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('handles 204 without parsing a nonexistent JSON body', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  const api = new Api(0);
  expect(await api.request('POST', '/v0/users/-/collections/1', { type: 2 })).toBeNull();
  expect(api.logs[0].status).toBe(204);
});
it('isolates authorization snapshots and keeps tokens out of logs', async () => {
  const fetcher = vi.fn().mockImplementation(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  const api = new Api(0);
  api.token = 'first';
  const pending = api.me();
  api.token = 'second';
  await pending;
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer first');
  expect(JSON.stringify(api.logs)).not.toContain('first');
});
it('surfaces expired authentication with a useful error', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
  await expect(new Api(0).me()).rejects.toThrow('令牌无效或已过期');
});

it('empty rank browsing uses the full official chart and preserves global rank across pages', async () => {
  const api = new Api(0);
  const request = vi.spyOn(api, 'request').mockResolvedValue({
    total: 9036,
    data: [
      { id: 2, rating: { rank: 22, score: 9.4 } },
      { id: 1, rating: { rank: 21, score: 8.5 } },
      { id: 3, rating: { rank: 0 } },
    ],
  });
  const result = await api.search({ ...defaults(), sort: 'rank', page: 2 });
  expect(request).toHaveBeenCalledWith(
    'GET',
    '/v0/subjects?type=2&sort=rank&limit=20&offset=20',
    undefined,
    '',
    1,
  );
  expect(result.total).toBe(9036);
  expect(result.data.map((s) => s.rank)).toEqual([21, 22]);
});
it('filtered ranking excludes unranked candidates and empty matching falls back to heat', async () => {
  const api = new Api(0);
  const request = vi.spyOn(api, 'request').mockResolvedValue({ total: 0, data: [] });
  await api.search({ ...defaults(), sort: 'rank', tags: ['科幻'] });
  expect(request.mock.calls[0][2]).toMatchObject({
    sort: 'rank',
    filter: { rank: ['>0'], tag: ['科幻'] },
  });
  await api.search({ ...defaults(), sort: 'match', keyword: '  ' });
  expect(request.mock.calls[1][2]).toMatchObject({ keyword: '', sort: 'heat' });
});

it('locally enforces content rating even when the official search ignores its filter', async () => {
  const api = new Api(0);
  api.token = 'fixture';
  const request = vi.spyOn(api, 'request').mockResolvedValue({
    total: 2,
    data: [
      { id: 1, nsfw: false },
      { id: 2, nsfw: true },
    ],
  });
  expect((await api.search({ ...defaults(), nsfw: 'hide' })).data.map((s) => s.id)).toEqual([1]);
  expect(
    (await api.search({ ...defaults(), nsfw: 'only', keyword: '测试' })).data.map((s) => s.id),
  ).toEqual([2]);
  expect((await api.search({ ...defaults(), nsfw: 'all' })).data.map((s) => s.id)).toEqual([1, 2]);
  expect(request.mock.calls[0][2]).toMatchObject({ filter: { nsfw: false } });
  expect(request.mock.calls[1][2]).toMatchObject({ filter: { nsfw: true } });
  expect((request.mock.calls[2][2] as any).filter).not.toHaveProperty('nsfw');
});

const nsfwFilters = { ...defaults(), nsfw: 'only' };
it('NSFW keyword pages load on demand, share requests and isolate tokens', async () => {
  const api = new Api(0);
  api.token = 'fixture';
  const request = vi.spyOn(api, 'request').mockImplementation(async (_method, path) => {
    const offset = Number(new URL('https://api.bgm.tv' + path).searchParams.get('offset'));
    return {
      total: 60,
      data: Array.from({ length: 20 }, (_, i) => ({ id: offset + i + 1, nsfw: offset >= 20 })),
    } as any;
  });
  const pager = new FilteredPager();
  const fetch = (page: number) => api.search({ ...nsfwFilters, keyword: '测试', page });
  const first = await pager.page(
    'q',
    1,
    20,
    fetch,
    () => true,
    () => false,
    false,
  );
  expect(first.data[0].id).toBe(21);
  expect(first.exact).toBe(false);
  expect(request).toHaveBeenCalledTimes(2);
  await fetch(2);
  expect(request).toHaveBeenCalledTimes(2);
  const second = await pager.page(
    'q',
    2,
    20,
    fetch,
    () => true,
    () => false,
    false,
  );
  expect(second.data[0].id).toBe(41);
  expect(second.exact).toBe(true);
  api.token = 'other';
  await fetch(2);
  expect(request).toHaveBeenCalledTimes(4);
});
it('NSFW keyword scanning stops at 1000 candidates and skips empty source chunks', async () => {
  const api = new Api(0);
  api.token = 'fixture';
  const request = vi.spyOn(api, 'request').mockResolvedValue({
    total: 5000,
    data: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, nsfw: false })),
  });
  const result = await new FilteredPager().page(
    'q',
    1,
    20,
    (page) => api.search({ ...nsfwFilters, keyword: '测试', page }),
    () => true,
    () => false,
    false,
  );
  expect(result).toMatchObject({ total: 0, data: [], exact: true });
  expect(request).toHaveBeenCalledTimes(50);
});
it('NSFW browse fills the first page without scanning the full catalog and preserves server rank order', async () => {
  const api = new Api(0);
  api.token = 'fixture';
  const request = vi.spyOn(api, 'request').mockImplementation(async (_m, path) => {
    const offset = Number(new URL('https://api.bgm.tv' + path).searchParams.get('offset'));
    return {
      total: 32828,
      data: Array.from({ length: 100 }, (_, i) => ({
        id: offset + i + 1,
        nsfw: i < 20,
        date: '2020-01-01',
        rating: { rank: offset + i + 1, score: 8 },
      })),
    } as any;
  });
  const fetch = (page: number) => api.search({ ...nsfwFilters, sort: 'rank', page }, 0);
  const pager = new FilteredPager();
  const first = await pager.page(
    'q',
    1,
    20,
    fetch,
    () => true,
    () => false,
    false,
  );
  expect(first.data.map((s) => s.rank)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]).toEqual([
    'GET',
    '/v0/subjects?type=2&sort=rank&limit=100&offset=0',
    undefined,
    'fixture',
    0,
  ]);
  const second = await pager.page(
    'q',
    2,
    20,
    fetch,
    () => true,
    () => false,
    false,
  );
  expect(second.data[0].rank).toBe(101);
  expect(request).toHaveBeenCalledTimes(2);
  await pager.page(
    'q',
    1,
    10,
    fetch,
    () => true,
    () => false,
    false,
  );
  expect(request).toHaveBeenCalledTimes(2);
});
it('NSFW browse can scan beyond 1000 when needed, reuse chunks across filters and stop at exhaustion', async () => {
  const api = new Api(0);
  api.token = 'fixture';
  const request = vi.spyOn(api, 'request').mockImplementation(async (_m, path) => {
    const offset = Number(new URL('https://api.bgm.tv' + path).searchParams.get('offset'));
    return {
      total: 1100,
      data: Array.from({ length: 100 }, (_, i) => ({
        id: offset + i + 1,
        nsfw: offset >= 1000,
        date: '2020-01-01',
      })),
    } as any;
  });
  const result = await new FilteredPager().page(
    'q',
    1,
    20,
    (page) => api.search({ ...nsfwFilters, page }),
    () => true,
    () => false,
    false,
  );
  expect(result.data[0].id).toBe(1001);
  expect(result.total).toBe(100);
  expect(result.exact).toBe(true);
  expect(request).toHaveBeenCalledTimes(11);
  expect((await api.search({ ...nsfwFilters, page: 11, from: '2021' })).data).toEqual([]);
  expect(request).toHaveBeenCalledTimes(11);
});
it('NSFW browse requires authentication and returns exhausted empty chunks without mistaking them for access denial', async () => {
  const api = new Api(0);
  const request = vi
    .spyOn(api, 'request')
    .mockResolvedValue({ total: 1, data: [{ id: 1, nsfw: false }] });
  await expect(api.search(nsfwFilters)).rejects.toThrow('先在同步中心');
  expect(request).not.toHaveBeenCalled();
  api.token = 'fixture';
  expect(await api.search(nsfwFilters)).toMatchObject({ data: [], hasMore: false });
});

it('date priority browses in server order and applies rating, years, keywords, tags and NSFW locally', async () => {
  const api = new Api(0);
  const request = vi.spyOn(api, 'request').mockResolvedValue({
    total: 4,
    data: [
      {
        id: 4,
        name: '目标四',
        date: '2025-01-01',
        nsfw: true,
        rating: { score: 9 },
        tags: [{ name: '科幻', count: 100 }],
      },
      {
        id: 3,
        name: '目标三',
        date: '2024-01-01',
        nsfw: false,
        rating: { score: 8 },
        tags: [{ name: '科幻', count: 100 }],
      },
      {
        id: 2,
        name: '目标二',
        date: '2023-01-01',
        nsfw: false,
        rating: { score: 7 },
        tags: [{ name: '科幻', count: 100 }],
      },
      {
        id: 1,
        name: '目标一',
        date: '2020-01-01',
        nsfw: false,
        rating: { score: 5 },
        tags: [{ name: '科幻', count: 100 }],
      },
    ],
  });
  const filters = {
    ...defaults(),
    sort: 'date',
    keyword: '目标',
    from: '2023',
    to: '2025',
    tags: ['科幻'],
    rating: 7,
  };
  expect((await api.search(filters, 0)).data.map((s) => s.id)).toEqual([3, 2]);
  expect(request).toHaveBeenCalledWith(
    'GET',
    '/v0/subjects?type=2&sort=date&limit=100&offset=0',
    undefined,
    '',
    0,
  );
  expect((await api.search({ ...filters, nsfw: 'all' })).data.map((s) => s.id)).toEqual([4, 3, 2]);
  expect(request).toHaveBeenCalledTimes(1);
});
it('search and foreground detail dependencies carry their priority through every API path', async () => {
  const api = new Api(0);
  const request = vi.spyOn(api, 'request').mockResolvedValue({ total: 0, data: [] });
  await api.search(defaults(), 0);
  await api.characters(1, 2);
  await api.episodeCollections(1, 2);
  expect(request.mock.calls.map((c) => c[4])).toEqual([0, 2, 2]);
});
