import { Api } from './api';
import { type Subject } from './domain';
const RELATIONS = new Set(['续集', '前传', '前集', '后续']);
export function durationMinutes(raw: string | undefined): number {
  const value = (raw || '').trim();
  if (/^\d+:\d{2}:\d{2}$/.test(value)) {
    const [h, m, s] = value.split(':').map(Number);
    return m < 60 && s < 60 ? h * 60 + m + s / 60 : 0;
  }
  if (/^\d+:\d{2}$/.test(value)) {
    const [m, s] = value.split(':').map(Number);
    return s < 60 ? m + s / 60 : 0;
  }
  const minutes = value.match(/^(\d+(?:\.\d+)?)\s*(?:分钟|分|m|min(?:utes?)?)$/i);
  return minutes ? Number(minutes[1]) : 0;
}
export function hasMainlineLength(episodes: import('./domain').Episode[]): boolean {
  const lengths = episodes
    .filter((ep) => ep.type === 0)
    .map((ep) => durationMinutes(ep.duration))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  if (!lengths.length) return false;
  const middle = Math.floor(lengths.length / 2);
  const median = lengths.length % 2 ? lengths[middle] : (lengths[middle - 1] + lengths[middle]) / 2;
  return median >= 5;
}
const MAINLINE_PLATFORMS = new Set(['TV', 'OVA', '剧场版']);
export const isSeriesRelation = (
  relation: { id: number; type: number; relation: string },
  rootId: number,
) => relation.id !== rootId && relation.type === 2 && RELATIONS.has(relation.relation);

/** Probe direct animation relationships one subject at a time, in display order. */
export async function scanSeriesPage(
  api: Api,
  subjects: Subject[],
  cancelled: () => boolean,
  waitUntilReady: () => Promise<void>,
  onResult: (id: number, hasSeries: boolean) => void,
  onProgress: (done: number, failed: number) => void,
  cache?: {
    getHint: (id: number) => boolean | undefined;
    setHint: (id: number, hint: boolean) => void;
  },
  priority = 1,
) {
  let done = 0;
  let failed = 0;
  for (const subject of subjects) {
    await waitUntilReady();
    if (cancelled()) return;
    try {
      let found = cache?.getHint(subject.id);
      if (found === undefined) {
        const relations = await api.related(subject.id, priority);
        if (cancelled()) return;
        found = relations.some((r) => isSeriesRelation(r, subject.id));
        cache?.setHint(subject.id, found);
      }
      onResult(subject.id, found);
    } catch {
      if (cancelled()) return;
      failed++;
    }
    onProgress(++done, failed);
  }
}

export async function collectSeries(
  api: Api,
  root: Subject,
  cancelled: () => boolean,
  onProgress: (count: number) => void,
  waitUntilReady: () => Promise<void> = async () => {},
  priority = 1,
) {
  const seen = new Set([root.id]);
  const queue = [root.id];
  const entries: Subject[] = [];
  const cap = 24;
  let truncated = false;
  while (queue.length && !cancelled()) {
    const id = queue.shift()!;
    await waitUntilReady();
    if (cancelled()) break;
    const subject = await api.subject(id, priority);
    // Excluded branches must not bridge the traversal into unrelated side stories.
    if (!MAINLINE_PLATFORMS.has(subject.platform)) continue;
    await waitUntilReady();
    if (cancelled()) break;
    if (subject.platform !== '剧场版' && !hasMainlineLength(await api.episodes(id, priority)))
      continue;
    if (cancelled()) break;
    entries.push(subject);
    onProgress(entries.length);
    if (cancelled()) break;
    await waitUntilReady();
    if (cancelled()) break;
    const relations = await api.related(id, priority);
    for (const r of relations) {
      if (!isSeriesRelation(r, id) || seen.has(r.id)) continue;
      if (seen.size >= cap) {
        truncated = true;
        continue;
      }
      seen.add(r.id);
      queue.push(r.id);
    }
  }
  if (cancelled()) throw new DOMException('系列计算已取消', 'AbortError');
  return {
    entries: entries.sort(
      (a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.id - b.id,
    ),
    truncated,
  };
}
