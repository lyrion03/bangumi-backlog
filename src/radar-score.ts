import { normalize, type Subject, type Item, type Episode } from './domain';
export const RADAR_VERSION = 1;
export const AXES = [
  ['老资历', '注册年份基础分，加上有效观看量与跨年代阅片积累'],
  ['婆罗门', '公共口碑、作者表达与创作者覆盖；不使用个人评分'],
  ['小众', '结合年代与类型衡量站内冷门探索，新作不因人数少而加分'],
  ['猎奇', '怪诞、身体恐怖、心理压迫等内容接触；NSFW 本身不加分'],
  ['完坑', '已完结正篇的收尾与主线系列补全；不计 SP，完结后留 30 天宽限'],
  ['现充', '现实生活、人际关系、大众易接触与温和题材取向'],
] as const;
export type Relation = { id: number; type: number; relation: string };
export interface RadarSubject extends Subject {
  votes: number | null;
  collectors: number | null;
  expected: number;
  creators: string[];
  meta: string[];
  end: string;
}
export interface RadarNode {
  subject: RadarSubject;
  item?: Item;
  episodes: Episode[] | null;
  progress: Record<string, number> | null;
  relations: Relation[] | null;
  detailKnown: boolean;
}
export interface RadarResult {
  scores: Array<number | null>;
  confidence: number[];
  total: number;
  started: number;
  completed: number;
  eligible: number;
  seriesComplete: number;
  seriesEligible: number;
  conflicts: number;
  incompleteSeries: number;
  registered: string | null;
  base: number;
  coverage: number;
  version: number;
  createdAt: number;
  evidence: Array<Array<{ id: number; name: string }>>;
}
const clamp = (v: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, Number.isFinite(v) ? v : 0));
const numeric = (v: unknown): number | null =>
  v !== null && v !== undefined && Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : null;
const value = (raw: any, key: string) => raw?.infobox?.find((v: any) => v.key === key)?.value;
const words = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.flatMap((x) => (typeof x === 'object' && x ? words((x as any).v) : words(x)))
    : typeof v === 'string'
      ? v
          .split(/[、,，;/／]/)
          .map((x) => x.trim())
          .filter(Boolean)
      : [];
