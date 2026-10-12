import { Api, ApiError } from './api';
import { type Item, type Episode } from './domain';
import {
  calculateRadar,
  metadata,
  mainline,
  type RadarNode,
  type RadarResult,
  type Relation,
} from './radar-score';
const CACHE = 'bbm-radar-data-v1';
const DAY = 86400000;
export class RadarCache {
  private records = new Map<string, { at: number; data: unknown }>();
  constructor(
    private storage: Storage,
    private now = () => Date.now(),
  ) {
    try {
      const list = JSON.parse(storage.getItem(CACHE) || '[]');
      if (Array.isArray(list))
        for (const [key, v] of list.slice(-1200))
          if (
            typeof key === 'string' &&
            v &&
            Number.isFinite(v.at) &&
            v.at <= now() &&
            now() - v.at < 30 * DAY
          )
            this.records.set(key, v);
    } catch {}
  }
  get<T>(key: string, ttl: number): T | undefined {
    const v = this.records.get(key);
    return v && this.now() - v.at < ttl ? (v.data as T) : undefined;
  }
  put(key: string, data: unknown) {
    this.records.delete(key);
    this.records.set(key, { at: this.now(), data });
    let entries = [...this.records].slice(-1200);
    while (entries.length) {
      const json = JSON.stringify(entries);
      if (json.length <= 1500000) {
        try {
          this.storage.setItem(CACHE, json);
          break;
        } catch {}
      }
      entries = entries.slice(Math.max(1, Math.ceil(entries.length * 0.1)));
    }
    this.records = new Map(entries);
  }
}
export interface RadarOptions {
  api: Api;
  items: Item[];
  account: { id: number; username: string } | null;
  storage: Storage;
  signal: AbortSignal;
  onProgress: (message: string) => void;
}
export async function analyzeRadar(o: RadarOptions): Promise<RadarResult> {
  const { api, signal, onProgress } = o;
  const cache = new RadarCache(o.storage);
  const scope = o.account ? 'user-' + o.account.id : 'local';
  const token = api.token;
  const check = () => {
    signal.throwIfAborted();
    if (api.token !== token) throw new DOMException('账号已变更', 'AbortError');
  };
  const recover = (error: unknown) => {
    check();
    if (error instanceof ApiError && [401, 429].includes(error.status)) throw error;
  };
  const request = async <T>(path: string, ttl: number, compact: (v: any) => T): Promise<T> => {
    check();
    const key = scope + ':' + path;
    const cached = cache.get<T>(key, ttl);
    if (cached !== undefined) return cached;
    const raw = await api.request<unknown>('GET', path, undefined, token, -1, signal);
    check();
    const data = compact(raw);
    cache.put(key, data);
    return data;
  };
  let registered: string | null = null;
  if (o.account) {
    const key = scope + ':registered';
    registered = cache.get<string>(key, 30 * DAY) || null;
    if (!registered) {
      onProgress('读取账号注册日期…');
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        try {
          const res = await fetch('/__bangumi/registration/' + o.account.id, {
            signal: controller.signal,
            credentials: 'omit',
          });
          check();
          if (res.ok) {
            const data = await res.json();
            if (data.id === o.account.id && /^\d{4}-\d{2}-\d{2}$/.test(data.registered)) {
              registered = data.registered;
              cache.put(key, registered);
            }
          }
        } finally {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
        }
      } catch (error) {
        recover(error);
      }
    }
  }
  const items = o.items
    .filter((i) => !['wish', 'not_interested'].includes(i.status))
    .sort((a, b) => a.id - b.id);
  const queue = items.map((i) => i.id);
  const itemMap = new Map(items.map((i) => [i.id, i]));
  const queued = new Set(queue);
  const nodes: RadarNode[] = [];
  const extraLimit = 120;
  let extra = 0;
  const pageEpisodes = async (id: number, progress: boolean) => {
    const list: any[] = [];
    for (let offset = 0; offset < 10000; offset += 100) {
      check();
      const path = progress
        ? '/v0/users/-/collections/' + id + '/episodes?limit=100&offset=' + offset
        : '/v0/episodes?subject_id=' + id + '&limit=100&offset=' + offset;
      const page = await request<{ total: number; data: any[] }>(
        path,
        progress ? 15 * 60000 : 7 * DAY,
        (v) => {
          if (!Array.isArray(v?.data) || !Number.isFinite(v.total)) throw Error('章节资料格式异常');
          const compact = (e: any) => ({
            id: e.id,
            type: e.type,
            airdate: e.airdate || '',
            sort: e.sort || 0,
            ep: e.ep || 0,
            name: '',
            name_cn: '',
          });
          return {
            total: v.total,
            data: v.data.map((e: any) =>
              progress ? { episode: compact(e.episode), type: e.type } : compact(e),
            ),
          };
        },
      );
      list.push(...page.data);
      if (!page.data.length || offset + page.data.length >= page.total) return list;
    }
    throw Error('章节资料过多，未计入完坑分');
  };
  for (let index = 0; index < queue.length; index++) {
    check();
    const id = queue[index],
      item = itemMap.get(id);
    onProgress('整理作品与主线 ' + (index + 1) + ' / ' + queue.length + '…');
    let subject = metadata(item || { id });
    let detailKnown = false;
    try {
      subject = await request('/v0/subjects/' + id, 7 * DAY, metadata);
      detailKnown = true;
    } catch (e) {
      recover(e);
    }
    let episodes: Episode[] | null = null,
      progress: Record<string, number> | null = null,
      relations: Relation[] | null = null;
    if (detailKnown) {
      try {
        episodes = await pageEpisodes(id, false);
      } catch (error) {
        recover(error);
      }
      if (item && token && o.account && !item.episodesComplete) {
        try {
          const data = await pageEpisodes(id, true);
          progress = Object.fromEntries(
            data.filter((v) => v.episode.type === 0).map((v) => [v.episode.id, v.type]),
          );
        } catch (error) {
          recover(error);
        }
      }
      if (item?.episodesComplete)
        progress = Object.fromEntries(
          Object.entries(item.episodeMarks).map(([id, m]) => [id, m.type]),
        );
      try {
        relations = await request('/v0/subjects/' + id + '/subjects', 7 * DAY, (v) => {
          if (!Array.isArray(v)) throw Error('系列资料格式异常');
          return v
            .filter((r) => Number.isSafeInteger(r.id) && r.id > 0)
            .map((r) => ({ id: r.id, type: r.type, relation: String(r.relation) }));
        });
      } catch (error) {
        recover(error);
      }
      for (const r of relations || [])
        if (mainline(r) && !queued.has(r.id) && extra < extraLimit) {
          queued.add(r.id);
          queue.push(r.id);
          extra++;
        }
    }
    nodes.push({ subject, item, episodes, progress, relations, detailKnown });
    // Yield between subjects so closing the dialog or starting a normal task cancels immediately.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  check();
  onProgress('生成六维画像…');
  return calculateRadar(nodes, registered, o.items.length);
}
