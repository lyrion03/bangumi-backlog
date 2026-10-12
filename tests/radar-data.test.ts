import { afterEach, it, expect, vi } from 'vitest';
import { analyzeRadar, RadarCache } from '../src/radar-data';
import { Api, ApiError } from '../src/api';
import { validateItem } from '../src/domain';
const storage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) || null,
    setItem: (k: string, v: string) => data.set(k, v),
  } as Storage;
};
const raw = {
  id: 1,
  type: 2,
  name: '测试正篇',
  platform: 'TV',
  date: '2020-01-01',
  eps: 1,
  rating: { score: 8, total: 1000 },
  tags: [{ name: '日常', count: 100 }],
  infobox: [{ key: '放送结束', value: '2020年1月1日' }],
};
function setup() {
  const api = new Api(0);
  const request = vi.spyOn(api, 'request').mockImplementation(async (method, path) => {
    if (path === '/v0/subjects/1') return raw as any;
    if (path.endsWith('/subjects')) return [] as any;
    return { data: [{ id: 101, type: 0, airdate: '2020-01-01' }], total: 1 } as any;
  });
  const options = {
    api,
    items: [validateItem({ ...raw, status: 'collect' })],
    account: null,
    storage: storage(),
    signal: new AbortController().signal,
    onProgress: vi.fn(),
  };
  return { api, request, options };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('does no eager work, only makes low-priority GETs, and resumes from bounded local caches', async () => {
  const { api, request, options } = setup();
  expect(request).not.toHaveBeenCalled();
  const result = await analyzeRadar(options);
  expect(result.completed).toBe(1);
  expect(request).toHaveBeenCalledTimes(3);
  for (const args of request.mock.calls) {
    expect(args[0]).toBe('GET');
    expect(args[4]).toBe(-1);
    expect(args[5]).toBe(options.signal);
  }
  request.mockClear();
  expect((await analyzeRadar(options)).scores).toEqual(result.scores);
  expect(request).not.toHaveBeenCalled();
  expect(api.token).toBe('');
});
it('honors cancellation between requests and skips wish/exclusion network work', async () => {
  const { request, options } = setup();
  const controller = new AbortController();
  request.mockImplementationOnce(async () => {
    controller.abort();
    return raw as any;
  });
  await expect(analyzeRadar({ ...options, signal: controller.signal })).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(request).toHaveBeenCalledTimes(1);
  request.mockClear();
  const r = await analyzeRadar({
    ...options,
    items: ['wish', 'not_interested'].map((status, i) =>
      validateItem({ ...raw, id: i + 10, status }),
    ),
  });
  expect(r.started).toBe(0);
  expect(request).not.toHaveBeenCalled();
});
it('uses public registration without credentials, caches by account and never persists a token', async () => {
  const { api, options, request } = setup();
  api.token = 'test-only-secret';
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(JSON.stringify({ id: Number(url.split('/').pop()), registered: '2012-01-01' })),
  );
  vi.stubGlobal('fetch', fetcher);
  const a = { ...options, account: { id: 100, username: 'testuser' } };
  const r = await analyzeRadar(a);
  expect(r.base).toBe(72);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'omit' });
  await analyzeRadar(a);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await analyzeRadar({ ...a, account: { id: 200, username: 'another' } });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(options.storage.getItem('bbm-radar-data-v1')).not.toContain('test-only-secret');
  expect(request.mock.calls.every((c) => c[0] === 'GET')).toBe(true);
});
it('does not continue chapter/series analysis after rate limiting or auth expiry', async () => {
  for (const status of [401, 429]) {
    const { request, options } = setup();
    request.mockImplementation(async (_method, path) => {
      if (path === '/v0/subjects/1') return raw as any;
      throw new ApiError('暂停', status);
    });
    await expect(analyzeRadar(options)).rejects.toMatchObject({ status });
    expect(request).toHaveBeenCalledTimes(2);
  }
});
it('leaves missing registration unknown and lets local records produce a chart', async () => {
  const { options } = setup();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 404 })),
  );
  const r = await analyzeRadar({ ...options, account: { id: 100, username: 'test' } });
  expect(r.registered).toBeNull();
  expect(r.scores[4]).toBe(100);
});
it('expires cached data and tolerates full or disabled browser storage', () => {
  const s = storage();
  let now = 1000;
  const c = new RadarCache(s, () => now);
  c.put('a', { ok: true });
  expect(c.get('a', 100)).toEqual({ ok: true });
  now += 101;
  expect(c.get('a', 100)).toBeUndefined();
  const blocked = {
    getItem: () => null,
    setItem: () => {
      throw Error('quota');
    },
  } as unknown as Storage;
  expect(() => new RadarCache(blocked).put('a', { ok: true })).not.toThrow();
});