export function metadata(raw: any): RadarSubject {
  const s = normalize(raw);
  const c = raw?.collection;
  const end = String(value(raw, '放送结束') || '').match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})/);
  return {
    ...s,
    votes: numeric(raw?.rating?.total),
    collectors: c
      ? Math.max(0, Number(c.collect) || 0) +
        Math.max(0, Number(c.doing) || 0) +
        0.2 * Math.max(0, Number(c.wish) || 0)
      : null,
    expected: Math.max(0, Math.trunc(Number(raw?.eps) || Number(value(raw, '话数')) || 0)),
    creators: [...new Set(words(value(raw, '导演') || value(raw, '监督')))],
    meta: Array.isArray(raw?.meta_tags)
      ? raw.meta_tags.filter((x: any) => typeof x === 'string')
      : [],
    end: end ? end[1] + '-' + end[2].padStart(2, '0') + '-' + end[3].padStart(2, '0') : '',
  };
}
export function mainline(r: Relation) {
  return r.type === 2 && ['续集', '前传', '前集', '后续'].includes(r.relation);
}
export function registrationBase(date: string | null, now = Date.now()): number {
  if (!date) return 0;
  const time = Date.parse(date);
  const year = new Date(time).getUTCFullYear();
  const current = new Date(now).getUTCFullYear();
  if (!Number.isFinite(time) || time > now || year < 2000) return 0;
  if (year <= 2018) return clamp(60 + (2018 - year) * 2, 60, 80);
  if (year <= 2022) return 60 - (year - 2018) * 5;
  return Math.round(clamp(5 + (30 * (current - year)) / Math.max(1, current - 2022), 5, 35));
}
const canonical = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s/g, '');
function strengths(s: RadarSubject) {
  const votes = new Map<string, number>();
  for (const t of s.tagVotes) {
    const k = canonical(t.name);
    if (THEMES.has(k)) votes.set(k, Math.max(votes.get(k) || 0, t.count));
  }
  const peak = Math.max(10, ...votes.values());
  const out = new Map<string, number>();
  for (const [k, v] of votes) out.set(k, v < 10 ? 0 : clamp(v / (peak * 0.2)) * clamp(v / 30));
  for (const tag of s.meta) {
    const k = canonical(tag);
    if (THEMES.has(k)) out.set(k, Math.max(out.get(k) || 0, 0.85));
  }
  return out;
}
const ART = [
  ['实验动画', '实验', '先锋', '意识流', '非线性', '虚实交错'],
  ['哲学', '人性', '社会', '寓言', '政治', '宗教', '象征'],
  ['艺术', '文学', '文学改', '超现实', '美学'],
];
const ODD = [
  ['猎奇', '人体改造', '身体恐怖', '肢解'],
  ['血腥', '残酷', '暴力美学'],
  ['心理恐怖', '心理惊悚', '精神污染', '恐怖', '惊悚'],
  ['怪诞', '荒诞', '电波', '超现实', '重口', '重口味', 'cult'],
];
const REAL = [
  ['职场', '职业', '家庭', '亲情', '社会', '现实'],
  ['运动', '体育', '旅行', '美食', '音乐', '露营', '登山'],
  ['青春', '校园', '恋爱'],
];
const SOFT = [
  ['治愈', '温馨', '日常'],
  ['搞笑', '喜剧', '轻松', '合家欢'],
];
// Only content themes set the denominator; studio/staff/year tags cannot drown them out.
const THEMES = new Set(
  [
    ...ART.flat(),
    ...ODD.flat(),
    ...REAL.flat(),
    ...SOFT.flat(),
    '科幻',
    '奇幻',
    '战斗',
    '冒险',
    '悬疑',
    '推理',
    '历史',
    '军事',
    '战争',
    '后宫',
    '异世界',
    '百合',
    '耽美',
    '机战',
    '热血',
    '魔法',
    '魔法少女',
    '心理',
    '萌系',
    '萌',
    '儿童',
    '童话',
    '偶像',
    '赛博朋克',
    '穿越',
    '乙女',
    '科普',
  ].map(canonical),
);
const match = (m: Map<string, number>, keys: string[]) =>
  Math.max(0, ...keys.map((k) => m.get(k) || 0));
