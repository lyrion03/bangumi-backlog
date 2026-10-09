import { Api, ApiError } from './api';
import { Store } from './store';
import { markTime, type EpisodeMark } from './domain';

/** Read-only cloud snapshot; never writes collection status to Bangumi. */
export async function createBackup(
  store: Store,
  api: Api,
  progress: (done: number, total: number) => void = () => {},
) {
  const backup = store.export();
  const token = api.token;
  if (!token) return backup;
  const local = new Map(store.all().map((item) => [item.id, structuredClone(item)]));
  const items = backup.items.filter((item) => item.status !== 'not_interested');
  const snapshots: Array<{ id: number; revision: number; marks: Record<string, EpisodeMark> }> = [];
  let next = 0,
    done = 0;
  let failure: unknown;
  progress(0, items.length);
  await Promise.all(
    Array.from({ length: Math.min(3, items.length) }, async () => {
      while (next < items.length && !failure) {
        const item = items[next++];
        try {
          if (api.token !== token || store.state.owner !== backup.account.id)
            throw new Error('账号已切换，请重新导出');
          const original = local.get(item.id)!;
          const remote = await api.episodeCollections(item.id, 2);
          const marks: Record<string, EpisodeMark> = {};
          for (const row of remote) {
            if (
              !Number.isSafeInteger(row.episode?.id) ||
              row.episode.id <= 0 ||
              ![0, 1, 2, 3].includes(row.type)
            )
              throw new Error('单集收藏格式无效，未生成不完整备份');
            const previous = original.episodeMarks[row.episode.id];
            marks[row.episode.id] = {
              type: row.type,
              markedAt:
                markTime((row.updated_at || 0) * 1000) ||
                (previous?.type === row.type ? previous.markedAt : null),
            };
          }
          for (const [id, type] of Object.entries(original.episodeChanges))
            marks[id] = { type, markedAt: original.episodeMarks[id]?.markedAt ?? null };
          item.episodes = Object.entries(marks).map(([id, ep]) => ({
            id: Number(id),
            type: ep.type,
            markedAt: ep.markedAt ? new Date(ep.markedAt).toISOString() : null,
          }));
          item.episodesComplete = true;
          snapshots.push({ id: item.id, revision: original.revision, marks });
        } catch (error) {
          // A local-only, not-yet-collected subject may have no cloud episode collection.
          if (!(error instanceof ApiError && error.status === 404)) failure = error;
        }
        progress(++done, items.length);
      }
    }),
  );
  if (failure) throw failure;
  if (api.token !== token || store.state.owner !== backup.account.id)
    throw new Error('账号已切换，请重新导出');
  if (snapshots.length) store.rememberEpisodes(snapshots);
  return backup;
}
