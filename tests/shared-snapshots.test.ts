import { afterEach, expect, it, vi } from 'vitest';
import { Api } from '../src/api';
import { Store } from '../src/store';
import { createBackup } from '../src/backup';
import { analyzeRadar } from '../src/radar-data';
import { normalize } from '../src/domain';
import { EPISODE_CACHE_TTL } from '../src/episode-cache';
import { Sync } from '../src/sync';
const account = { id: 42, username: 'fixture', nickname: '昵称' };
const subject = (id: number) => ({
  id,
  type: 2,
  name: '作品' + id,
  platform: 'TV',
  date: '2020-01-01',
  eps: 2,
  rating: { score: 8, total: 1000 },
  infobox: [{ key: '放送结束', value: '2020年1月1日' }],
});
const rows = (id: number) =>
  [0, 1, 2].map((i) => ({
    episode: {
      id: id * 100 + i,
      type: i === 2 ? 1 : 0,
      airdate: '2020-01-01',
      sort: i + 1,
      ep: i + 1,
      name: '单集',
      name_cn: '',
    },
    type: i === 1 ? 3 : 2,
    updated_at: 1700000000 + i,
  }));
function setup(count = 2) {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) || null,
    setItem: (k: string, v: string) => values.set(k, v),
  } as Storage;
  const store = new Store(storage);
  store.bind(account);
  store.mark(
    Array.from({ length: count }, (_, i) => normalize(subject(i + 1))),
    'doing',
  );
  const api = new Api(0, 6);
  api.token = 'secret-fixture';
  const calls: string[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://localhost');
    const path = u.pathname;
    calls.push((init?.method || 'GET') + ' ' + path);
    let data: unknown = {};
    if (path.startsWith('/__bangumi/')) data = { id: 42, registered: '2012-01-01' };
    else if (path.includes('/collections/') && path.endsWith('/episodes')) {
      const id = Number(path.split('/')[5]);
      data = { total: 3, data: rows(id) };
    } else if (/^\/v0\/subjects\/\d+$/.test(path)) data = subject(Number(path.split('/').pop()));
    else if (path.endsWith('/subjects')) data = [];
    else if (path === '/v0/episodes') {
      const r = rows(Number(u.searchParams.get('subject_id')));
      data = { total: r.length, data: r.map((v) => v.episode) };
    }
    return new Response(JSON.stringify(data));
  });
  vi.stubGlobal('fetch', fetcher);
  const radar = (client = api) =>
    analyzeRadar({
      api: client,
      items: store.all(),
      account,
      storage,
      signal: new AbortController().signal,
      onProgress: () => {},
    });
  const backup = (client = api) => createBackup(store, client, () => {}, storage);
  return { api, store, storage, calls, fetcher, radar, backup };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it.each(['backup', 'radar'] as const)(
  'reuses %s snapshots in the other feature and after reload, retaining SP, mixed states and timestamps',
  async (first) => {
    const s = setup();
    await s[first]();
    s.calls.length = 0;
    const second = first === 'backup' ? 'radar' : 'backup';
    await s[second]();
    expect(s.calls.filter((p) => p.includes('/collections/') || p === 'GET /v0/episodes')).toEqual(
      [],
    );
    const reloaded = new Api(0, 6);
    reloaded.token = s.api.token;
    s.calls.length = 0;
    const result = await s.backup(reloaded);
    await s.radar(reloaded);
    expect(s.calls).toEqual([]);
    expect(result.items[0].episodes).toEqual(
      rows(1).map((r) => ({
        id: r.episode.id,
        type: r.type,
        markedAt: new Date(r.updated_at * 1000).toISOString(),
      })),
    );
    expect(s.storage.getItem('bbm-episode-snapshots-v1')).not.toContain('secret-fixture');
  },
);
it('overlays a new local edit on the shared cloud snapshot without rereading it', async () => {
  const s = setup(1);
  await s.radar();
  s.calls.length = 0;
  s.store.mark([normalize(subject(1))], 'doing', { episodeChanges: { 101: 0 } });
  const result = await s.backup();
  expect(result.items[0].episodes.find((e) => e.id === 101)?.type).toBe(0);
  expect(result.items[0].episodes.find((e) => e.id === 101)?.markedAt).not.toBeNull();
  expect(s.calls).toEqual([]);
  await s.radar();
  expect(s.calls).toEqual([]);
});
it('expires snapshots and isolates accounts even with the same test token', async () => {
  const s = setup(1);
  await s.backup();
  s.calls.length = 0;
  s.api.configureEpisodeCache(s.storage, 99);
  await s.api.episodeCollections(1);
  expect(s.calls).toHaveLength(1);
  s.calls.length = 0;
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + EPISODE_CACHE_TTL + 1);
  await s.backup();
  expect(s.calls).toHaveLength(1);
});
it('invalidates persisted snapshots on writes and explicit sync pull', async () => {
  const s = setup(1);
  await s.backup();
  await s.api.request('PATCH', '/v0/users/-/collections/1/episodes', {
    episode_id: [100],
    type: 3,
  });
  const reloaded = new Api(0, 6);
  reloaded.token = s.api.token;
  s.calls.length = 0;
  await s.backup(reloaded);
  expect(s.calls).toHaveLength(1);
  vi.spyOn(reloaded, 'collections').mockResolvedValue({ total: 0, data: [] });
  await new Sync(s.store, reloaded).pull(account);
  s.calls.length = 0;
  await s.backup(reloaded);
  expect(s.calls).toHaveLength(1);
});
it('does not cache partial or failed paginated reads and retries all missing pages', async () => {
  const s = setup(1);
  s.api.configureEpisodeCache(s.storage, 42);
  const request = vi
    .spyOn(s.api, 'request')
    .mockResolvedValueOnce({ total: 4, data: rows(1) })
    .mockResolvedValueOnce({ total: 4, data: [] });
  await expect(s.api.episodeCollections(1)).rejects.toThrow('未读取完整');
  s.api.flushEpisodeCache();
  expect(s.storage.getItem('bbm-episode-snapshots-v1')).toBeNull();
  request.mockResolvedValueOnce({ total: 3, data: rows(1) });
  await expect(s.api.episodeCollections(1)).resolves.toHaveLength(3);
  expect(request).toHaveBeenCalledTimes(3);
});
it('loads six subjects concurrently and includes sequels discovered by a partial batch', async () => {
  const s = setup(7);
  let active = 0,
    peak = 0;
  const request = vi.spyOn(s.api, 'request').mockImplementation(async (_method, path) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    const match = path.match(/^\/v0\/subjects\/(\d+)$/);
    if (match) return subject(Number(match[1])) as any;
    if (path.endsWith('/subjects'))
      return path === '/v0/subjects/7/subjects'
        ? ([{ id: 8, type: 2, relation: '续集' }] as any)
        : [];
    if (path.includes('/collections/'))
      return { data: rows(Number(path.split('/')[5])), total: 3 } as any;
    return { total: 3, data: rows(8).map((v) => v.episode) } as any;
  });
  await s.radar();
  expect(peak).toBe(6);
  expect(request.mock.calls.some((c) => c[1] === '/v0/subjects/8')).toBe(true);
});
it('keeps completed snapshots on cancellation but never persists an interrupted subject', async () => {
  const s = setup(1);
  s.api.configureEpisodeCache(s.storage, 42);
  await s.api.episodeCollections(1);
  const controller = new AbortController();
  const request = vi.spyOn(s.api, 'request').mockImplementation(async () => {
    controller.abort();
    return { total: 3, data: rows(2) } as any;
  });
  await expect(s.api.episodeCollections(2, -1, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  s.api.flushEpisodeCache();
  request.mockRestore();
  s.calls.length = 0;
  const reloaded = new Api(0);
  reloaded.token = s.api.token;
  reloaded.configureEpisodeCache(s.storage, 42);
  await reloaded.episodeCollections(1);
  expect(s.calls).toEqual([]);
  await reloaded.episodeCollections(2);
  expect(s.calls).toHaveLength(1);
});

it('exports with six read workers and avoids additional reads on immediate repetition', async () => {
  const s = setup(12);
  let active = 0,
    peak = 0;
  const request = vi.spyOn(s.api, 'request').mockImplementation(async (_method, path) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return { data: rows(Number(path.split('/')[5])), total: 3 } as any;
  });
  await s.backup();
  expect(peak).toBe(6);
  expect(request).toHaveBeenCalledTimes(12);
  await s.backup();
  expect(request).toHaveBeenCalledTimes(12);
});
it('preserves live reads when browser persistence is unavailable', async () => {
  const s = setup(1);
  const blocked = {
    getItem: () => {
      throw Error('blocked');
    },
    setItem: () => {
      throw Error('quota');
    },
  } as unknown as Storage;
  s.api.configureEpisodeCache(blocked, 42);
  await expect(s.api.episodeCollections(1)).resolves.toHaveLength(3);
  expect(() => s.api.flushEpisodeCache()).not.toThrow();
  s.calls.length = 0;
  await s.api.episodeCollections(1);
  expect(s.calls).toEqual([]);
});
