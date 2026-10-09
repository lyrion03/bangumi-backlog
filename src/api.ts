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
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export class Api {
  token = '';
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
  private details = new Map<number, { token: string; at: number; promise: Promise<Subject> }>();
  constructor(private gap = 350) {}
  private async acquire(priority: number, path: string, token: string) {
    if (this.activeRequests < 3) this.activeRequests++;
    else
      await new Promise<void>((resume) =>
        this.requestWaiters.push({ resume, priority, path, token }),
      );
  }
  private release() {
    this.requestWaiters.sort((a, b) => b.priority - a.priority);
    const next = this.requestWaiters.shift();
    if (next) next.resume();
    else this.activeRequests--;
  }
  private promote(path: string, priority: number) {
    for (const waiting of this.requestWaiters)
      if (waiting.path === path && waiting.token === this.token)
        waiting.priority = Math.max(waiting.priority, priority);
  }
  private startRequest() {
    const turn = this.startQueue.then(async () => {
      // Recheck after each sleep: another in-flight request may have received 429.
      let delay: number;
      while ((delay = Math.max(this.last + this.gap, this.cooldownUntil) - Date.now()) > 0)
        await wait(delay);
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
  ): Promise<T> {
    if (!path.startsWith('/v0/') || path.includes('://') || path.includes('\\'))
      return Promise.reject(new Error('仅允许 Bangumi v0 API 路径'));
    const run = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.startRequest();
        const start = Date.now();
        const controller = new AbortController();
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
          return data as T;
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw new ApiError(
            error instanceof Error && error.name === 'AbortError'
              ? '请求超时，请稍后重试'
              : '无法连接 Bangumi，请检查网络连接',
          );
        } finally {
          clearTimeout(timeout);
          this.logs.unshift({ time: Date.now(), method, path, status, ms: Date.now() - start });
          this.logs = this.logs.slice(0, 80);
        }
      }
      throw new ApiError('请求失败');
    };
    return (async () => {
      await this.acquire(priority, path, token);
      try {
        return await run();
      } finally {
        this.release();
      }
    })();
  }
  me(token = this.token) {
    return this.request<User>('GET', '/v0/me', undefined, token);
  }
  private candidatePages = new Map<string, { expires: number; promise: Promise<Page<unknown>> }>();
  private candidatePage(method: string, path: string, body: unknown, priority: number) {
    const token = this.token;
    const key = JSON.stringify([token, method, path, body]);
    const cached = this.candidatePages.get(key);
    if (cached && cached.expires > Date.now()) {
      this.promote(path, priority);
      return cached.promise;
    }
    const promise = this.request<Page<unknown>>(method, path, body, token, priority).then(
      (page) => {
        if (!page || !Array.isArray(page.data)) throw new ApiError('候选接口返回格式不受支持');
        return page;
      },
    );
    this.candidatePages.set(key, { expires: Date.now() + 5 * 60 * 1000, promise });
    if (this.candidatePages.size > 80)
      this.candidatePages.delete(this.candidatePages.keys().next().value!);
    void promise.catch(() => {
      if (this.candidatePages.get(key)?.promise === promise) this.candidatePages.delete(key);
    });
    return promise;
  }
  private async filteredCandidatePage(
    f: SearchFilters,
    keyword: string,
    sort: string,
    filter: Record<string, unknown>,
    priority: number,
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
  async search(f: SearchFilters, priority = 1) {
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
      return this.filteredCandidatePage(f, keyword, sort, filter, priority);
    const page = await this.request<Page<unknown>>(
      'POST',
      `/v0/search/subjects?limit=${f.size}&offset=${(f.page - 1) * f.size}`,
      { keyword, sort, filter },
      this.token,
      priority,
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
  subject(id: number, priority = 1) {
    const path = `/v0/subjects/${id}`;
    const cached = this.details.get(id);
    if (cached && cached.token === this.token && Date.now() - cached.at < 15 * 60 * 1000) {
      this.promote(path, priority);
      return cached.promise;
    }
    const entry = {
      token: this.token,
      at: Date.now(),
      promise: this.request('GET', path, undefined, this.token, priority).then(normalize),
    };
    this.details.set(id, entry);
    if (this.details.size > 600) this.details.delete(this.details.keys().next().value!);
    void entry.promise.catch(() => {
      if (this.details.get(id) === entry) this.details.delete(id);
    });
    return entry.promise;
  }
  private relatedCache = new Map<
    number,
    {
      token: string;
      expires: number;
      value: Promise<Array<{ id: number; type: number; relation: string }>>;
    }
  >();
  related(id: number, priority = 1) {
    const cached = this.relatedCache.get(id);
    if (cached && cached.token === this.token && cached.expires > Date.now()) {
      this.promote(`/v0/subjects/${id}/subjects`, priority);
      return cached.value;
    }
    const entry = {
      token: this.token,
      expires: Date.now() + 15 * 60 * 1000,
      value: this.loadRelated(id, priority),
    };
    this.relatedCache.set(id, entry);
    if (this.relatedCache.size > 300)
      this.relatedCache.delete(this.relatedCache.keys().next().value!);
    entry.value.catch(() => {
      if (this.relatedCache.get(id) === entry) this.relatedCache.delete(id);
    });
    return entry.value;
  }
  private async loadRelated(id: number, priority: number) {
    const list = await this.fetchRelated(id, priority);
    if (!Array.isArray(list)) throw new ApiError('系列接口返回格式不受支持');
    return list;
  }
  private fetchRelated(id: number, priority: number) {
    return this.request<Array<{ id: number; type: number; relation: string }>>(
      'GET',
      `/v0/subjects/${id}/subjects`,
      undefined,
      this.token,
      priority,
    );
  }
  characters(id: number, priority = 1) {
    return this.request<
      Array<{
        id: number;
        name: string;
        relation: string;
        images?: { medium?: string; grid?: string };
      }>
    >('GET', `/v0/subjects/${id}/characters`, undefined, this.token, priority);
  }
  async pages<T>(path: string, priority = 1, token = this.token): Promise<T[]> {
    const results: T[] = [];
    for (let offset = 0; ;) {
      const page = await this.request<Page<T>>(
        'GET',
        `${path}${path.includes('?') ? '&' : '?'}limit=100&offset=${offset}`,
        undefined,
        token,
        priority,
      );
      if (!page || !Array.isArray(page.data)) throw new ApiError('分页接口返回格式不受支持');
      results.push(...page.data);
      offset += page.data.length;
      if (offset >= page.total || !page.data.length) return results;
      if (offset >= 10000) throw new ApiError('条目章节数超过处理上限，未写入章节进度');
    }
  }
  private episodeCache = new Map<
    number,
    { token: string; at: number; promise: Promise<Episode[]> }
  >();
  episodes(id: number, priority = 1) {
    const cached = this.episodeCache.get(id);
    if (cached && cached.token === this.token && Date.now() - cached.at < 15 * 60 * 1000) {
      for (const queued of this.requestWaiters)
        if (queued.token === this.token && queued.path.startsWith(`/v0/episodes?subject_id=${id}&`))
          queued.priority = Math.max(queued.priority, priority);
      return cached.promise;
    }
    const promise = this.pages<Episode>(`/v0/episodes?subject_id=${id}`, priority);
    const entry = { token: this.token, at: Date.now(), promise };
    this.episodeCache.set(id, entry);
    if (this.episodeCache.size > 150)
      this.episodeCache.delete(this.episodeCache.keys().next().value!);
    promise.catch(() => {
      if (this.episodeCache.get(id) === entry) this.episodeCache.delete(id);
    });
    return promise;
  }
  episodeCollections(id: number, priority = 1) {
    return this.pages<{ episode: Episode; type: number; updated_at?: number }>(
      `/v0/users/-/collections/${id}/episodes`,
      priority,
    );
  }
  collections(username: string, offset: number) {
    return this.request<Page<RemoteCollection>>(
      'GET',
      `/v0/users/${encodeURIComponent(username)}/collections?subject_type=2&limit=50&offset=${offset}`,
    );
  }
}
