import { expect, it, vi } from 'vitest';
import { FilteredPager } from '../src/filtered-pager';
import { normalize } from '../src/domain';
const subjects = Array.from({ length: 95 }, (_, i) =>
  normalize({ id: i + 1, rating: { rank: i + 1 } }),
);
const source = () =>
  vi.fn(async (page: number) => ({
    total: subjects.length,
    data: subjects.slice((page - 1) * 20, page * 20),
  }));
it('fills visible pages across fully excluded source pages, preserving order and last-page size', async () => {
  const pager = new FilteredPager(),
    fetch = source();
  const accepts = (s: any) => s.id > 40 && s.id % 2 === 1;
  const first = await pager.page('query', 1, 10, fetch, accepts);
  expect(first.data.map((s) => s.id)).toEqual([41, 43, 45, 47, 49, 51, 53, 55, 57, 59]);
  expect(first.exact).toBe(false);
  const second = await pager.page('query', 2, 10, fetch, accepts);
  expect(second.data.map((s) => s.id)).toEqual([61, 63, 65, 67, 69, 71, 73, 75, 77, 79]);
  const last = await pager.page('query', 3, 10, fetch, accepts);
  expect(last.data.map((s) => s.id)).toEqual([81, 83, 85, 87, 89, 91, 93, 95]);
  expect(last.total).toBe(28);
  expect(last.exact).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(5);
});
it('repaginates cached candidates after local status changes and size changes', async () => {
  const pager = new FilteredPager(),
    fetch = source();
  const hidden = new Set<number>();
  const accepts = (s: any) => !hidden.has(s.id);
  await pager.page('query', 1, 20, fetch, accepts);
  for (let i = 1; i <= 40; i++) hidden.add(i);
  const first = await pager.page('query', 1, 20, fetch, accepts);
  expect(first.data.map((s) => s.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 41));
  const small = await pager.page('query', 1, 10, fetch, accepts);
  expect(small.data.map((s) => s.id)).toEqual(Array.from({ length: 10 }, (_, i) => i + 41));
  hidden.clear();
  expect((await pager.page('query', 1, 10, fetch, accepts)).data[0].id).toBe(1);
});
it('only reports an empty result once all candidates have been checked and clamps a vanished last page', async () => {
  const pager = new FilteredPager(),
    fetch = source();
  const empty = await pager.page('query', 2, 20, fetch, () => false);
  expect(empty).toMatchObject({ page: 1, total: 0, exact: true, data: [] });
  expect(fetch).toHaveBeenCalledTimes(5);
});
it('shares concurrent source requests and keeps query caches isolated', async () => {
  const pager = new FilteredPager(),
    fetch = source();
  await Promise.all([
    pager.page('query', 1, 20, fetch, () => true),
    pager.page('query', 2, 20, fetch, () => true),
  ]);
  expect(fetch.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  await pager.page('other', 1, 10, fetch, () => true);
  expect(fetch.mock.calls.at(-1)).toEqual([1]);
});

it('demand paging fills exactly one visible page before looking for any further match', async () => {
  const fetch = vi.fn(async (page: number) => ({
    total: 32828,
    hasMore: true,
    data: subjects.slice((page - 1) * 10, page * 10),
  }));
  const pager = new FilteredPager();
  const first = await pager.page(
    'q',
    1,
    10,
    fetch,
    () => true,
    () => false,
    false,
  );
  expect(first).toMatchObject({ data: subjects.slice(0, 10), total: 10, exact: false });
  expect(fetch).toHaveBeenCalledTimes(1);
  const hidden = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const filtered = await pager.page(
    'q',
    1,
    10,
    fetch,
    (s) => !hidden.has(s.id),
    () => false,
    false,
  );
  expect(filtered.data[0].id).toBe(11);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('stops reading old query chunks after cancellation and resumes without refetching completed chunks', async () => {
  const pager = new FilteredPager();
  let cancelled = false;
  const fetch = vi.fn(async () => {
    cancelled = true;
    return { total: 100, hasMore: true, data: subjects.slice(0, 20) };
  });
  await expect(
    pager.page(
      'q',
      1,
      20,
      fetch,
      () => true,
      () => cancelled,
      false,
    ),
  ).rejects.toThrow('筛选已更新');
  const resumed = await pager.page(
    'q',
    1,
    20,
    fetch,
    () => true,
    () => false,
    false,
  );
  expect(resumed.data).toHaveLength(20);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('limits background chunks without declaring the result complete, then resumes on demand', async () => {
  const pager = new FilteredPager();
  const fetch = source();
  const accepts = (s: any) => s.id > 80;
  const background = await pager.page('budget', 1, 10, fetch, accepts, () => false, false, 2);
  expect(background).toMatchObject({ filled: false, exact: false, total: 0 });
  expect(fetch.mock.calls.map((c) => c[0])).toEqual([1, 2]);
  const visible = await pager.page('budget', 1, 10, fetch, accepts, () => false, false);
  expect(visible).toMatchObject({ filled: true, exact: true, total: 15 });
  expect(visible.data.map((s) => s.id)).toEqual([81, 82, 83, 84, 85, 86, 87, 88, 89, 90]);
  expect(fetch.mock.calls.map((c) => c[0])).toEqual([1, 2, 3, 4, 5]);
});
it('counts extra cached IDs and reaches the real end without additional network requests', async () => {
  const pager = new FilteredPager();
  const fetch = vi.fn(async () => ({ data: subjects, total: 95, hasMore: false }));
  await pager.page(
    'cached',
    1,
    10,
    fetch,
    () => true,
    () => false,
    false,
  );
  const far = await pager.page(
    'cached',
    10,
    10,
    fetch,
    () => true,
    () => false,
    false,
    0,
  );
  expect(far).toMatchObject({ total: 95, exact: true, filled: true });
  expect(far.data.map((s) => s.id)).toEqual([91, 92, 93, 94, 95]);
  expect(fetch).toHaveBeenCalledTimes(1);
});
