import { describe, it, expect, vi } from 'vitest';
import { Store, STORAGE_KEY } from '../src/store';
import { STATUS, normalize, validateItem, statusFromType } from '../src/domain';
import { Sync, collectionPayload } from '../src/sync';
import { Api } from '../src/api';
function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  } as Storage;
}
const subject = (id = 1) => normalize({ id, name_cn: '测试动画', date: '2020-01-01' });
const item = (id = 1) => validateItem({ ...subject(id), status: 'collect', dirty: false });
describe('collection data integrity', () => {
  it('uses the official watched / watching mapping', () => {
    expect(STATUS.collect.type).toBe(2);
    expect(STATUS.doing.type).toBe(3);
    expect(statusFromType(2)).toBe('collect');
  });
  it('does not touch the legacy namespace or persist credentials', () => {
    const storage = memory();
    storage.setItem('bgm-tracker-v1', 'legacy');
    const store = new Store(storage);
    store.mark([subject()], 'collect');
    expect(storage.getItem('bgm-tracker-v1')).toBe('legacy');
    expect(store.export()).not.toHaveProperty('token');
  });
  it('keeps changes dirty when an older request finishes', () => {
    const store = new Store(memory());
    store.mark([subject()], 'collect');
    const revision = store.get(1)!.revision;
    store.mark([subject()], 'on_hold');
    store.synced(1, revision);
    expect(store.get(1)!.dirty).toBe(true);
    expect(store.get(1)!.status).toBe('on_hold');
  });
  it('preserves unsynced edits and local exclusions while pulling', () => {
    const store = new Store(memory());
    store.mark([subject(1)], 'on_hold');
    store.mark([subject(2)], 'not_interested');
    expect(store.merge([item(1), item(2), item(3)])).toBe(1);
    expect(store.get(1)!.status).toBe('on_hold');
    expect(store.get(2)!.status).toBe('not_interested');
  });
  it('validates all imported items before writing, rejecting poisoned ids', () => {
    const store = new Store(memory());
    expect(() =>
      store.parseImport({ items: [item(1), { id: '__proto__', status: 'collect' }] }),
    ).toThrow();
    expect(store.all()).toHaveLength(0);
  });
  it('imports old backups without overwriting duplicates or trusting synced flags', () => {
    const store = new Store(memory());
    store.mark([subject()], 'on_hold');
    const items = store.parseImport({ type: 'bangumi-tracker', items: [item(1), item(2)] });
    expect(store.import(items)).toBe(1);
    expect(store.get(1)!.status).toBe('on_hold');
    expect(store.get(2)!.dirty).toBe(true);
  });
  it('surfaces quota failure without claiming a saved change', () => {
    const storage = memory();
    const store = new Store(storage);
    storage.setItem = () => {
      throw new Error('quota');
    };
    expect(() => store.mark([subject()], 'collect')).toThrow('本地保存失败');
    expect(store.all()).toHaveLength(0);
  });
  it('blocks corrupt saved data from being overwritten', () => {
    const storage = memory();
    storage.setItem(STORAGE_KEY, 'bad-json');
    const store = new Store(storage);
    expect(store.loadError).toBeTruthy();
    expect(() => store.mark([subject()], 'collect')).toThrow();
    expect(storage.getItem(STORAGE_KEY)).toBe('bad-json');
  });
  it('restricts image URLs to HTTPS', () => {
    expect(normalize({ id: 1, image: 'javascript:alert(1)' }).image).toBe('');
  });
  it('sends cleared rating and comment when explicitly edited', () => {
    const store = new Store(memory());
    store.mark([subject()], 'collect', { rate: 0, comment: '', private: false });
    expect(collectionPayload(store.get(1)!)).toMatchObject({
      type: 2,
      rate: 0,
      comment: '',
      private: false,
    });
  });
  it('quick status marks do not erase unpulled remote metadata', () => {
    const store = new Store(memory());
    store.mark([subject()], 'collect');
    expect(collectionPayload(store.get(1)!)).toEqual({ type: 2 });
    store.mark([subject()], 'collect', { rate: 8, comment: '已编辑' });
    store.synced(1, store.get(1)!.revision);
    store.mark([subject()], 'on_hold');
    expect(collectionPayload(store.get(1)!)).toEqual({ type: 4 });
  });
  it('prevents accidental cross-account reuse', () => {
    const store = new Store(memory());
    store.bind({ id: 1, username: 'one', nickname: '' });
    store.mark([subject()], 'collect');
    expect(() => store.bind({ id: 2, username: 'two', nickname: '' })).toThrow('另一个账号');
  });
});
describe('sync engine', () => {
  function setup() {
    const store = new Store(memory());
    const api = new Api(0);
    api.token = 'test-token';
    const request = vi.spyOn(api, 'request').mockResolvedValue(null);
    const episodes = vi.spyOn(api, 'episodes').mockResolvedValue([
      { id: 10, type: 0, airdate: '2020-01-01' },
      { id: 11, type: 1, airdate: '2020-01-01' },
      { id: 12, type: 0, airdate: '2099-01-01' },
      { id: 13, type: 0, airdate: '' },
    ] as any);
    return { store, api, request, episodes, sync: new Sync(store, api) };
  }
  it('batches only aired normal episodes when marking watched', async () => {
    const { store, request, sync } = setup();
    store.mark([subject()], 'collect');
    await sync.push();
    expect(request).toHaveBeenCalledWith(
      'PATCH',
      '/v0/users/-/collections/1/episodes',
      { episode_id: [10], type: 2 },
      'test-token',
    );
    expect(store.get(1)!.dirty).toBe(false);
  });
  it('does not modify episode progress for on-hold or dropped items', async () => {
    const { store, request, episodes, sync } = setup();
    store.mark([subject()], 'on_hold');
    await sync.push();
    expect(episodes).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('retains failures for retry without falsely marking them synced', async () => {
    const { store, request, sync } = setup();
    store.mark([subject()], 'collect');
    request.mockRejectedValue(new Error('network'));
    await sync.push();
    expect(store.get(1)!.dirty).toBe(true);
    expect(store.get(1)!.error).toBe('network');
    expect(sync.progress.failed).toBe(1);
  });
  it('explicit episode undo overrides complete-all', async () => {
    const { store, request, sync } = setup();
    store.mark([subject()], 'collect', { episodeChanges: { 10: 0 } });
    await sync.push();
    expect(request).toHaveBeenCalledWith(
      'PATCH',
      '/v0/users/-/collections/1/episodes',
      { episode_id: [10], type: 0 },
      'test-token',
    );
    expect(request.mock.calls.filter((c) => c[0] === 'PATCH')).toHaveLength(1);
  });
  it('stops safely between items and leaves the rest pending', async () => {
    const { store, request, sync } = setup();
    store.mark([subject(1), subject(2)], 'on_hold');
    request.mockImplementation(async () => {
      sync.cancel();
      return null;
    });
    await sync.push();
    expect(store.get(1)!.dirty).toBe(false);
    expect(store.get(2)!.dirty).toBe(true);
    expect(sync.progress.active).toBe(false);
  });
  it('never sends a local-only exclusion', async () => {
    const { store, request, sync } = setup();
    store.mark([subject()], 'not_interested');
    await sync.push([1]);
    expect(request).not.toHaveBeenCalled();
  });
});

it('does not acknowledge a removed and recreated record with an old request', () => {
  const store = new Store(memory());
  store.mark([subject()], 'collect');
  const revision = store.get(1)!.revision;
  store.remove([1]);
  store.mark([subject()], 'on_hold');
  store.synced(1, revision);
  expect(store.get(1)!.dirty).toBe(true);
  expect(store.get(1)!.status).toBe('on_hold');
});

describe('official collection pull status mapping', () => {
  it('reads all five official states and keeps watched distinct from watching after reload', async () => {
    const storage = memory();
    const store = new Store(storage);
    const api = new Api(0);
    api.token = 'test-token';
    vi.spyOn(api, 'collections').mockResolvedValue({
      total: 5,
      data: [1, 2, 3, 4, 5].map((type) => ({
        subject_id: type,
        subject: subject(type),
        type,
        rate: 8,
        comment: '',
        private: false,
        tags: [],
      })),
    });
    const request = vi.spyOn(api, 'request');
    await new Sync(store, api).pull({ id: 100, username: 'testuser', nickname: '测试' });
    const restored = new Store(storage);
    expect([1, 2, 3, 4, 5].map((id) => restored.get(id)?.status)).toEqual([
      'wish',
      'collect',
      'doing',
      'on_hold',
      'dropped',
    ]);
    expect(restored.dirty()).toHaveLength(0);
    expect(request).not.toHaveBeenCalled();
  });
  it('applies cloud states only after the whole conflict batch is explicitly resolved', async () => {
    const store = new Store(memory());
    store.merge([validateItem({ ...subject(1), status: 'doing', dirty: false })]);
    store.mark([subject(2)], 'on_hold');
    const api = new Api(0);
    api.token = 'test-token';
    vi.spyOn(api, 'collections').mockResolvedValue({
      total: 2,
      data: [1, 2].map((id) => ({
        subject_id: id,
        subject: subject(id),
        type: 2,
        rate: 0,
        comment: '',
        private: false,
        tags: [],
      })),
    });
    const sync = new Sync(store, api);
    sync.onConflicts = vi.fn(async () => 'remote' as const);
    await sync.pull({ id: 100, username: 'testuser', nickname: '测试' });
    expect(sync.onConflicts).toHaveBeenCalledTimes(1);
    expect(store.get(1)?.status).toBe('collect');
    expect(store.get(2)?.status).toBe('collect');
    expect(store.get(2)?.dirty).toBe(false);
  });
});
