import { afterEach, expect, it, vi } from 'vitest';
import { Api } from '../src/api';
import { Store } from '../src/store';
import { Sync } from '../src/sync';
import { normalize } from '../src/domain';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('overlaps slow responses with at most three requests and spaces every start', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const starts: number[] = [];
  let active = 0,
    peak = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      starts.push(Date.now());
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 1000));
      active--;
      return new Response('{}');
    }),
  );
  const api = new Api(350);
  const result = Promise.all(
    Array.from({ length: 6 }, (_, i) => api.request('GET', '/v0/subjects/' + i)),
  );
  await vi.runAllTimersAsync();
  await result;
  expect(peak).toBe(3);
  expect(starts).toHaveLength(6);
  for (let i = 1; i < starts.length; i++)
    expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(350);
  expect(Date.now() - 100000).toBeLessThan(3500);
});
it('429 cools all queued starts and honors Retry-After beyond fifteen seconds', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const starts: number[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      starts.push(Date.now());
      return starts.length === 1
        ? new Response('{}', { status: 429, headers: { 'Retry-After': '20' } })
        : new Response('{}');
    }),
  );
  const api = new Api(350);
  const result = Promise.all([1, 2, 3, 4].map((id) => api.request('GET', '/v0/subjects/' + id)));
  await vi.advanceTimersByTimeAsync(19999);
  expect(starts).toHaveLength(1);
  await vi.runAllTimersAsync();
  await result;
  expect(starts).toHaveLength(5);
  expect(starts.slice(1).every((t) => t >= 120000)).toBe(true);
});
function setup(count: number) {
  const storage = { getItem: () => null, setItem: () => {} } as unknown as Storage;
  const store = new Store(storage);
  const api = new Api(0);
  api.token = 'fixture';
  const subjects = Array.from({ length: count }, (_, i) =>
    normalize({ id: i + 1, name: '动画' + i }),
  );
  const sync = new Sync(store, api);
  return { store, api, subjects, sync };
}
it('cancel waits for three active subjects and does not start the remaining subjects', async () => {
  const { store, api, subjects, sync } = setup(6);
  store.settings({ completeEpisodes: false });
  store.mark(subjects, 'collect');
  const finish: Array<() => void> = [];
  const request = vi
    .spyOn(api, 'request')
    .mockImplementation(() => new Promise((resolve) => finish.push(() => resolve(null as any))));
  const running = sync.push();
  expect(request).toHaveBeenCalledTimes(3);
  sync.cancel();
  expect(sync.progress.active).toBe(true);
  finish.forEach((done) => done());
  await running;
  expect(request).toHaveBeenCalledTimes(3);
  expect(sync.progress.active).toBe(false);
  expect(store.dirty()).toHaveLength(3);
});
it('parallel subjects preserve collection-before-episode ordering and deduplicate ids', async () => {
  vi.useFakeTimers();
  const { store, api, subjects, sync } = setup(4);
  store.mark(subjects, 'collect');
  const trace: string[] = [];
  vi.spyOn(api, 'request').mockImplementation(async (method, path) => {
    const id = path.split('/')[5];
    trace.push(method + ':start:' + id);
    await new Promise((r) => setTimeout(r, 100));
    trace.push(method + ':end:' + id);
    return null as any;
  });
  vi.spyOn(api, 'episodes').mockImplementation(async (id) => {
    trace.push('episodes:' + id);
    return [{ id: id * 10, type: 0, airdate: '2020-01-01' }] as any;
  });
  const running = sync.push([1, 1, 2, 3, 4]);
  await vi.runAllTimersAsync();
  await running;
  for (const id of [1, 2, 3, 4]) {
    expect(trace.indexOf('POST:end:' + id)).toBeLessThan(trace.indexOf('episodes:' + id));
    expect(trace.indexOf('episodes:' + id)).toBeLessThan(trace.indexOf('PATCH:start:' + id));
  }
  expect(trace.filter((t) => t === 'POST:start:1')).toHaveLength(1);
  expect(trace.indexOf('POST:start:2')).toBeLessThan(trace.indexOf('POST:end:1'));
  expect(store.dirty()).toHaveLength(0);
});

it('clicked series requests overtake waiting background requests without exceeding the active limit', async () => {
  vi.useFakeTimers();
  const starts: string[] = [];
  const finish: Array<() => void> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          starts.push(url.split('/').pop()!);
          finish.push(() => resolve(new Response('{}')));
        }),
    ),
  );
  const api = new Api(0);
  const tasks = [1, 2, 3].map((id) => api.request('GET', '/v0/subjects/' + id));
  await vi.advanceTimersByTimeAsync(0);
  tasks.push(api.request('GET', '/v0/subjects/4', undefined, '', 0));
  tasks.push(api.request('GET', '/v0/subjects/5', undefined, '', 2));
  await vi.advanceTimersByTimeAsync(0);
  expect(starts).toEqual(['1', '2', '3']);
  finish[0]();
  await vi.advanceTimersByTimeAsync(0);
  expect(starts).toEqual(['1', '2', '3', '5']);
  finish[1]();
  await vi.advanceTimersByTimeAsync(0);
  expect(starts).toEqual(['1', '2', '3', '5', '4']);
  finish.slice(2).forEach((done) => done());
  await vi.advanceTimersByTimeAsync(0);
  await Promise.all(tasks);
});
