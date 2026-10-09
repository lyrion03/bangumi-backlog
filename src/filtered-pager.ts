import type { Page, Subject } from './domain';
type Candidates = {
  items: Subject[];
  ids: Set<number>;
  next: number;
  done: boolean;
  pending?: Promise<void>;
};
export class FilteredPager {
  private caches = new Map<string, Candidates>();
  async page(
    key: string,
    page: number,
    size: number,
    fetchPage: (page: number) => Promise<Page<Subject>>,
    accepts: (subject: Subject) => boolean,
    cancelled = () => false,
    lookAhead = true,
    maxFetches = Infinity,
  ) {
    let cache = this.caches.get(key);
    if (!cache) {
      cache = { items: [], ids: new Set(), next: 1, done: false };
      this.caches.set(key, cache);
      if (this.caches.size > 3) this.caches.delete(this.caches.keys().next().value!);
    }
    const state = cache;
    let matches = state.items.filter(accepts);
    let fetched = 0;
    // One extra match establishes whether a real next page exists. Never infer it from raw totals.
    while (!state.done && matches.length < page * size + (lookAhead ? 1 : 0)) {
      if (cancelled()) throw new Error('筛选已更新');
      if (fetched >= maxFetches) break;
      fetched++;
      if (!state.pending) {
        state.pending = (async () => {
          const result = await fetchPage(state.next);
          for (const subject of result.data) {
            if (!state.ids.has(subject.id)) {
              state.ids.add(subject.id);
              state.items.push(subject);
            }
          }
          state.done =
            result.hasMore === undefined ? state.next * 20 >= result.total : !result.hasMore;
          state.next++;
        })().finally(() => {
          state.pending = undefined;
        });
      }
      try {
        await state.pending;
      } catch (error) {
        // An obsolete background consumer may have paused before the shared fetch started.
        if (!(error instanceof DOMException && error.name === 'AbortError') || cancelled())
          throw error;
        continue;
      }
      if (cancelled()) throw new Error('筛选已更新');
      matches = state.items.filter(accepts);
    }
    const actualPage = state.done
      ? Math.min(page, Math.max(1, Math.ceil(matches.length / size)))
      : page;
    return {
      page: actualPage,
      total: matches.length,
      exact: state.done,
      filled: state.done || matches.length >= page * size,
      data: matches.slice((actualPage - 1) * size, actualPage * size),
    };
  }
}
