import { TAG_POLICY } from './tags';
export const STATUS = {
  wish: { label: '想看', type: 1 },
  collect: { label: '看过', type: 2 },
  doing: { label: '在看', type: 3 },
  on_hold: { label: '搁置', type: 4 },
  dropped: { label: '抛弃', type: 5 },
  not_interested: { label: '不感兴趣', type: 0 },
} as const;
export type Status = keyof typeof STATUS;
export const QUICK: Status[] = ['collect', 'on_hold', 'dropped'];
export interface Subject {
  id: number;
  name: string;
  name_cn: string;
  image: string;
  date: string;
  score: number;
  rank: number;
  platform: string;
  runtime?: string;
  summary: string;
  tags: string[];
  tagVotes: Array<{ name: string; count: number }>;
  nsfw: boolean;
}
export interface EpisodeMark {
  type: number;
  markedAt: number | null;
}
export interface Item extends Subject {
  markedAt: number | null;
  episodeMarks: Record<string, EpisodeMark>;
  episodesComplete: boolean;
  restoreEpisodes: boolean;
  status: Status;
  rate: number;
  comment: string;
  private: boolean;
  collectionTags: string[];
  metadata: boolean;
  dirty: boolean;
  revision: number;
  updatedAt: number;
  syncedAt: number | null;
  error?: string;
  episodeChanges: Record<string, number>;
}
export interface User {
  id: number;
  username: string;
  nickname: string;
  avatar?: { medium?: string };
}
export interface Episode {
  duration?: string;
  id: number;
  type: number;
  sort: number;
  ep: number;
  name: string;
  name_cn: string;
  airdate: string;
}
export interface Page<T> {
  /** Explicit continuation for filtered, variable-sized source chunks. */
  hasMore?: boolean;
  data: T[];
  total: number;
}
export interface RemoteCollection {
  updated_at?: string;
  subject_id: number;
  subject?: unknown;
  type: number;
  rate: number;
  comment: string;
  private: boolean;
  tags: string[];
}
export interface SearchFilters {
  keyword: string;
  sort: string;
  tags: string[];
  excluded: string[];
  from: string;
  to: string;
  quarterYear: string;
  quarter: string;
  rating: number;
  nsfw: string;
  page: number;
  size: number;
}
export const defaults = (): SearchFilters => ({
  keyword: '',
  sort: 'heat',
  tags: [],
  excluded: [],
  from: '',
  to: '',
  quarterYear: '',
  quarter: '',
  rating: 0,
  nsfw: 'hide',
  page: 1,
  size: 20,
});
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');
export const number = (value: unknown, fallback = 0): number =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;
export function safeImage(value: unknown): string {
  try {
    const url = new URL(text(value));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}
export function normalizeTagVotes(raw: unknown): Array<{ name: string; count: number }> {
  const votes = new Map<string, number>();
  if (!Array.isArray(raw)) return [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const name = text(value.name).trim().normalize('NFKC').toLowerCase();
    const count = Math.max(0, Math.floor(number(value.count)));
    if (name && count > 0) votes.set(name, Math.max(votes.get(name) ?? 0, count));
  }
  return [...votes].map(([name, count]) => ({ name, count }));
}
export function hasSignificantTag(subject: Subject, tag: string) {
  const votes = subject.tagVotes;
  const maximum = Math.max(0, ...votes.map((t) => t.count));
  const count =
    votes.find((t) => t.name === tag.trim().normalize('NFKC').toLowerCase())?.count ?? 0;
  return (
    maximum > 0 &&
    count >= TAG_POLICY.minimumVotes &&
    count * 100 >= maximum * TAG_POLICY.strongestTagPercent
  );
}
export function matchesContentRating(subject: Subject, mode: SearchFilters['nsfw']) {
  return mode === 'only' ? subject.nsfw : mode === 'hide' ? !subject.nsfw : true;
}
export function matchesTags(subject: Subject, filters: SearchFilters) {
  return (
    filters.tags.every((tag) => hasSignificantTag(subject, tag)) &&
    !filters.excluded.some((tag) => hasSignificantTag(subject, tag))
  );
}
export function normalize(value: unknown): Subject {
  const s = (value && typeof value === 'object' ? value : {}) as Record<string, any>;
  return {
    id: number(s.id),
    name: text(s.name),
    name_cn: text(s.name_cn),
    image: safeImage(
      s.image || s.images?.large || s.images?.common || s.images?.medium || s.images?.small,
    ),
    date: text(s.date || s.air_date),
    score: number(s.rating?.score ?? s.score),
    rank: number(s.rating?.rank ?? s.rank),
    platform: text(s.platform),
    runtime:
      text(s.runtime) ||
      text(
        Array.isArray(s.infobox)
          ? s.infobox.find((v: any) => ['片长', '时长'].includes(v.key))?.value
          : '',
      ),
    summary: text(s.summary),
    tags: Array.isArray(s.tags) ? s.tags.map((t: any) => text(t?.name ?? t)).filter(Boolean) : [],
    tagVotes: normalizeTagVotes(s.tagVotes ?? s.tags),
    nsfw: !!s.nsfw,
  };
}
export const title = (s: Subject) => s.name_cn || s.name || `条目 #${s.id}`;
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const aired = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today();
export function statusFromType(type: number): Status | undefined {
  return (Object.keys(STATUS) as Status[]).find((s) => STATUS[s].type === type && type !== 0);
}
export function markTime(value: unknown): number | null {
  const n = typeof value === 'string' ? Date.parse(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 8640000000000000 ? n : null;
}
export function validateItem(raw: unknown): Item {
  if (!raw || typeof raw !== 'object') throw new Error('记录格式无效');
  const r = raw as Record<string, any>;
  const subject = normalize(r);
  if (!Number.isSafeInteger(subject.id) || subject.id <= 0 || !Object.hasOwn(STATUS, r.status))
    throw new Error('记录包含无效条目 ID 或状态');
  const episodeChanges: Record<string, number> = {};
  for (const [id, type] of Object.entries(r.episodeChanges || {})) {
    if (/^[1-9]\d*$/.test(id) && [0, 1, 2, 3].includes(type as number))
      episodeChanges[id] = type as number;
  }
  const episodeMarks: Record<string, EpisodeMark> = {};
  for (const [id, value] of Object.entries(r.episodeMarks || {})) {
    const ep = value as EpisodeMark;
    if (/^[1-9]\d*$/.test(id) && ep && [0, 1, 2, 3].includes(ep.type))
      episodeMarks[id] = { type: ep.type, markedAt: markTime(ep.markedAt) };
  }
  for (const [id, type] of Object.entries(episodeChanges))
    if (episodeMarks[id]?.type !== type) episodeMarks[id] = { type, markedAt: null };
  return {
    ...subject,
    markedAt: markTime(r.markedAt),
    episodeMarks,
    episodesComplete: r.episodesComplete === true,
    restoreEpisodes: r.restoreEpisodes === true,
    status: r.status,
    rate: Math.max(0, Math.min(10, Math.round(number(r.rate)))),
    comment: text(r.comment).slice(0, 20000),
    private: !!r.private,
    collectionTags: Array.isArray(r.collectionTags)
      ? r.collectionTags.filter((x: unknown) => typeof x === 'string').slice(0, 100)
      : [],
    metadata: !!r.metadata,
    dirty: r.status !== 'not_interested' && !!r.dirty,
    revision: Math.max(1, number(r.revision, 1)),
    updatedAt: number(r.updatedAt, Date.now()),
    syncedAt: r.syncedAt ? number(r.syncedAt) : null,
    episodeChanges: r.status === 'not_interested' ? {} : episodeChanges,
  };
}
