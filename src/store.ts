import {
  type Item,
  type Subject,
  type Status,
  type User,
  validateItem,
  markTime,
  type EpisodeMark,
} from './domain';
export const STORAGE_KEY = 'bangumi-batch-marker-v1';
export interface State {
  version: 1;
  preferencesVersion: 2;
  items: Record<string, Item>;
  owner: number | null;
  account: { id: number; username: string; nickname: string | null } | null;
  lastPull: number | null;
  settings: { realtime: boolean; completeEpisodes: boolean; autoNext: boolean };
}
const empty = (): State => ({
  version: 1,
  preferencesVersion: 2,
  items: {},
  owner: null,
  account: null,
  lastPull: null,
  settings: { realtime: true, completeEpisodes: true, autoNext: false },
});
export class Store {
  state: State = empty();
  private listeners = new Set<() => void>();
  private revision = Date.now();
  loadError = '';
  constructor(private storage: Storage) {
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.version !== 1 || !saved.items || typeof saved.items !== 'object')
        throw new Error('存档版本或格式不受支持');
      const items = Object.fromEntries(
        Object.values(saved.items).map((r) => {
          const i = validateItem(r);
          return [i.id, i];
        }),
      );
      this.state = {
        ...empty(),
        items,
        owner: Number.isSafeInteger(saved.owner) ? saved.owner : null,
        account:
          saved.account?.id === saved.owner && typeof saved.account?.username === 'string'
            ? {
                id: saved.owner,
                username: saved.account.username,
                nickname:
                  typeof saved.account.nickname === 'string' ? saved.account.nickname : null,
              }
            : null,
        lastPull: typeof saved.lastPull === 'number' ? saved.lastPull : null,
        settings: {
          realtime: saved.preferencesVersion === 2 ? saved.settings?.realtime !== false : true,
          completeEpisodes: saved.settings?.completeEpisodes !== false,
          autoNext: !!saved.settings?.autoNext,
        },
      };
    } catch {
      this.loadError =
        '无法读取本地存档。为保护原数据，已暂停保存；请先导出原始存档或修复浏览器存储。';
    }
  }
  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private commit(next: State) {
    if (this.loadError) throw new Error(this.loadError);
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      throw new Error('本地保存失败：浏览器存储空间不足或存储被禁用。请先导出备份。');
    }
    this.state = next;
    this.listeners.forEach((fn) => fn());
  }
  all() {
    return Object.values(this.state.items);
  }
  get(id: number) {
    return this.state.items[id];
  }
  dirty() {
    return this.all().filter((i) => i.dirty && i.status !== 'not_interested');
  }
  mark(
    subjects: Subject[],
    status: Status,
    patch: Partial<Pick<Item, 'rate' | 'comment' | 'private' | 'episodeChanges'>> = {},
  ) {
    const items = { ...this.state.items };
    for (const subject of subjects) {
      const prev = items[subject.id];
      const episodeMarks = { ...prev?.episodeMarks };
      for (const [id, type] of Object.entries(patch.episodeChanges || {}))
        if (episodeMarks[id]?.type !== type) episodeMarks[id] = { type, markedAt: Date.now() };
      items[subject.id] = validateItem({
        ...prev,
        ...subject,
        status,
        rate: prev?.rate ?? 0,
        comment: prev?.comment ?? '',
        private: prev?.private ?? false,
        ...patch,
        metadata:
          !!prev?.metadata ||
          ['rate', 'comment', 'private'].some((key) => Object.hasOwn(patch, key)),
        dirty: status !== 'not_interested',
        revision: Math.max(++this.revision, (prev?.revision ?? 0) + 1),
        markedAt: prev?.status === status ? prev.markedAt : Date.now(),
        episodeMarks,
        updatedAt: Date.now(),
      });
    }
    this.commit({ ...this.state, items });
  }
  synced(id: number, revision: number, changes: Record<string, number> = {}) {
    const item = this.get(id);
    if (!item || item.revision !== revision) return;
    const items = {
      ...this.state.items,
      [id]: {
        ...item,
        dirty: false,
        metadata: false,
        syncedAt: Date.now(),
        error: undefined,
        episodeChanges: {},
        restoreEpisodes: false,
        episodeMarks: {
          ...item.episodeMarks,
          ...Object.fromEntries(
            Object.entries({ ...changes, ...item.episodeChanges }).map(([id, type]) => [
              id,
              {
                type,
                markedAt:
                  item.episodeMarks[id]?.type === type
                    ? item.episodeMarks[id].markedAt
                    : Date.now(),
              },
            ]),
          ),
        },
      },
    };
    this.commit({ ...this.state, items });
  }
  failed(id: number, revision: number, error: string) {
    const item = this.get(id);
    if (item?.revision === revision)
      this.commit({ ...this.state, items: { ...this.state.items, [id]: { ...item, error } } });
  }
  resolveStatus(id: number, revision: number, status: Status, fromCloud: boolean) {
    const current = this.get(id);
    if (!current || current.revision !== revision) return false;
    const dirty =
      status !== 'not_interested' &&
      (!fromCloud || current.metadata || Object.keys(current.episodeChanges).length > 0);
    const item = {
      ...current,
      status,
      dirty,
      error: undefined,
      revision: Math.max(++this.revision, current.revision + 1),
      markedAt: status === current.status ? current.markedAt : fromCloud ? null : Date.now(),
      updatedAt: Date.now(),
      syncedAt: fromCloud ? Date.now() : current.syncedAt,
    };
    this.commit({ ...this.state, items: { ...this.state.items, [id]: item } });
    return true;
  }
  merge(items: Item[]) {
    const next = { ...this.state.items };
    let count = 0;
    for (const item of items) {
      if (next[item.id]?.dirty || next[item.id]?.status === 'not_interested') continue;
      const previous = next[item.id];
      next[item.id] = {
        ...item,
        markedAt: previous?.status === item.status ? previous.markedAt : item.markedAt,
        episodeMarks: { ...previous?.episodeMarks, ...item.episodeMarks },
        episodesComplete: previous?.episodesComplete || item.episodesComplete,
      };
      count++;
    }
    this.commit({ ...this.state, items: next });
    return count;
  }
  remove(ids: number[]) {
    const items = { ...this.state.items };
    ids.forEach((id) => delete items[id]);
    this.commit({ ...this.state, items });
  }
  clear() {
    this.commit({ ...empty(), settings: this.state.settings });
  }
  settings(patch: Partial<State['settings']>) {
    this.commit({ ...this.state, settings: { ...this.state.settings, ...patch } });
  }
  bind(user: User) {
    if (this.state.owner && this.state.owner !== user.id && this.all().length)
      throw new Error('这些记录属于另一个账号。请先导出备份并清空本地记录，再连接新账号。');
    this.commit({
      ...this.state,
      owner: user.id,
      account: { id: user.id, username: user.username, nickname: user.nickname || null },
    });
  }
  pulled() {
    this.commit({ ...this.state, lastPull: Date.now() });
  }
  rememberEpisodes(
    records: Array<{ id: number; revision: number; marks: Record<string, EpisodeMark> }>,
  ) {
    const items = { ...this.state.items };
    for (const { id, revision, marks } of records) {
      const item = items[id];
      if (item?.revision === revision)
        items[id] = { ...item, episodeMarks: marks, episodesComplete: true };
    }
    this.commit({ ...this.state, items });
  }
  export() {
    return {
      type: 'bangumi-backlog',
      version: 2,
      exportedAt: new Date().toISOString(),
      account: { id: this.state.owner, username: this.state.account?.nickname || null },
      items: this.all().map((item) => ({
        id: item.id,
        status: item.status,
        markedAt: item.markedAt ? new Date(item.markedAt).toISOString() : null,
        updatedAt: item.updatedAt ? new Date(item.updatedAt).toISOString() : null,
        episodesComplete: item.episodesComplete,
        episodes: Object.entries(item.episodeMarks).map(([id, ep]) => ({
          id: Number(id),
          type: ep.type,
          markedAt: ep.markedAt ? new Date(ep.markedAt).toISOString() : null,
        })),
      })),
    };
  }
  parseImport(data: unknown) {
    if (!data || typeof data !== 'object' || !Array.isArray((data as any).items))
      throw new Error('备份必须包含 items 数组（兼容旧版备份）。');
    const raw = (data as any).items;
    if (raw.length > 50000) throw new Error('单次导入不能超过 50,000 条');
    // Validate the entire file before changing any local state.
    if (
      (data as any).version === 2 &&
      ['bangumi-backlog', 'bangumi-batch-marker'].includes((data as any).type)
    ) {
      return raw.map((r: any) => {
        if (!r || !Array.isArray(r.episodes)) throw new Error('单集备份格式无效');
        const episodeMarks: Record<string, EpisodeMark> = {};
        for (const ep of r.episodes) {
          if (!ep || !Number.isSafeInteger(ep.id) || ep.id <= 0 || ![0, 1, 2, 3].includes(ep.type))
            throw new Error('单集备份包含无效 ID 或状态');
          episodeMarks[ep.id] = { type: ep.type, markedAt: markTime(ep.markedAt) };
        }
        return validateItem({
          id: r.id,
          status: r.status,
          markedAt: markTime(r.markedAt),
          updatedAt: markTime(r.updatedAt) || 0,
          episodeMarks,
          episodesComplete: r.episodesComplete === true,
          restoreEpisodes: true,
          episodeChanges: Object.fromEntries(
            Object.entries(episodeMarks).map(([id, ep]) => [id, ep.type]),
          ),
        });
      });
    }
    return raw.map((r: unknown) => validateItem(r));
  }
  import(items: Item[]) {
    const next = { ...this.state.items };
    let count = 0;
    for (const item of items) {
      if (next[item.id]) continue;
      next[item.id] = {
        ...item,
        metadata: item.restoreEpisodes ? false : true,
        dirty: item.status !== 'not_interested',
        syncedAt: null,
      };
      count++;
    }
    this.commit({ ...this.state, items: next });
    return count;
  }
}
