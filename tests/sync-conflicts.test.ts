import { expect, it, vi } from 'vitest';
import { Api, ApiError } from '../src/api';
import { Store } from '../src/store';
import { Sync } from '../src/sync';
import { normalize } from '../src/domain';
function setup() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => map.set(k, v),
  } as Storage;
  const store = new Store(storage);
  store.settings({ completeEpisodes: false });
  const subjects = [1, 2, 3].map((id) => normalize({ id, name: '作品' + id }));
  store.mark(subjects.slice(0, 2), 'on_hold');
  const api = new Api(0);
  api.token = 'fixture';
  const sync = new Sync(store, api);
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(async (method, path) => (method === 'GET' ? { type: 2 } : (null as any)));
  const user = { id: 1, username: 'fixture', nickname: '测试' };
  return { store, subjects, api, sync, request, user };
}
it('manual push reads the entire batch before prompting and writes only after keeping local', async () => {
  const { store, sync, request } = setup();
  sync.onConflicts = vi.fn(async (conflicts) => {
    expect(conflicts).toHaveLength(2);
    expect(request.mock.calls.every((c) => c[0] === 'GET')).toBe(true);
    return 'local';
  });
  await sync.push(undefined, true);
  expect(sync.onConflicts).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.map((c) => c[0])).toEqual(['GET', 'GET', 'POST', 'POST']);
  expect(store.dirty()).toHaveLength(0);
});
it('cloud choice updates local states without sending conflicting statuses or losing metadata edits', async () => {
  const { store, subjects, sync, request } = setup();
  store.mark([subjects[0]], 'on_hold', { comment: '保留草稿' });
  sync.onConflicts = async () => 'remote';
  await sync.push(undefined, true);
  expect(request.mock.calls.every((c) => c[0] === 'GET')).toBe(true);
  expect(store.get(1)).toMatchObject({
    status: 'collect',
    comment: '保留草稿',
    dirty: true,
    metadata: true,
  });
  expect(store.get(2)).toMatchObject({ status: 'collect', dirty: false });
});
it('cancelling manual conflicts sends nothing and leaves records pending', async () => {
  const { store, sync, request } = setup();
  sync.onConflicts = async () => 'cancel';
  await sync.push(undefined, true);
  expect(request.mock.calls.every((c) => c[0] === 'GET')).toBe(true);
  expect(store.dirty()).toHaveLength(2);
  expect(sync.progress.active).toBe(false);
});
it('new cloud collections skip confirmation while unknown read failures prevent writes', async () => {
  const { sync, request } = setup();
  sync.onConflicts = vi.fn(async () => 'cancel');
  request.mockImplementation(async (method) => {
    if (method === 'GET') throw new ApiError('missing', 404);
    return null as any;
  });
  await sync.push(undefined, true);
  expect(sync.onConflicts).not.toHaveBeenCalled();
  expect(request.mock.calls.filter((c) => c[0] === 'POST')).toHaveLength(2);
  const other = setup();
  other.request.mockRejectedValue(new ApiError('offline', 503));
  await expect(other.sync.push(undefined, true)).rejects.toThrow('offline');
  expect(other.request.mock.calls.every((c) => c[0] === 'GET')).toBe(true);
  expect(other.sync.progress.active).toBe(false);
});
it('pull gathers conflicts across pages and cancellation leaves the whole batch unchanged', async () => {
  const { store, subjects, api, sync, user } = setup();
  vi.spyOn(api, 'collections').mockImplementation(async (_u, offset) => ({
    total: 3,
    data: [
      {
        subject_id: offset + 1,
        subject: subjects[offset],
        type: 2,
        rate: 0,
        comment: '',
        private: false,
        tags: [],
      },
    ],
  }));
  sync.onConflicts = vi.fn(async (conflicts) => {
    expect(conflicts).toHaveLength(2);
    expect(store.get(3)).toBeUndefined();
    return 'cancel';
  });
  await sync.pull(user);
  expect(sync.onConflicts).toHaveBeenCalledTimes(1);
  expect(store.get(1)?.status).toBe('on_hold');
  expect(store.get(3)).toBeUndefined();
  expect(store.state.lastPull).toBeNull();
});
it('keeping local on pull makes clean conflicting statuses pending and preserves edits made during the dialog', async () => {
  const { store, subjects, api, sync, user } = setup();
  store.synced(1, store.get(1)!.revision);
  vi.spyOn(api, 'collections').mockResolvedValue({
    total: 2,
    data: subjects.slice(0, 2).map((subject) => ({
      subject_id: subject.id,
      subject,
      type: 2,
      rate: 0,
      comment: '',
      private: false,
      tags: [],
    })),
  });
  sync.onConflicts = async () => {
    store.mark([subjects[1]], 'dropped');
    return 'local';
  };
  await sync.pull(user);
  expect(store.get(1)).toMatchObject({ status: 'on_hold', dirty: true });
  expect(store.get(2)?.status).toBe('dropped');
});
it('manual push never overwrites a newer edit made while resolving the batch', async () => {
  const { store, subjects, sync, request } = setup();
  sync.onConflicts = async () => {
    store.mark([subjects[0]], 'dropped');
    return 'local';
  };
  await sync.push(undefined, true);
  expect(request.mock.calls.filter((c) => c[0] === 'POST').map((c) => c[1])).toEqual([
    '/v0/users/-/collections/2',
  ]);
  expect(store.get(1)).toMatchObject({ status: 'dropped', dirty: true });
});
