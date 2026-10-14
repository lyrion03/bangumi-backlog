import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalMirror, MIRROR_KEYS, recordScope } from '../src/local-mirror';
const [records, series, radar, episodes] = MIRROR_KEYS;
const state = (owner: number | null = 42, items = {}) =>
  JSON.stringify({ version: 1, owner, items });
function memory(values: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(values));
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    clear: () => map.clear(),
  };
}
const disk = {
  [records]: state(42, {
    51: {
      status: 'collect',
      markedAt: 1700000000000,
      episodeMarks: { 4: { type: 3, markedAt: 100 } },
    },
  }),
  [series]: JSON.stringify({
    version: 1,
    records: [{ scope: 'user-42', id: 51, at: 100, hint: true }],
  }),
  [radar]: JSON.stringify([['user-42:registered', { at: 101, data: '2012-01-01' }]]),
  [episodes]: JSON.stringify([['42:51', { at: 102, rows: [] }]]),
};
const mirrors: LocalMirror[] = [];
function setup(values = {}, remote = disk) {
  const storage = memory(values),
    saved: any[] = [],
    warn = vi.fn();
  const request = vi.fn(async (_url: any, init?: RequestInit) => {
    if (init?.method === 'POST') {
      saved.push(JSON.parse(init.body as string));
      return Response.json({ savedAt: 10 });
    }
    return Response.json({ version: 1, values: remote, writeKey: 'key' });
  });
  const mirror = new LocalMirror(storage, request as typeof fetch, warn);
  mirrors.push(mirror);
  return { storage, saved, warn, request, mirror };
}
afterEach(() => {
  mirrors.splice(0).forEach((m) => m.stop());
  vi.useRealTimers();
});
describe('portable local data mirror', () => {
  it('restores missing records and caches with original timestamps, without credentials', async () => {
    const x = setup({}, { ...disk, 'bbm-token': 'never-restore' });
    await x.mirror.connect();
    for (const k of MIRROR_KEYS) expect(x.storage.getItem(k)).toBe(disk[k]);
    expect(x.storage.getItem('bbm-token')).toBeNull();
    expect(x.storage.getItem('bbm-onboarding-v1')).toBe('1');
    await x.mirror.flush();
    expect(x.saved[0].values).toEqual(disk);
  });
  it('preserves intentionally empty browser records and caches, even when disk has more data', async () => {
    const browser = {
      [records]: state(),
      [series]: '{"version":1,"records":[]}',
      [radar]: '[]',
      [episodes]: '[]',
      'bbm-token': 'private',
    };
    const x = setup(browser);
    await x.mirror.connect();
    await x.mirror.flush();
    for (const k of MIRROR_KEYS) expect(x.saved[0].values[k]).toBe(browser[k]);
    expect(x.saved[0].values).not.toHaveProperty('bbm-token');
    expect(x.request.mock.calls[0][0]).toContain('?scope=user-42');
  });
  it('fills only absent same-account cache keys', async () => {
    const x = setup({ [records]: state(), [radar]: '[]' });
    await x.mirror.connect();
    expect(x.storage.getItem(records)).toBe(state());
    expect(x.storage.getItem(radar)).toBe('[]');
    expect(x.storage.getItem(episodes)).toBe(disk[episodes]);
  });
  it('never imports another account or overrides a browser changed while loading', async () => {
    const x = setup({ [records]: state(90) });
    await x.mirror.connect();
    expect(x.storage.getItem(series)).toBeNull();
    expect(x.storage.getItem(records)).toBe(state(90));
    const y = setup();
    y.request.mockImplementationOnce(async () => {
      y.storage.setItem(records, state(90));
      return Response.json({ version: 1, values: disk, writeKey: 'key' });
    });
    await y.mirror.connect();
    expect(y.storage.getItem(records)).toBe(state(90));
    expect(y.storage.getItem(radar)).toBeNull();
  });
  it('writes only changed data every five seconds and excludes tokens', async () => {
    vi.useFakeTimers();
    const x = setup({ [records]: state() });
    await x.mirror.connect();
    await vi.advanceTimersByTimeAsync(5000);
    expect(x.saved).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15000);
    expect(x.saved).toHaveLength(1);
    x.mirror.setItem('bbm-token', 'secret');
    await vi.advanceTimersByTimeAsync(5000);
    expect(x.saved).toHaveLength(1);
    x.mirror.setItem(records, state(42, { 51: { status: 'not_interested' } }));
    await vi.advanceTimersByTimeAsync(4999);
    expect(x.saved).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(x.saved).toHaveLength(2);
    expect(JSON.parse(x.saved[1].values[records]).items[51].status).toBe('not_interested');
  });
  it('recovers the write key after restarting the launcher without restoring old records', async () => {
    const x = setup({ [records]: state() });
    await x.mirror.connect();
    x.request
      .mockImplementationOnce(async () => new Response('', { status: 403 }))
      .mockImplementationOnce(async () =>
        Response.json({ version: 1, writeKey: 'new-key', values: disk }),
      );
    await x.mirror.flush();
    expect(x.saved).toHaveLength(1);
    expect((x.request.mock.calls.at(-1)![1]!.headers as any)['X-Backlog-Key']).toBe('new-key');
    expect(x.storage.getItem(records)).toBe(state());
    expect(x.warn).not.toHaveBeenCalled();
  });
  it('retains changes made during a disk write for the next batch', async () => {
    const x = setup({ [records]: state() });
    await x.mirror.connect();
    let release!: () => void;
    x.request.mockImplementationOnce(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return Response.json({});
    });
    const first = x.mirror.flush();
    x.mirror.setItem(records, state(42, { 10: { status: 'wish' } }));
    release();
    await first;
    await x.mirror.flush();
    expect(JSON.parse(x.saved[0].values[records]).items[10].status).toBe('wish');
  });
  it('retries failed writes with current data, leaving browser records intact', async () => {
    const x = setup({ [records]: state() });
    await x.mirror.connect();
    x.request.mockImplementationOnce(async () => new Response('', { status: 503 }));
    await x.mirror.flush();
    x.mirror.setItem(records, state(42, { 99: { status: 'doing' } }));
    await x.mirror.flush();
    expect(x.warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(x.saved[0].values[records]).items[99].status).toBe('doing');
  });
  it('does not overwrite either side when records are corrupt or disk cannot load', async () => {
    const x = setup({ [records]: '{broken' });
    await x.mirror.connect();
    await x.mirror.flush();
    expect(x.request).not.toHaveBeenCalled();
    const y = setup({ [records]: state() });
    y.request.mockImplementationOnce(async () => new Response('', { status: 503 }));
    await y.mirror.connect();
    await y.mirror.flush();
    expect(y.saved).toHaveLength(0);
    expect(y.storage.getItem(records)).toBe(state());
  });
  it('continues normal browser use with a dev/static server', async () => {
    const x = setup({ [records]: state() });
    x.request.mockImplementationOnce(async () => new Response('', { status: 404 }));
    await x.mirror.connect();
    x.mirror.setItem(records, state(null));
    await x.mirror.flush();
    expect(x.saved).toHaveLength(0);
    expect(x.warn).not.toHaveBeenCalled();
  });
  it('keeps large exit copies pending, then flushes normally', async () => {
    const raw = state(42, { 51: { comment: '中'.repeat(60000) } });
    const x = setup({ [records]: raw });
    await x.mirror.connect();
    await x.mirror.flush(true);
    expect(x.saved).toHaveLength(0);
    await x.mirror.flush();
    expect(x.saved[0].values[records]).toBe(raw);
  });
  it('captures changes from other tabs without sending duplicate copies', async () => {
    const x = setup({ [records]: state() });
    await x.mirror.connect();
    await x.mirror.flush();
    x.storage.setItem(records, state(null));
    x.mirror.changedElsewhere();
    await x.mirror.flush();
    expect(x.saved[1].scope).toBe('local');
    x.mirror.changedElsewhere();
    await x.mirror.flush();
    expect(x.saved).toHaveLength(2);
  });
  it('preserves the complete disk copy when browser quota blocks part of a restore', async () => {
    const x = setup();
    const write = x.storage.setItem.bind(x.storage);
    x.storage.setItem = (key, value) => {
      if (key === radar) throw Error('quota');
      write(key, value);
    };
    await x.mirror.connect();
    await x.mirror.flush();
    expect(x.saved).toHaveLength(0);
    expect(x.warn).toHaveBeenCalledOnce();
    expect(x.storage.getItem(records)).toBe(disk[records]);
  });
  it('validates scopes without confusing empty state with missing state', () => {
    expect(recordScope(null)).toBeNull();
    expect(recordScope(state(null))).toBe('local');
    expect(recordScope(state())).toBe('user-42');
    expect(recordScope('{"version":1,"items":[]}')).toBeNull();
    expect(recordScope(state(-1))).toBeNull();
  });
});