const group = (m: Map<string, number>, groups: string[][]) => groups.map((g) => match(m, g));
export function features(s: RadarSubject, now = Date.now()): Array<number | null> {
  const tags = strengths(s);
  const known = [...tags.values()].some((x) => x > 0);
  const art = group(tags, ART),
    odd = group(tags, ODD),
    real = group(tags, REAL),
    soft = group(tags, SOFT);
  const age = (now - Date.parse(s.date)) / (365.25 * 86400000);
  const quality =
    s.votes !== null && s.votes > 0 && s.score > 0
      ? clamp(((s.score * s.votes + 6.5 * 200) / (s.votes + 200) - 6.3) / 2.4)
      : null;
  const expression = known
    ? clamp(Math.max(...art) * 0.8 + art.filter((x) => x > 0.3).length * 0.1)
    : null;
  const prestige =
    quality === null
      ? expression === null
        ? null
        : expression * 100
      : expression === null
        ? quality * 100
        : (quality * 0.6 + expression * 0.4) * 100;
  const popularity =
    s.collectors === null && s.votes === null
      ? null
      : Math.max(s.votes || 0, (s.collectors || 0) * 0.45);
  const scale =
    (s.platform === '剧场版'
      ? 25000
      : s.platform === 'OVA'
        ? 8000
        : s.platform === 'WEB'
          ? 18000
          : 35000) * (Number.isFinite(age) ? clamp(1 - Math.max(0, age - 15) / 60, 0.4, 1) : 1);
  const attention =
    popularity === null || popularity <= 0 ? null : clamp(Math.sqrt(popularity / scale));
  const niche =
    attention === null || !Number.isFinite(age) || age < 1 ? null : (1 - attention) * 100;
  // Neither NSFW nor low public ratings is evidence of disturbing content.
  const weird = known
    ? clamp(
        Math.max(odd[0], odd[1] * 0.8, odd[2] * 0.7, odd[3] * 0.55) +
          Math.max(0, odd.filter((x) => x > 0.3).length - 1) * 0.08,
      ) * 100
    : null;
  const mundane = known
    ? Math.max(real[0], real[1] * 0.8, real[2] * 0.45 * (1 - 0.6 * match(tags, ['后宫', '异世界'])))
    : null;
  const gentle = known ? Math.max(...soft) : null;
  const everyday =
    mundane === null
      ? null
      : clamp(mundane * 0.5 + (attention ?? 0.5) * 0.25 + (gentle ?? 0) * 0.25) * 100;
  return [prestige, niche, weird, everyday];
}
export function completion(node: RadarNode, now = Date.now()) {
  const { subject: s, item } = node;
  const eps = node.episodes?.filter((e) => e.type === 0) || [];
  const grace = now - 30 * 86400000;
  if (s.meta.some((t) => ['SP', '总集篇', '总集編', '特别篇', '特別篇'].includes(t)))
    return { eligible: false, score: null, confidence: 0, conflict: false };
  const validDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v));
  const ended =
    s.platform === '剧场版'
      ? validDate(s.date) && Date.parse(s.date) <= grace
      : validDate(s.end)
        ? Date.parse(s.end) <= grace
        : s.expected > 0 &&
          eps.length >= s.expected &&
          eps.every((e) => validDate(e.airdate) && Date.parse(e.airdate) <= grace);
  if (!ended || eps.some((e) => validDate(e.airdate) && Date.parse(e.airdate) > grace))
    return { eligible: false, score: null, confidence: 0, conflict: false };
  if (!item) return { eligible: true, score: 0, confidence: 1, conflict: false };
  if (item.status === 'wish' || item.status === 'not_interested')
    return { eligible: true, score: 0, confidence: 1, conflict: false };
  const progress = {
    ...node.progress,
    ...Object.fromEntries(Object.entries(item.episodeMarks).map(([id, m]) => [id, m.type])),
    ...item.episodeChanges,
  };
  const known = eps.filter((e) => Object.hasOwn(progress, String(e.id)));
  const fullProgress = (node.progress !== null || item.episodesComplete) && eps.length > 0;
  const seen = eps.filter((e) => progress[String(e.id)] === 2).length;
  if (fullProgress && known.length === eps.length) {
    const ratio = seen / eps.length;
    const conflict = item.status === 'collect' && ratio < 1;
    return {
      eligible: true,
      score: conflict ? null : ratio === 1 ? 100 : 40 * ratio,
      confidence: conflict ? 0 : 1,
      conflict,
    };
  }
  if (item.status === 'collect' && known.some((e) => progress[String(e.id)] !== 2))
    return { eligible: true, score: null, confidence: 0, conflict: true };
  if (item.status === 'collect')
    return { eligible: true, score: 100, confidence: 0.8, conflict: false };
  if (known.length)
    return {
      eligible: true,
      score: (40 * seen) / Math.max(s.expected, eps.length, 1),
      confidence: 0.65,
      conflict: false,
    };
  return { eligible: true, score: 20, confidence: 0.3, conflict: false };
}
function exposure(n: RadarNode) {
  const i = n.item;
  if (!i || i.status === 'wish' || i.status === 'not_interested') return 0;
  if (i.status === 'collect') return 1;
  const eps = n.episodes?.filter((e) => e.type === 0) || [];
  const p = {
    ...n.progress,
    ...Object.fromEntries(Object.entries(i.episodeMarks).map(([id, m]) => [id, m.type])),
    ...i.episodeChanges,
  };
  const seen = eps.filter((e) => p[String(e.id)] === 2).length;
  if (eps.length && Object.keys(p).length)
    return clamp(seen / Math.max(n.subject.expected, eps.length, 1));
  return i.status === 'doing' ? 0.35 : 0.15;
}
export function calculateRadar(
  nodes: RadarNode[],
  registered: string | null,
  total: number,
  now = Date.now(),
): RadarResult {
  const byId = new Map(nodes.map((n) => [n.subject.id, n]));
  const parents = new Map<number, number>();
  const root = (id: number): number => {
    if (!parents.has(id)) parents.set(id, id);
    const p = parents.get(id)!;
    if (p !== id) parents.set(id, root(p));
    return parents.get(id)!;
  };
  for (const n of nodes)
    for (const r of n.relations || [])
      if (mainline(r)) {
        const a = root(n.subject.id),
          b = root(r.id);
        if (a !== b) parents.set(b, a);
      }
  const groups = new Map<number, RadarNode[]>();
  for (const n of nodes) {
    const key = root(n.subject.id);
    groups.set(key, [...(groups.get(key) || []), n]);
  }
  const active = nodes.filter((n) => n.item && !['wish', 'not_interested'].includes(n.item.status));
  const weights = new Map<number, number>();
  const discounts = new Map<number, number>();
  for (const g of groups.values()) {
    const list = g
      .filter((n) => n.item)
      .sort((a, b) => exposure(b) - exposure(a) || a.subject.id - b.subject.id);
    const factors = list.map((_, j) => [1, 0.6, 0.4, 0.25, 0.2][j] ?? 0.1);
    const scale = Math.min(
      1,
      3 /
        Math.max(
          1,
          factors.reduce((a, b) => a + b, 0),
        ),
    );
    list.forEach((n, j) => {
      discounts.set(n.subject.id, factors[j] * scale);
      weights.set(n.subject.id, exposure(n) * factors[j] * scale);
    });
  }
  const weighted = active
    .map((n) => ({ n, w: weights.get(n.subject.id) || 0 }))
    .filter((x) => x.w > 0);
  const effective = weighted.reduce((a, x) => a + x.w, 0);
  const base = registrationBase(registered, now);
  const decades = new Map<number, number>();
  let era = 0,
    dated = 0;
  for (const { n, w } of weighted) {
    const year = Number(n.subject.date.slice(0, 4));
    if (year >= 1900 && year <= new Date(now).getUTCFullYear()) {
      dated += w;
      era += w * clamp((new Date(now).getUTCFullYear() - year - 5) / 25);
      const d = Math.floor(year / 10);
      decades.set(d, (decades.get(d) || 0) + w);
    }
  }
  // One old film is weak evidence of long-term, cross-era viewing.
  const ageSignal =
    ((dated ? era / dated : 0) * 0.65 +
      clamp([...decades.values()].reduce((a, v) => a + Math.min(1, v / 5), 0) / 5) * 0.35) *
    (1 - Math.exp(-dated / 30));
  const veteran =
    base + (100 - base) * (0.65 * (1 - Math.exp(-effective / 160)) + 0.35 * ageSignal);
  const featureMap = new Map(nodes.map((n) => [n.subject.id, features(n.subject, now)]));
  // A less-viewed sequel to a mainstream franchise is not automatically niche.
  const familyNiche = new Map<number, number>();
  for (const [key, g] of groups) {
    const scores = g
      .filter((n) => n.detailKnown)
      .map((n) => featureMap.get(n.subject.id)![1])
      .filter((v): v is number => v !== null);
    if (scores.length) familyNiche.set(key, Math.min(...scores));
  }
  const fs = weighted.map((x) => {
    const f = [...featureMap.get(x.n.subject.id)!];
    const family = familyNiche.get(root(x.n.subject.id));
    if (f[1] !== null && family !== undefined) f[1] = f[1] * 0.3 + family * 0.7;
    return { ...x, f };
  });
  const values: Array<number | null> = [];
  const confidences: number[] = [];
  const evidence: Array<Array<{ id: number; name: string }>> = [];
  for (let j = 0; j < 4; j++) {
    const valid = fs.filter((x) => x.n.detailKnown && x.f[j] !== null);
    const count = valid.reduce((a, x) => a + x.w, 0);
    const average = count ? valid.reduce((a, x) => a + x.w * x.f[j]!, 0) / count : 0;
    let score = count ? 50 + ((average - 50) * count) / (count + 6) : null;
    if (j === 0 && score !== null) {
      const creators = new Map<string, number>();
      for (const x of valid.filter((x) => x.f[0]! >= 55)) {
        const names = x.n.subject.creators;
        for (const name of names)
          creators.set(name, Math.max(creators.get(name) || 0, x.w / Math.max(1, names.length)));
      }
      const creatorCoverage = [...creators.values()].reduce((a, v) => a + v, 0);
      score = score * 0.9 + clamp(creatorCoverage / 12) * 10;
    }
    values.push(score);
    confidences.push(clamp(count / Math.max(1, effective)) * clamp(count / 20));
    evidence.push(
      valid
        .sort((a, b) => b.w * b.f[j]! - a.w * a.f[j]!)
        .slice(0, 3)
        .map((x) => ({
          id: x.n.subject.id,
          name: x.n.subject.name_cn || x.n.subject.name || String(x.n.subject.id),
        })),
    );
  }
  let finishConfidence = 0;
  let sum = 0,
    denom = 0,
    completed = 0,
    eligible = 0,
    conflicts = 0;
  for (const n of active) {
    const c = completion(n, now);
    if (!c.eligible) continue;
    eligible++;
    if (c.conflict) conflicts++;
    if (c.score === 100) completed++;
    if (c.score !== null) {
      const w = discounts.get(n.subject.id) || 1;
      finishConfidence += c.confidence * w;
      sum += c.score * w;
      denom += w;
    }
  }
  let seriesSum = 0,
    seriesWeight = 0,
    seriesComplete = 0,
    seriesEligible = 0,
    incompleteSeries = 0;
  for (const g of groups.values()) {
    const opened = g.filter((n) => n.item && !['wish', 'not_interested'].includes(n.item.status));
    if (!opened.length) continue;
    const closed = g.every(
      (n) =>
        n.detailKnown &&
        n.relations !== null &&
        (n.relations || []).every((r) => !mainline(r) || byId.has(r.id)),
    );
    if (!closed) {
      incompleteSeries++;
      continue;
    }
    if (g.length < 2) continue;
    const available = g.map((n) => ({ n, c: completion(n, now) })).filter((x) => x.c.eligible);
    if (available.length < 2 || available.some((x) => x.c.conflict)) continue;
    const complete = available.filter((x) => x.c.score === 100).length;
    const ratio = complete / available.length;
    const w = opened.length >= 2 ? 1 : 0.25;
    seriesSum += (ratio === 1 ? 100 : 40 * ratio) * w;
    seriesWeight += w;
    seriesEligible++;
    if (ratio === 1) seriesComplete++;
  }
  const finish = denom
    ? (sum / denom) * (seriesWeight ? 0.7 : 1) +
      (seriesWeight ? (seriesSum / seriesWeight) * 0.3 : 0)
    : null;
  const score = (v: number | null) => (v === null ? null : Math.round(clamp(v, 0, 100)));
  const scores = [
    registered || effective ? score(veteran) : null,
    score(values[0]),
    score(values[1]),
    score(values[2]),
    score(finish),
    score(values[3]),
  ];
  return {
    scores,
    confidence: [
      clamp((registered ? 0.65 : 0) + (0.35 * dated) / Math.max(1, effective)),
      confidences[0],
      confidences[1],
      confidences[2],
      clamp(finishConfidence / Math.max(1, denom)) * clamp(eligible / 15),
      confidences[3],
    ],
    total,
    started: active.length,
    completed,
    eligible,
    seriesComplete,
    seriesEligible,
    conflicts,
    incompleteSeries,
    registered,
    base,
    coverage: active.length ? active.filter((n) => n.detailKnown).length / active.length : 1,
    version: RADAR_VERSION,
    createdAt: now,
    evidence: [
      weighted
        .sort((a, b) => a.n.subject.date.localeCompare(b.n.subject.date))
        .slice(0, 3)
        .map((x) => ({ id: x.n.subject.id, name: x.n.subject.name_cn || x.n.subject.name })),
      evidence[0],
      evidence[1],
      evidence[2],
      [],
      evidence[3],
    ],
  };
}
