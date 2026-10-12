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

it('aborting a running radar request immediately releases its slot to normal work', async () => {
  const api = new Api(0);
  const controller = new AbortController();
  const starts: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      starts.push(url);
      if (url.endsWith('/1'))
        return new Promise((_resolve, reject) =>
          init.signal!.addEventListener(
            'abort',
            () => reject(new DOMException('abort', 'AbortError')),
            { once: true },
          ),
        );
      return Promise.resolve(new Response('{}'));
    }),
  );
  const radar = api.request('GET', '/v0/subjects/1', undefined, '', -1, controller.signal);
  const rejected = expect(radar).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(starts).toHaveLength(1));
  controller.abort();
  await rejected;
  await expect(api.request('POST', '/v0/users/-/collections/2', { type: 2 })).resolves.toEqual({});
  expect(starts).toHaveLength(2);
});
it('canceled queued radar work never reaches the network and does not delay a priority write', async () => {
  const api = new Api(0),
    controller = new AbortController();
  const finish: Array<() => void> = [];
  const starts: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          starts.push(url);
          finish.push(() => resolve(new Response('{}')));
        }),
    ),
  );
  const active = [1, 2, 3].map((id) => api.request('GET', '/v0/subjects/' + id));
  await vi.waitFor(() => expect(starts).toHaveLength(3));
  const canceled = api.request('GET', '/v0/subjects/4', undefined, '', -1, controller.signal);
  const rejected = expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
  const normal = api.request('POST', '/v0/users/-/collections/5', { type: 2 });
  controller.abort();
  finish[0]();
  await vi.waitFor(() => expect(starts).toHaveLength(4));
  expect(starts[3]).toContain('/collections/5');
  finish.slice(1).forEach((fn) => fn());
  await Promise.all([...active, normal, rejected]);
  expect(starts.some((u) => u.endsWith('/4'))).toBe(false);
});

it('switching page aborts old shared reads and new consumers never inherit an aborted promise', async () => {
  const api = new Api(0),
    old = new AbortController(),
    current = new AbortController();
  let aborted = 0;
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push(url);
      if (calls.length <= 3)
        return new Promise<Response>((_, reject) =>
          init.signal!.addEventListener(
            'abort',
            () => {
              aborted++;
              reject(new DOMException('abort', 'AbortError'));
            },
            { once: true },
          ),
        );
      return Promise.resolve(
        new Response(
          JSON.stringify(
            url.includes('/episodes?')
              ? { data: [], total: 0 }
              : url.endsWith('/subjects')
                ? []
                : { id: 1 },
          ),
        ),
      );
    }),
  );
  const rejected = Promise.allSettled([
    api.subject(1, 0, old.signal),
    api.related(1, 0, old.signal),
    api.episodes(1, 0, old.signal),
  ]);
  await vi.waitFor(() => expect(calls).toHaveLength(3));
  old.abort();
  await Promise.all([
    api.subject(1, 1, current.signal),
    api.related(1, 1, current.signal),
    api.episodes(1, 1, current.signal),
  ]);
  expect(aborted).toBe(3);
  expect((await rejected).every((r) => r.status === 'rejected')).toBe(true);
  current.abort();
  const count = calls.length;
  await Promise.all([api.subject(1), api.related(1), api.episodes(1)]);
  expect(calls).toHaveLength(count);
});
it('canceling rate-gap wait releases the slot without issuing an obsolete request', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  const api = new Api(350),
    old = new AbortController();
  const fetcher = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  await api.subject(1);
  const stopped = api.subject(2, 0, old.signal);
  const rejected = expect(stopped).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(10);
  old.abort();
  await rejected;
  const current = api.subject(3);
  await vi.advanceTimersByTimeAsync(340);
  await current;
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][0]).toContain('/3');
});
