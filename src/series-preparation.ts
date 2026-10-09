import { Api } from './api';
import { type Subject } from './domain';
import { collectSeries, scanSeriesPage } from './series';
import { SeriesCache } from './series-cache';
export interface PreparationControls {
  priority?: number;
  probeOnly?: boolean;
  cancelled: () => boolean;
  waitUntilReady: () => Promise<void>;
  onHint: (id: number, found: boolean) => void;
  onProgress: (phase: 'probe' | 'series', done: number, total: number, failed: number) => void;
}
/** Stage barrier: all visible entry probes finish before any full series traversal starts. */
export async function prepareSeriesPage(
  api: Api,
  cache: SeriesCache,
  scope: string,
  subjects: Subject[],
  controls: PreparationControls,
) {
  const { cancelled, waitUntilReady, onHint, onProgress } = controls;
  const related = new Set<number>();
  let failures = 0;
  await scanSeriesPage(
    api,
    subjects,
    cancelled,
    waitUntilReady,
    (id, found) => {
      if (found) related.add(id);
      onHint(id, cache.confirmedHint(scope, id) === true);
    },
    (done, failed) => {
      failures = failed;
      onProgress('probe', done, subjects.length, failed);
    },
    {
      getHint: (id) => cache.hint(scope, id),
      setHint: (id, hint) => cache.putHint(scope, id, hint),
    },
    controls.priority ?? 1,
  );
  if (cancelled()) return;
  const roots = subjects.filter((s) => related.has(s.id));
  if (controls.probeOnly) return { count: roots.length, failed: failures };
  let done = 0;
  for (const root of roots) {
    await waitUntilReady();
    if (cancelled()) return;
    if (!cache.series(scope, root.id)) {
      try {
        const result = await collectSeries(
          api,
          root,
          cancelled,
          () => {},
          waitUntilReady,
          controls.priority ?? 1,
        );
        if (cancelled()) return;
        if (!cache.series(scope, root.id)) cache.putSeries(scope, root.id, result);
        if (!result.truncated && result.entries.length > 1)
          for (const entry of result.entries) onHint(entry.id, true);
      } catch {
        if (cancelled()) return;
        failures++;
      }
    }
    const prepared = cache.series(scope, root.id);
    if (prepared) onHint(root.id, prepared.entries.length > 1);
    onProgress('series', ++done, roots.length, failures);
  }
  if (!roots.length) onProgress('series', 0, 0, failures);
  return { count: roots.length, failed: failures };
}
