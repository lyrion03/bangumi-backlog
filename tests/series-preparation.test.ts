import { describe, it, expect, vi } from 'vitest';
import { Api } from '../src/api';
import { normalize } from '../src/domain';
import { SeriesCache, SERIES_CACHE_KEY } from '../src/series-cache';
import { prepareSeriesPage } from '../src/series-preparation';
import { Store, STORAGE_KEY } from '../src/store';
function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  } as Storage;
}
const subject = (id: number) =>
  normalize({ id, name: `动画${id}`, date: '2020-01-01', platform: 'TV' });
const controls = () => ({
  cancelled: () => false,
  waitUntilReady: async () => {},
  onHint: vi.fn(),
  onProgress: vi.fn(),
});
describe('durable series preparation', () => {
  it('probes the page before traversal but only highlights confirmed series, then reuses persisted results', async () => {
    const storage = memory();
    const cache = new SeriesCache(storage);
    const api = new Api(0);
    vi.spyOn(api, 'episodes').mockResolvedValue([{ type: 0, duration: '00:24:00' }] as any);
    const events: string[] = [];
    vi.spyOn(api, 'related').mockImplementation(async (id) => {
      events.push(`related:${id}`);
      return id === 1 ? [{ id: 4, type: 2, relation: '续集' }] : [];
    });
    vi.spyOn(api, 'subject').mockImplementation(async (id) => {
      events.push(`subject:${id}`);
      return subject(id);
    });
    const c = controls();
    c.onHint.mockImplementation((id, found) => events.push(`hint:${id}:${found}`));
    await prepareSeriesPage(api, cache, 'public', [1, 2, 3].map(subject), c);
    expect(events.slice(0, 6)).toEqual([
      'related:1',
      'hint:1:false',
      'related:2',
      'hint:2:false',
      'related:3',
      'hint:3:false',
    ]);
    expect(events.indexOf('hint:1:true')).toBeGreaterThan(events.indexOf('subject:4'));
    expect(cache.confirmedHint('public', 1)).toBe(true);
    expect(cache.series('public', 1)?.entries.map((s) => s.id)).toEqual([1, 4]);
    vi.mocked(api.related).mockClear();
    vi.mocked(api.subject).mockClear();
    await prepareSeriesPage(
      api,
      new SeriesCache(storage),
      'public',
      [1, 2, 3].map(subject),
      controls(),
    );
    expect(api.related).not.toHaveBeenCalled();
    expect(api.subject).not.toHaveBeenCalled();
  });
  it('does not persist partial graphs after cancellation or network failure', async () => {
    const cache = new SeriesCache(memory());
    const api = new Api(0);
    vi.spyOn(api, 'episodes').mockResolvedValue([{ type: 0, duration: '00:24:00' }] as any);
    let cancelled = false;
    vi.spyOn(api, 'related').mockResolvedValue([{ id: 4, type: 2, relation: '续集' }]);
    vi.spyOn(api, 'subject').mockImplementation(async (id) => {
      cancelled = true;
      return subject(id);
    });
    await prepareSeriesPage(api, cache, 'public', [subject(1)], {
      ...controls(),
      cancelled: () => cancelled,
    });
    expect(cache.series('public', 1)).toBeUndefined();
    cancelled = false;
    vi.mocked(api.subject).mockRejectedValue(new Error('offline'));
    const result = await prepareSeriesPage(api, cache, 'public', [subject(1)], controls());
    expect(result?.failed).toBe(1);
    expect(cache.series('public', 1)).toBeUndefined();
  });
  it('expires after seven days, isolates account scopes and ignores corrupted storage', () => {
    const storage = memory();
    let time = 1000;
    const cache = new SeriesCache(storage, () => time);
    cache.putSeries('public', 1, { entries: [subject(1), subject(2)], truncated: false });
    expect(cache.series('user-1', 1)).toBeUndefined();
    time += 7 * 24 * 60 * 60 * 1000;
    expect(cache.series('public', 1)).toBeUndefined();
    expect(new SeriesCache(storage, () => time).hint('public', 1)).toBeUndefined();
    storage.setItem(SERIES_CACHE_KEY, 'broken');
    expect(() => new SeriesCache(storage)).not.toThrow();
  });
  it('bounds the cache and tolerates storage quota errors', () => {
    const storage = memory();
    const cache = new SeriesCache(storage);
    for (let id = 1; id <= 610; id++) cache.putHint('public', id, false);
    expect(JSON.parse(storage.getItem(SERIES_CACHE_KEY)!).records).toHaveLength(600);
    expect(cache.hint('public', 1)).toBeUndefined();
    storage.setItem = () => {
      throw new Error('quota');
    };
    expect(() =>
      cache.putSeries('public', 131, { entries: [subject(131)], truncated: false }),
    ).not.toThrow();
  });
});
describe('automatic push preferences', () => {
  it('starts enabled and migrates the former default while preserving an explicit new opt-out', () => {
    const storage = memory();
    expect(new Store(storage).state.settings.realtime).toBe(true);
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, items: {}, settings: { realtime: false } }),
    );
    const store = new Store(storage);
    expect(store.state.settings.realtime).toBe(true);
    store.settings({ realtime: false });
    expect(new Store(storage).state.settings.realtime).toBe(false);
  });
});

