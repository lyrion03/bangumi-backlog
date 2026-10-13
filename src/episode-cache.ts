import type { Episode } from './domain';
export interface EpisodeCollection {
  episode: Episode;
  type: number;
  updated_at?: number;
}
const KEY = 'bbm-episode-snapshots-v1';
export const EPISODE_CACHE_TTL = 15 * 60000;
/** Complete cloud snapshots only: local pending edits are overlaid by each consumer. */
export class EpisodeCache {
  private entries = new Map<string, { at: number; rows: EpisodeCollection[] }>();
  private dirty = false;
  constructor(
    private storage: Storage,
    private account: number,
  ) {
    try {
      const entries = JSON.parse(storage.getItem(KEY) || '[]');
      if (Array.isArray(entries))
        for (const [key, value] of entries.slice(-2000)) {
          if (
            typeof key === 'string' &&
            Number.isFinite(value?.at) &&
            value.at <= Date.now() &&
            Date.now() - value.at < EPISODE_CACHE_TTL &&
            validEpisodes(value.rows)
          )
            this.entries.set(key, value);
        }
    } catch {}
  }
  private key(id: number) {
    return this.account + ':' + id;
  }
  get(id: number) {
    const entry = this.entries.get(this.key(id));
    return entry && Date.now() - entry.at < EPISODE_CACHE_TTL
      ? structuredClone(entry.rows)
      : undefined;
  }
  put(id: number, rows: EpisodeCollection[]) {
    this.entries.delete(this.key(id));
    this.entries.set(this.key(id), { at: Date.now(), rows: structuredClone(rows) });
    this.dirty = true;
  }
  invalidate(id?: number) {
    for (const key of this.entries.keys())
      if (id === undefined ? key.startsWith(this.account + ':') : key === this.key(id))
        this.entries.delete(key);
    this.dirty = true;
    this.flush();
  }
  flush() {
    if (!this.dirty) return;
    let entries = [...this.entries]
      .filter(([, v]) => Date.now() - v.at < EPISODE_CACHE_TTL)
      .slice(-2000);
    while (true) {
      const json = JSON.stringify(entries);
      if (json.length <= 2000000) {
        try {
          this.storage.setItem(KEY, json);
          break;
        } catch {}
      }
      if (!entries.length) break;
      entries = entries.slice(Math.max(1, Math.ceil(entries.length * 0.1)));
    }
    this.dirty = false;
  }
}
export function validEpisodes(rows: unknown): rows is EpisodeCollection[] {
  return (
    Array.isArray(rows) &&
    rows.every(
      (row) =>
        Number.isSafeInteger(row?.episode?.id) &&
        row.episode.id > 0 &&
        [0, 1, 2, 3].includes(row.type) &&
        (row.updated_at === undefined || (Number.isFinite(row.updated_at) && row.updated_at >= 0)),
    )
  );
}
