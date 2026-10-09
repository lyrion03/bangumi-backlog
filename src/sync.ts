import { Api, ApiError } from './api';
import { Store } from './store';
import {
  STATUS,
  aired,
  normalize,
  statusFromType,
  validateItem,
  type Item,
  type User,
  type RemoteCollection,
  type Status,
} from './domain';
export type ConflictChoice = 'local' | 'remote' | 'cancel';
export interface StatusConflict {
  local: Item;
  remoteStatus: Status;
}
export interface Progress {
  mode: 'push' | 'pull' | '';
  done: number;
  total: number;
  failed: number;
  message: string;
  active: boolean;
}
export function collectionPayload(item: Item) {
  return {
    type: STATUS[item.status].type,
    ...(item.metadata
      ? {
          rate: item.rate,
          comment: item.comment,
          private: item.private,
          ...(item.collectionTags.length ? { tags: item.collectionTags } : {}),
        }
      : {}),
  };
}
export class Sync {
  progress: Progress = { mode: '', done: 0, total: 0, failed: 0, message: '', active: false };
  private cancelled = false;
  get wasCancelled() {
    return this.cancelled;
  }
  onProgress = () => {};
  onCancel = () => {};
  onConflicts: (items: StatusConflict[], mode: 'push' | 'pull') => Promise<ConflictChoice> =
    async () => 'cancel';
  constructor(
    private store: Store,
    private api: Api,
  ) {}
  cancel() {
    this.cancelled = true;
    this.onCancel();
    this.progress.message = '正在完成已开始的条目，不再启动新条目…';
    this.onProgress();
  }
  private begin(mode: 'push' | 'pull', total: number) {
    if (this.progress.active) throw new Error('请等待当前同步完成');
    this.cancelled = false;
    this.progress = { mode, done: 0, total, failed: 0, message: '正在准备…', active: true };
    this.onProgress();
  }
  private async parallel<T>(items: T[], work: (item: T) => Promise<void>) {
    let next = 0;
    let failed = false;
    let failure: unknown;
    await Promise.all(
      Array.from({ length: Math.min(3, items.length) }, async () => {
        while (!this.cancelled && !failed && next < items.length) {
          const item = items[next++];
          try {
            await work(item);
          } catch (error) {
            failed = true;
            failure ??= error;
          }
        }
      }),
    );
    // Wait for every already-started worker before ending the sync or allowing a retry.
    if (failed) throw failure;
  }
  async push(ids = this.store.dirty().map((i) => i.id), reviewConflicts = false) {
    if (!this.api.token) throw new Error('请先连接 Bangumi 账号');
    ids = [...new Set(ids)];
    this.begin('push', ids.length);
    const token = this.api.token;
    const completeEpisodes = this.store.state.settings.completeEpisodes;
    const snapshots = new Map(
      ids.flatMap((id) => {
        const item = this.store.get(id);
        return item?.dirty && item.status !== 'not_interested'
          ? [[id, structuredClone(item)] as const]
          : [];
      }),
    );
    const skip = new Set<number>();
    try {
      if (reviewConflicts) {
        const conflicts: StatusConflict[] = [];
        await this.parallel([...snapshots.values()], async (item) => {
          this.progress.message = `正在核对云端状态：${item.name_cn || item.name}`;
          this.onProgress();
          try {
            const remote = await this.api.request<RemoteCollection>(
              'GET',
              '/v0/users/-/collections/' + item.id,
              undefined,
              token,
            );
            const remoteStatus = statusFromType(remote?.type);
            if (!remoteStatus) throw new Error('云端收藏状态格式无效，请稍后重试');
            if (remoteStatus !== item.status) conflicts.push({ local: item, remoteStatus });
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) throw error;
          }
        });
        conflicts.sort((a, b) => ids.indexOf(a.local.id) - ids.indexOf(b.local.id));
        if (conflicts.length && !this.cancelled) {
          this.progress.message = `发现 ${conflicts.length} 条状态冲突，等待选择…`;
          this.onProgress();
          const choice = await this.onConflicts(conflicts, 'push');
          if (choice === 'cancel') this.cancelled = true;
          if (choice === 'remote' && !this.cancelled) {
            for (const conflict of conflicts) {
              this.store.resolveStatus(
                conflict.local.id,
                conflict.local.revision,
                conflict.remoteStatus,
                true,
              );
              skip.add(conflict.local.id);
            }
          }
        }
      }
      await this.parallel(ids, async (id) => {
        if (skip.has(id)) {
          this.progress.done++;
          return;
        }
        const current = this.store.get(id);
        if (reviewConflicts && current?.revision !== snapshots.get(id)?.revision) return;
        if (!current?.dirty || current.status === 'not_interested') return;
        const item = structuredClone(current);
        this.progress.message = `正在推送：${item.name_cn || item.name}`;
        this.onProgress();
        try {
          await this.api.request(
            'POST',
            `/v0/users/-/collections/${id}`,
            collectionPayload(item),
            token,
          );
          const changes: Record<string, number> = {};
          if (item.status === 'collect' && completeEpisodes && !item.restoreEpisodes) {
            const episodes = await this.api.episodes(id);
            for (const ep of episodes) if (ep.type === 0 && aired(ep.airdate)) changes[ep.id] = 2;
          }
          Object.assign(changes, item.episodeChanges);
          for (const type of [0, 1, 2, 3]) {
            const episodes = Object.keys(changes)
              .filter((id) => changes[id] === type)
              .map(Number);
            for (let offset = 0; offset < episodes.length; offset += 100) {
              await this.api.request(
                'PATCH',
                `/v0/users/-/collections/${id}/episodes`,
                { episode_id: episodes.slice(offset, offset + 100), type },
                token,
              );
            }
          }
          this.store.synced(id, item.revision, changes);
        } catch (error) {
          this.progress.failed++;
          this.store.failed(id, item.revision, (error as Error).message);
          if (error instanceof ApiError && [401, 403].includes(error.status)) {
            this.cancelled = true;
          }
        }
        this.progress.done++;
        this.onProgress();
      });
      this.progress.message = `${this.cancelled ? '同步已停止' : '同步完成'} · 已处理 ${this.progress.done} 条${this.progress.failed ? `，${this.progress.failed} 条失败，可重试` : ''}`;
    } catch (error) {
      this.progress.message = (error as Error).message;
      throw error;
    } finally {
      this.progress.active = false;
      this.onProgress();
    }
  }
  async pull(user: User) {
    if (!this.api.token) throw new Error('请先连接 Bangumi 账号');
    this.begin('pull', 0);
    let merged = 0;
    try {
      const items: Item[] = [];
      for (let offset = 0; !this.cancelled;) {
        const page = await this.api.collections(user.username || String(user.id), offset);
        this.progress.total = page.total;
        for (const entry of page.data) {
          const status = statusFromType(entry.type);
          if (status)
            items.push(
              validateItem({
                ...normalize(entry.subject),
                id: entry.subject_id,
                status,
                rate: entry.rate,
                comment: entry.comment,
                private: entry.private,
                collectionTags: entry.tags,
                dirty: false,
                syncedAt: Date.now(),
                updatedAt: entry.updated_at ? Date.parse(entry.updated_at) || 0 : 0,
              }),
            );
        }
        offset += page.data.length;
        this.progress.done = offset;
        this.progress.message = `已读取 ${offset} / ${page.total} 条，正在核对状态`;
        this.onProgress();
        if (!page.data.length || offset >= page.total) break;
      }
      const revisions = new Map(items.map((item) => [item.id, this.store.get(item.id)?.revision]));
      const conflicts: StatusConflict[] = items.flatMap((item) => {
        const local = this.store.get(item.id);
        return local && local.status !== item.status
          ? [{ local: structuredClone(local), remoteStatus: item.status }]
          : [];
      });
      let choice: ConflictChoice = 'local';
      if (conflicts.length && !this.cancelled) {
        this.progress.message = `发现 ${conflicts.length} 条状态冲突，等待选择…`;
        this.onProgress();
        choice = await this.onConflicts(conflicts, 'pull');
        if (choice === 'cancel') this.cancelled = true;
      }
      if (!this.cancelled) {
        const conflicting = new Set(conflicts.map((c) => c.local.id));
        merged += this.store.merge(
          items.filter(
            (item) =>
              !conflicting.has(item.id) &&
              this.store.get(item.id)?.revision === revisions.get(item.id),
          ),
        );
        for (const conflict of conflicts) {
          if (
            this.store.resolveStatus(
              conflict.local.id,
              conflict.local.revision,
              choice === 'remote' ? conflict.remoteStatus : conflict.local.status,
              choice === 'remote',
            )
          )
            merged++;
        }
        this.store.pulled();
      }
      this.progress.message = `${this.cancelled ? '拉取已取消，未合并本批记录' : '拉取完成'} · 处理 ${merged} 条`;
    } catch (error) {
      this.progress.message = (error as Error).message;
      throw error;
    } finally {
      this.progress.active = false;
      this.onProgress();
    }
  }
}