it('persists complete series for every member across filters and keeps capped results root-specific', () => {
  const storage = memory();
  const cache = new SeriesCache(storage);
  cache.putSeries('user-1', 1, { entries: [subject(1), subject(2), subject(3)], truncated: false });
  cache.putHint('user-1', 2, false);
  const restored = new SeriesCache(storage);
  expect(restored.series('user-1', 2)?.entries.map((s) => s.id)).toEqual([1, 2, 3]);
  expect(restored.hint('user-1', 2)).toBe(true);
  expect(restored.series('user-2', 2)).toBeUndefined();
  cache.putSeries('user-1', 4, { entries: [subject(4), subject(5)], truncated: true });
  expect(cache.series('user-1', 5)).toBeUndefined();
});
it('retains recently used entries and memory results when optional storage is unavailable', () => {
  const storage = memory();
  const cache = new SeriesCache(storage);
  for (let id = 1; id <= 600; id++) cache.putHint('public', id, false);
  cache.hint('public', 1);
  cache.putHint('public', 601, false);
  expect(cache.hint('public', 1)).toBe(false);
  expect(cache.hint('public', 2)).toBeUndefined();
  storage.setItem = () => {
    throw new Error('denied');
  };
  cache.putSeries('public', 602, { entries: [subject(602), subject(603)], truncated: false });
  expect(cache.series('public', 603)?.entries).toHaveLength(2);
});

it.each(['WEB', '其他', 'short', 'unknown'])(
  'never highlights a persisted candidate whose only sequel is %s',
  async (kind) => {
    const storage = memory();
    new SeriesCache(storage).putHint('public', 1, true);
    const cache = new SeriesCache(storage);
    expect(cache.hint('public', 1)).toBe(true);
    expect(cache.confirmedHint('public', 1)).toBeUndefined();
    const api = new Api(0);
    vi.spyOn(api, 'related').mockImplementation(async (id) =>
      id === 1 ? [{ id: 2, type: 2, relation: '续集' }] : [],
    );
    vi.spyOn(api, 'subject').mockImplementation(async (id) => ({
      ...subject(id),
      platform: id === 2 && ['WEB', '其他'].includes(kind) ? kind : 'TV',
    }));
    vi.spyOn(api, 'episodes').mockImplementation(
      async (id) =>
        [
          {
            type: 0,
            duration:
              id === 2
                ? kind === 'short'
                  ? '00:04:59'
                  : kind === 'unknown'
                    ? ''
                    : '00:24:00'
                : '00:24:00',
          },
        ] as any,
    );
    const c = controls();
    await prepareSeriesPage(api, cache, 'public', [subject(1)], c);
    expect(c.onHint.mock.calls.every(([, found]) => found === false)).toBe(true);
    expect(cache.series('public', 1)?.entries.map((s) => s.id)).toEqual([1]);
    expect(new SeriesCache(storage).confirmedHint('public', 1)).toBe(false);
  },
);

it('restores confirmed badges immediately but keeps failed candidates unconfirmed and retryable', async () => {
  const storage = memory();
  const cache = new SeriesCache(storage);
  cache.putSeries('public', 1, { entries: [subject(1), subject(2)], truncated: false });
  cache.putHint('public', 3, true);
  const restored = new SeriesCache(storage);
  expect(restored.confirmedHint('public', 2)).toBe(true);
  const api = new Api(0);
  vi.spyOn(api, 'subject').mockRejectedValue(new Error('offline'));
  const c = controls();
  await prepareSeriesPage(api, restored, 'public', [subject(3)], c);
  expect(c.onHint).not.toHaveBeenCalledWith(3, true);
  expect(restored.hint('public', 3)).toBe(true);
  expect(restored.confirmedHint('public', 3)).toBeUndefined();
});

it('probe-only pages persist direct hints but do not fetch details or episodes', async () => {
  const api = new Api(0),
    cache = new SeriesCache(memory());
  vi.spyOn(api, 'related').mockResolvedValue([{ id: 2, type: 2, relation: '续集' }]);
  vi.spyOn(api, 'subject').mockResolvedValue(subject(1));
  vi.spyOn(api, 'episodes').mockResolvedValue([]);
  await prepareSeriesPage(api, cache, 'public', [subject(1)], {
    ...controls(),
    probeOnly: true,
    priority: 0,
  });
  expect(api.related).toHaveBeenCalledWith(1, 0);
  expect(api.subject).not.toHaveBeenCalled();
  expect(api.episodes).not.toHaveBeenCalled();
  expect(cache.hint('public', 1)).toBe(true);
  expect(cache.confirmedHint('public', 1)).not.toBe(true);
  expect(cache.series('public', 1)).toBeUndefined();
});
