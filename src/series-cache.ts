import { normalize, type Subject } from './domain';
export const SERIES_CACHE_KEY = 'bbm-series-cache-v5';
const TTL = 7 * 24 * 60 * 60 * 1000;
const HINT_TTL = 24 * 60 * 60 * 1000;
const MAX_RECORDS = 600;
export interface SeriesResult {
  entries: Subject[];
  truncated: boolean;
}
interface Entry {
  scope: string;
  id: number;
  at: number;
  hint: boolean;
  result?: SeriesResult;
}
/** Optional, bounded cache; never contains tokens, user marks or sync state. */
export class SeriesCache {
  private records = new Map<string, Entry>();
  constructor(
    private storage: Storage,
    private now = () => Date.now(),
  ) {
    try {
      const saved = JSON.parse(storage.getItem(SERIES_CACHE_KEY) || 'null');
      if (saved?.version !== 1 || !Array.isArray(saved.records)) return;
      for (const raw of saved.records.slice(-MAX_RECORDS)) {
        if (
          !Number.isSafeInteger(raw.id) ||
          raw.id <= 0 ||
          typeof raw.scope !== 'string' ||
          typeof raw.hint !== 'boolean' ||
          !Number.isFinite(raw.at) ||
          raw.at > now() ||
          now() - raw.at >= (raw.hint ? TTL : HINT_TTL)
        )
          continue;
        const record: Entry = { scope: raw.scope, id: raw.id, at: raw.at, hint: raw.hint };
        if (raw.result && Array.isArray(raw.result.entries) && raw.result.entries.length <= 24) {
          const entries = raw.result.entries.map(normalize);
          if (entries.every((s: Subject) => Number.isSafeInteger(s.id) && s.id > 0)) {
            record.result = { entries, truncated: !!raw.result.truncated };
          }
        }
        this.records.set(this.key(raw.scope, raw.id), record);
      }
    } catch {
      /* Corrupt or unavailable optional cache does not block the application. */
    }
  }
  private key(scope: string, id: number) {
    return `${scope}:${id}`;
  }
  private get(scope: string, id: number) {
    const key = this.key(scope, id);
    const record = this.records.get(key);
    if (record && this.now() - record.at < (record.hint ? TTL : HINT_TTL)) {
      this.records.delete(key);
      this.records.set(key, record);
      return record;
    }
    this.records.delete(key);
    return undefined;
  }
  hint(scope: string, id: number) {
    return this.get(scope, id)?.hint;
  }
  /** A relationship probe is only a candidate; badges require the filtered series result. */
  confirmedHint(scope: string, id: number) {
    const record = this.get(scope, id);
    if (record?.result) return record.result.entries.length > 1;
    return record?.hint === false ? false : undefined;
  }
  series(scope: string, id: number) {
    return this.get(scope, id)?.result;
  }
  putHint(scope: string, id: number, hint: boolean) {
    const prev = this.get(scope, id);
    this.put({
      scope,
      id,
      hint: prev?.result ? prev.result.entries.length > 1 : hint,
      at: this.now(),
      ...(prev?.result ? { result: prev.result } : {}),
    });
  }
  putSeries(scope: string, id: number, result: SeriesResult) {
    // Cache only display metadata; strip large summaries and irrelevant tag vote arrays.
    const entries = result.entries.map((s) => ({ ...s, summary: '', tags: [], tagVotes: [] }));
    // Only a completed traversal can be shared with every member; capped graphs remain root-specific.
    const roots =
      !result.truncated && entries.some((s) => s.id === id)
        ? new Set([id, ...entries.map((s) => s.id)])
        : new Set([id]);
    for (const member of roots)
      this.put(
        {
          scope,
          id: member,
          hint: entries.length > 1,
          at: this.now(),
          result: { entries, truncated: result.truncated },
        },
        false,
      );
    this.save();
  }
  private put(record: Entry, persist = true) {
    const key = this.key(record.scope, record.id);
    this.records.delete(key);
    this.records.set(key, record);
    while (this.records.size > MAX_RECORDS) this.records.delete(this.records.keys().next().value!);
    if (persist) this.save();
  }
  private save() {
    // Keep optional metadata bounded and evict old cache entries on storage pressure.
    const records = [...this.records.values()];
    while (records.length) {
      const raw = JSON.stringify({ version: 1, records });
      if (raw.length > 1500000) {
        records.shift();
        continue;
      }
      try {
        this.storage.setItem(SERIES_CACHE_KEY, raw);
        return;
      } catch {
        records.shift();
      }
    }
    // If local storage is unavailable, retain the bounded in-memory cache for this session.
  }
}
