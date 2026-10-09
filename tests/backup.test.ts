import { expect, it, vi } from 'vitest';
import { Store } from '../src/store';
import { Api, ApiError } from '../src/api';
import { Sync, collectionPayload } from '../src/sync';
import { createBackup } from '../src/backup';
import { normalize, STATUS } from '../src/domain';
function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (k: string) => values.get(k) || null,
    setItem: (k: string, v: string) => values.set(k, v),
  } as Storage;
}
function setup() {
  const storage = memory(),
    store = new Store(storage),
    api = new Api(0);
  return { storage, store, api };
}
const subject = (id = 1) =>
  normalize({
    id,
    name: '测试',
    tags: [{ name: '科幻', count: 100 }],
    summary: '不应导出',
    images: { large: 'https://example.com/image.jpg' },
  });
it('exports only marks and timestamps with the formal name and persisted account identity', () => {
  const { store, storage } = setup();
  store.bind({ id: 42, username: 'test-user', nickname: '昵称' });
  Object.keys(STATUS).forEach((status, i) =>
    store.mark([subject(i + 1)], status as keyof typeof STATUS),
  );
  const result = new Store(storage).export();
  expect(result).toMatchObject({
    type: 'bangumi-backlog',
    version: 2,
    account: { id: 42, username: '昵称' },
  });
  expect(result.items.map((i) => i.status)).toEqual(Object.keys(STATUS));
  expect(Object.keys(result.items[0]).sort()).toEqual(
    ['id', 'status', 'markedAt', 'updatedAt', 'episodesComplete', 'episodes'].sort(),
  );
  expect(JSON.stringify(result)).not.toMatch(/tag|summary|image|comment|rate|token/);
  expect(result.items.every((i) => !!i.markedAt)).toBe(true);
});
it('preserves episode edits and times after successful sync and reload', () => {
  const { store, storage } = setup();
  store.mark([subject()], 'doing', { episodeChanges: { 11: 2, 12: 0 } });
  const before = store.get(1)!;
  store.synced(1, before.revision);
  const restored = new Store(storage);
  expect(restored.get(1)!.episodeChanges).toEqual({});
  expect(restored.get(1)!.episodeMarks).toEqual(before.episodeMarks);
  expect(restored.export().items[0].episodes.map((ep) => ep.type)).toEqual([2, 0]);
});
it('round trips mixed episode types and does not fill or overwrite collection metadata on restore', async () => {
  const { store, api } = setup();
  api.token = 'fixture';
  const items = store.parseImport({
    type: 'bangumi-backlog',
    version: 2,
    items: [
      {
        id: 1,
        status: 'collect',
        markedAt: '2020-01-01T00:00:00Z',
        updatedAt: null,
        episodesComplete: true,
        episodes: [0, 1, 2, 3].map((type, i) => ({ id: 100 + i, type, markedAt: null })),
      },
    ],
  });
  store.import(items);
  expect(collectionPayload(store.get(1)!)).toEqual({ type: 2 });
  expect(store.export().items[0].markedAt).toBe('2020-01-01T00:00:00.000Z');
  const episodes = vi.spyOn(api, 'episodes');
  const request = vi.spyOn(api, 'request').mockResolvedValue(null);
  await new Sync(store, api).push();
  expect(episodes).not.toHaveBeenCalled();
  expect(request.mock.calls.filter((c) => c[0] === 'PATCH').map((c) => (c[2] as any).type)).toEqual(
    [0, 1, 2, 3],
  );
  expect(store.export().items[0].episodes.map((ep) => ep.type)).toEqual([0, 1, 2, 3]);
});
it('reads cloud mixed episodes and timestamps but overlays local unsynced changes', async () => {
  const { store, api, storage } = setup();
  store.bind({ id: 42, username: 'test-user', nickname: '' });
  api.token = 'fixture';
  store.mark([subject()], 'doing', { episodeChanges: { 12: 0 } });
  vi.spyOn(api, 'episodeCollections').mockResolvedValue([
    { episode: { id: 11 } as any, type: 2, updated_at: 1700000000 },
    { episode: { id: 12 } as any, type: 2, updated_at: 1700000000 },
    { episode: { id: 13 } as any, type: 3, updated_at: 0 },
  ]);
  const result = await createBackup(store, api);
  expect(result.items[0].episodesComplete).toBe(true);
  expect(result.items[0].episodes).toEqual([
    { id: 11, type: 2, markedAt: '2023-11-14T22:13:20.000Z' },
    { id: 12, type: 0, markedAt: expect.any(String) },
    { id: 13, type: 3, markedAt: null },
  ]);
  expect(new Store(storage).export().items[0].episodes).toEqual(result.items[0].episodes);
});
it('rejects failed reads instead of downloading a partial backup, while allowing local-only 404 records', async () => {
  const { store, api } = setup();
  store.mark([subject()], 'doing');
  api.token = 'fixture';
  const reader = vi.spyOn(api, 'episodeCollections').mockRejectedValue(new ApiError('offline'));
  await expect(createBackup(store, api)).rejects.toThrow('offline');
  expect(store.get(1)!.episodesComplete).toBe(false);
  reader.mockRejectedValue(new ApiError('not collected', 404));
  expect((await createBackup(store, api)).items[0].episodesComplete).toBe(false);
});
it('imports historical names and unknown episode timestamps without inventing times', () => {
  const { store } = setup();
  store.import(
    store.parseImport({
      type: 'bangumi-batch-marker',
      items: [{ id: 1, status: 'doing', episodeChanges: { 10: 0, 11: 2 } }],
    }),
  );
  expect(store.export().items[0].markedAt).toBeNull();
  expect(store.export().items[0].episodes).toEqual([
    { id: 10, type: 0, markedAt: null },
    { id: 11, type: 2, markedAt: null },
  ]);
  expect(() =>
    store.parseImport({
      type: 'bangumi-backlog',
      version: 2,
      items: [{ id: 2, status: 'collect', episodes: [{ id: '__proto__', type: 2 }] }],
    }),
  ).toThrow('无效');
});
it('does not overwrite edits made while the backup snapshot is being read', async () => {
  const { store, api } = setup();
  store.mark([subject()], 'doing');
  api.token = 'fixture';
  vi.spyOn(api, 'episodeCollections').mockImplementation(async () => {
    store.mark([subject()], 'doing', { episodeChanges: { 11: 0 } });
    return [{ episode: { id: 11 } as any, type: 2, updated_at: 0 }];
  });
  await createBackup(store, api);
  expect(store.get(1)!.episodeMarks[11].type).toBe(0);
  expect(store.get(1)!.episodesComplete).toBe(false);
});

it('exports a nickname instead of a numeric account username and retains it offline', () => {
  const { store, storage } = setup();
  store.bind({ id: 42, username: '42', nickname: '动画爱好者' });
  expect(new Store(storage).export().account).toEqual({ id: 42, username: '动画爱好者' });
  store.bind({ id: 42, username: '42', nickname: '新昵称' });
  expect(store.export().account.username).toBe('新昵称');
});
it('does not mislabel a historical login id as an unknown nickname', () => {
  const { storage } = setup();
  storage.setItem(
    'bangumi-batch-marker-v1',
    JSON.stringify({ version: 1, items: {}, owner: 42, account: { id: 42, username: '42' } }),
  );
  const restored = new Store(storage);
  expect(restored.export().account).toEqual({ id: 42, username: null });
  restored.bind({ id: 42, username: '42', nickname: '恢复的昵称' });
  expect(restored.export().account.username).toBe('恢复的昵称');
});
