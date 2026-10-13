import {
  EpisodeCache,
  EPISODE_CACHE_TTL,
  validEpisodes,
  type EpisodeCollection,
} from './episode-cache';
import { quarterRange, matchesQuarter } from './season';
import {
  normalize,
  matchesContentRating,
  matchesTags,
  type Subject,
  type SearchFilters,
  type Episode,
  type Page,
  type User,
  type RemoteCollection,
} from './domain';
export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}
export interface Log {
  time: number;
  method: string;
  path: string;
  status: number;
  ms: number;
}
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('请求已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
export class Api {
  token = '';
  private episodeCache?: EpisodeCache;
  private episodeStorage?: Storage;
  private episodeAccount: number | null = null;
  private episodeToken = '';
  private episodeGeneration = 0;
  configureEpisodeCache(storage: Storage, account: number | null) {
    if (
      this.episodeStorage === storage &&
      this.episodeAccount === account &&
      this.episodeToken === this.token
    )
      return;
    this.flushEpisodeCache();
    this.episodeStorage = storage;
    this.episodeAccount = account;
    this.episodeToken = this.token;
    this.episodeCache = account && this.token ? new EpisodeCache(storage, account) : undefined;
    this.episodeGeneration++;
    for (const key of this.readCache.keys())
      if (key.includes('/collections/')) this.readCache.delete(key);
  }
  flushEpisodeCache() {
    this.episodeCache?.flush();
  }
  invalidateEpisodeCache(id?: number) {
    this.episodeGeneration++;
    for (const key of this.readCache.keys()) {
      const path = JSON.parse(key)[1] as string;
      if (
        id === undefined
          ? path.includes('/collections/')
          : path === '/v0/users/-/collections/' + id + '/episodes'
      )
        this.readCache.delete(key);
    }
    this.episodeCache?.invalidate(id);
  }
  logs: Log[] = [];
  private startQueue: Promise<void> = Promise.resolve();
  private activeRequests = 0;
  private requestWaiters: Array<{
    resume: () => void;
    priority: number;
    path: string;
    token: string;
  }> = [];
  private cooldownUntil = 0;
  private last = 0;
  private readCache = new Map<
    string,
    { expires: number; promise: Promise<any>; signal?: AbortSignal; done: boolean }
  >();
  private cached<T>(
    key: string,
    ttl: number,
    priority: number,
    signal: AbortSignal | undefined,
    load: () => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    const cacheKey = JSON.stringify([this.token, key]);
    const hit = this.readCache.get(cacheKey);
    if (
      hit &&
      hit.expires > Date.now() &&
      (hit.done || (!hit.signal?.aborted && hit.signal === signal))
    ) {
      for (const task of this.requestWaiters)
        if (
          task.token === this.token &&
          (task.path === key || task.path.startsWith(key + (key.includes('?') ? '&' : '?')))
        )
          task.priority = Math.max(task.priority, priority);
      return hit.promise;
    }
    const entry = { expires: Date.now() + ttl, signal, done: false, promise: load() };
    this.readCache.set(cacheKey, entry);
    if (this.readCache.size > 600) this.readCache.delete(this.readCache.keys().next().value!);
    void entry.promise.then(
      () => {
        entry.done = true;
      },
      () => {
        if (this.readCache.get(cacheKey) === entry) this.readCache.delete(cacheKey);
      },
    );
    return entry.promise;
  }
  constructor(
    private gap = 350,
    private maxConcurrent = 3,
  ) {}
  private async acquire(priority: number, path: string, token: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.activeRequests < this.maxConcurrent) this.activeRequests++;
    else
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          priority,
          path,
          token,
          resume: () => {
            signal?.removeEventListener('abort', abort);
            resolve();
          },
        };
        const abort = () => {
          const i = this.requestWaiters.indexOf(waiter);
          if (i >= 0) this.requestWaiters.splice(i, 1);
          reject(new DOMException('请求已取消', 'AbortError'));
        };
        this.requestWaiters.push(waiter);
        signal?.addEventListener('abort', abort, { once: true });
      });
  }
  private release() {
    this.requestWaiters.sort((a, b) => b.priority - a.priority);
    const next = this.requestWaiters.shift();
    if (next) next.resume();
    else this.activeRequests--;
  }
  private startRequest(signal?: AbortSignal) {
    const turn = this.startQueue.then(async () => {
      signal?.throwIfAborted();
      // Recheck after each sleep: another in-flight request may have received 429.
      let delay: number;
      while ((delay = Math.max(this.last + this.gap, this.cooldownUntil) - Date.now()) > 0)
        await wait(delay, signal);
      this.last = Date.now();
    });
    this.startQueue = turn.catch(() => {});
    return turn;
  }
  request<T>(
    method: string,
    path: string,
    body?: unknown,
    token = this.token,
    priority = 1,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!path.startsWith('/v0/') || path.includes('://') || path.includes('\\'))
      return Promise.reject(new Error('仅允许 Bangumi v0 API 路径'));
    const mutation =
      method !== 'GET' && path.match(/^\/v0\/users\/[^/]+\/collections\/(\d+)(?:\/episodes)?$/);
    if (mutation) this.invalidateEpisodeCache(Number(mutation[1]));
    const run = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        signal?.throwIfAborted();
        await this.startRequest(signal);
        signal?.throwIfAborted();
        const start = Date.now();
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(() => controller.abort(), 20000);
        let status = 0;
        try {
          const headers: Record<string, string> = { Accept: 'application/json' };
          if (token) headers.Authorization = `Bearer ${token}`;
          if (body !== undefined) headers['Content-Type'] = 'application/json';
          const response = await fetch(`https://api.bgm.tv${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
            redirect: 'error',
            credentials: 'omit',
          });
          status = response.status;
          const raw = await response.text();
          let data: any = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch {
            if (response.ok) throw new ApiError('服务器返回了无法识别的数据', status);
          }
          if (!response.ok) {
            if (status === 429) {
              const retry = response.headers.get('Retry-After');
              const delay =
                retry && Number.isFinite(Number(retry))
                  ? Number(retry) * 1000
                  : retry
                    ? Date.parse(retry) - Date.now()
                    : 1500 * (attempt + 1);
              this.cooldownUntil = Math.max(
                this.cooldownUntil,
                Date.now() + Math.max(1000, delay || 1500),
              );
              if (attempt < 2) continue;
            }
            const message =
              status === 401
                ? '令牌无效或已过期，请重新连接账号'
                : status === 403
                  ? '账号没有此操作权限'
                  : status === 429
                    ? '请求过于频繁，请稍后重试'
                    : `请求失败 (${status})：${data?.description || data?.title || data?.detail || '请稍后重试'}`;
            throw new ApiError(message, status);
          }
          if (mutation) this.invalidateEpisodeCache(Number(mutation[1]));
          return data as T;
        } catch (error) {
          if (signal?.aborted) throw new DOMException('分析已停止', 'AbortError');
          if (error instanceof ApiError) throw error;
          throw new ApiError(
            error instanceof Error && error.name === 'AbortError'
              ? '请求超时，请稍后重试'
              : '无法连接 Bangumi，请检查网络连接',
          );
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', abort);
          this.logs.unshift({ time: Date.now(), method, path, status, ms: Date.now() - start });
          this.logs = this.logs.slice(0, 80);
        }
      }
      throw new ApiError('请求失败');
    };
    return (async () => {
      signal?.throwIfAborted();
      await this.acquire(priority, path, token, signal);
      try {
        signal?.throwIfAborted();
        return await run();
      } finally {
        this.release();
      }
    })();
  }
  me(token = this.token) {
    return this.request<User>('GET', '/v0/me', undefined, token);
  }
  private candidatePage(
    method: string,
    path: string,
    body: unknown,
    priority: number,
    signal?: AbortSignal,
  ) {
    return this.cached<Page<unknown>>(
      JSON.stringify([method, path, body]),
      5 * 60000,
      priority,
      signal,
      async () => {
        const page = await this.request<Page<unknown>>(
          method,
          path,
          body,
          this.token,
          priority,
          ...(signal ? [signal] : []),
        );
        if (!page || !Array.isArray(page.data)) throw new ApiError('候选接口返回格式不受支持');
        return page;
      },
    );
  }
  private async filteredCandidatePage(
    f: SearchFilters,
    keyword: string,
    sort: string,
    filter: Record<string, unknown>,
    priority: number,
    signal?: AbortSignal,
  ): Promise<Page<Subject>> {
    if (f.nsfw === 'only' && !this.token)
      throw new ApiError('仅 NSFW 需要先在同步中心验证令牌并连接 Bangumi。');
    const catalog = !keyword || sort === 'date';
    const season = quarterRange(f);
    const limit = catalog ? 100 : 20;
    const offset = (f.page - 1) * limit;
    if (!catalog && offset >= 1000) return { total: 1000, data: [], hasMore: false };
    const page = await this.candidatePage(
      catalog ? 'GET' : 'POST',
      !catalog
        ? '/v0/search/subjects?limit=20&offset=' + offset
        : '/v0/subjects?type=2&sort=' +
            (sort === 'rank' ? 'rank' : 'date') +
            '&limit=100&offset=' +
            offset +
            (season ? '&year=' + f.quarterYear : ''),
      !catalog ? { keyword, sort, filter } : undefined,
      priority,
      signal,
    );
    const total = !catalog ? Math.min(page.total || 0, 1000) : page.total || 0;
    return {
      total,
      hasMore: page.data.length > 0 && offset + page.data.length < total,
      data: page.data
        .map(normalize)
        .filter(
          (s) =>
            matchesContentRating(s, f.nsfw) &&
            (!catalog ||
              !keyword ||
              (s.name + ' ' + s.name_cn)
                .toLocaleLowerCase()
                .includes(keyword.toLocaleLowerCase())) &&
            (sort !== 'rank' || s.rank > 0) &&
            s.score >= f.rating &&
            (season
              ? matchesQuarter(s, f)
              : (!f.from || s.date >= f.from + '-01-01') &&
                (!f.to || (!!s.date && s.date <= f.to + '-12-31'))) &&
            matchesTags(s, f),
        ),
    };
  }
  async search(f: SearchFilters, priority = 1, signal?: AbortSignal) {
    const keyword = f.keyword.trim();
    const sort =
      f.sort === 'rank' || f.sort === 'date' || f.sort === 'heat' || (f.sort === 'match' && keyword)
        ? f.sort
        : 'heat';
    // Browse the full official chart, rather than the search engine's capped candidate set.
    if (
      !keyword &&
      sort === 'rank' &&
      !quarterRange(f) &&
      !f.tags.length &&
      !f.from &&
      !f.to &&
      !f.rating &&
      f.nsfw !== 'only'
    ) {
      const page = await this.request<Page<unknown>>(
        'GET',
        `/v0/subjects?type=2&sort=rank&limit=${f.size}&offset=${(f.page - 1) * f.size}`,
        undefined,
        this.token,
        priority,
        ...(signal ? [signal] : []),
      );
      if (!page || !Array.isArray(page.data)) throw new ApiError('排行榜接口返回格式不受支持');
      return {
        total: page.total || 0,
        data: page.data
          .map(normalize)
          .filter((s) => s.rank > 0 && matchesContentRating(s, f.nsfw))
          .sort((a, b) => a.rank - b.rank),
      };
    }
    const filter: Record<string, unknown> = { type: [2] };
    if (sort === 'rank') filter.rank = ['>0'];
    if (f.tags.length) filter.tag = f.tags;
    // Negative meta_tags currently produces empty results. Apply weighted exclusions locally.
    if (f.nsfw !== 'all') filter.nsfw = f.nsfw === 'only';
    if (f.rating) filter.rating = [`>=${f.rating}`];
    const season = quarterRange(f);
    if (season) filter.air_date = ['>=' + season.from, '<' + season.until];
    else if (f.from || f.to)
      filter.air_date = [
        ...(f.from ? [`>=${f.from}-01-01`] : []),
        ...(f.to ? [`<=${f.to}-12-31`] : []),
      ];
    if (f.nsfw === 'only' || sort === 'date')
      return this.filteredCandidatePage(f, keyword, sort, filter, priority, signal);
    const page = await this.request<Page<unknown>>(
      'POST',
      `/v0/search/subjects?limit=${f.size}&offset=${(f.page - 1) * f.size}`,
      { keyword, sort, filter },
      this.token,
      priority,
      ...(signal ? [signal] : []),
    );
    if (!page || !Array.isArray(page.data)) throw new ApiError('搜索接口返回格式不受支持');
    const data = page.data
      .map(normalize)
      .filter((s) => matchesContentRating(s, f.nsfw) && matchesQuarter(s, f));
    return {
      total: Math.min(page.total || 0, 1000),
      data: sort === 'rank' ? data.filter((s) => s.rank > 0).sort((a, b) => a.rank - b.rank) : data,
    };
  }
  subject(id: number, priority = 1, signal?: AbortSignal) {
    const path = '/v0/subjects/' + id;
    return this.cached<Subject>(path, 15 * 60000, priority, signal, () =>
      this.request('GET', path, undefined, this.token, priority, ...(signal ? [signal] : [])).then(
        normalize,
      ),
    );
  }
  related(id: number, priority = 1, signal?: AbortSignal) {
    const path = '/v0/subjects/' + id + '/subjects';
    return this.cached<Array<{ id: number; type: number; relation: string }>>(
      path,
      15 * 60000,
      priority,
      signal,
      async () => {
        const list = await this.request<Array<{ id: number; type: number; relation: string }>>(
          'GET',
          path,
          undefined,
          this.token,
          priority,
          ...(signal ? [signal] : []),
        );
        if (!Array.isArray(list)) throw new ApiError('系列接口返回格式不受支持');
        return list;
      },
    );
  }
  characters(id: number, priority = 1, signal?: AbortSignal) {
    return this.request<
      Array<{
        id: number;
        name: string;
        relation: string;
        images?: { medium?: string; grid?: string };
      }>
    >(
      'GET',
      `/v0/subjects/${id}/characters`,
      undefined,
      this.token,
      priority,
      ...(signal ? [signal] : []),
    );
  }
  async pages<T>(
    path: string,
    priority = 1,
    token = this.token,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const results: T[] = [];
    for (let offset = 0; ;) {
      const page = await this.request<Page<T>>(
        'GET',
        `${path}${path.includes('?') ? '&' : '?'}limit=100&offset=${offset}`,
        undefined,
        token,
        priority,
        ...(signal ? [signal] : []),
      );
      if (!page || !Array.isArray(page.data) || !Number.isSafeInteger(page.total) || page.total < 0)
        throw new ApiError('分页接口返回格式不受支持');
      if (!page.data.length && offset < page.total)
        throw new ApiError('单集分页未读取完整，请重试');
      results.push(...page.data);
      offset += page.data.length;
      if (offset >= page.total || !page.data.length) return results;
      if (offset >= 10000) throw new ApiError('条目章节数超过处理上限，未写入章节进度');
    }
  }
  episodes(id: number, priority = 1, signal?: AbortSignal) {
    const path = '/v0/episodes?subject_id=' + id;
    return this.cached<Episode[]>(path, 15 * 60000, priority, signal, () =>
      this.pages<Episode>(path, priority, this.token, signal),
    );
  }
  episodeCollections(id: number, priority = 1, signal?: AbortSignal): Promise<EpisodeCollection[]> {
    signal?.throwIfAborted();
    const cache = this.episodeToken === this.token ? this.episodeCache : undefined;
    const hit = cache?.get(id);
    if (hit !== undefined) return Promise.resolve(hit);
    const path = '/v0/users/-/collections/' + id + '/episodes';
    const token = this.token,
      generation = this.episodeGeneration;
    return this.cached<EpisodeCollection[]>(path, EPISODE_CACHE_TTL, priority, signal, async () => {
      const rows = await this.pages<EpisodeCollection>(path, priority, token, signal);
      signal?.throwIfAborted();
      if (!validEpisodes(rows)) throw new ApiError('单集收藏格式无效，未生成不完整备份');
      if (this.token !== token || this.episodeGeneration !== generation)
        throw new DOMException('单集记录已更新，请重试', 'AbortError');
      const compact = rows.map(({ episode: e, type, updated_at }) => ({
        episode: {
          id: e.id,
          type: e.type,
          sort: e.sort,
          ep: e.ep,
          airdate: e.airdate,
          name: e.name,
          name_cn: e.name_cn,
        },
        type,
        ...(updated_at === undefined ? {} : { updated_at }),
      }));
      cache?.put(id, compact);
      return compact;
    });
  }
  collections(username: string, offset: number) {
    return this.request<Page<RemoteCollection>>(
      'GET',
      `/v0/users/${encodeURIComponent(username)}/collections?subject_type=2&limit=50&offset=${offset}`,
    );
  }
}
