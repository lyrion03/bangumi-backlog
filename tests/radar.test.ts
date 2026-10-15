import { describe, it, expect, vi } from 'vitest';
import { validateItem } from '../src/domain';
import {
  registrationBase,
  calculateRadar,
  metadata,
  features,
  completion,
  type RadarNode,
} from '../src/radar-score';
import { parseRegistration } from '../server/registration.mjs';
const now = Date.parse('2026-10-10T00:00:00Z');
function node(id = 1, status = 'collect', extra: any = {}): RadarNode {
  const raw = {
    id,
    name: '测试动画' + id,
    name_cn: '测试动画' + id,
    date: '2006-01-01',
    platform: 'TV',
    eps: 12,
    rating: { score: 8, total: 1000 },
    collection: { collect: 1800, doing: 100, wish: 100 },
    tags: [
      { name: '日常', count: 100 },
      { name: '恋爱', count: 80 },
    ],
    ...extra,
  };
  return {
    subject: metadata(raw),
    item: validateItem({ ...raw, status }),
    episodes: Array.from({ length: 12 }, (_, i) => ({
      id: id * 100 + i,
      type: 0,
      airdate: '2006-01-01',
      name: '',
      name_cn: '',
      sort: i + 1,
      ep: i + 1,
    })),
    progress: null,
    relations: [],
    detailKnown: true,
  };
}
const collection = (n = 30, extra: any = {}) =>
  Array.from({ length: n }, (_, i) => node(i + 1, 'collect', extra));
describe('six-axis radar', () => {
  it.each([
    [2008, 80],
    [2010, 76],
    [2015, 66],
    [2018, 60],
    [2019, 55],
    [2020, 50],
    [2021, 45],
    [2022, 40],
  ])('registration year %s has base %s', (year, score) =>
    expect(registrationBase(year + '-01-01', now)).toBe(score),
  );
  it('recent registration bases descend and invalid/future dates never earn seniority', () => {
    const scores = [2023, 2024, 2025, 2026].map((y) => registrationBase(y + '-01-01', now));
    expect(scores).toEqual([28, 20, 13, 5]);
    for (const d of [null, 'oops', '2099-01-01']) expect(registrationBase(d, now)).toBe(0);
  });
  it('older registrations receive their base even without viewing, unknown accounts do not', () => {
    expect(calculateRadar([], '2018-01-01', 0, now).scores).toEqual([
      60,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(calculateRadar([], null, 0, now).scores).toEqual([null, null, null, null, null, null]);
  });
  it('more completed works and older-era breadth increase seniority independently', () => {
    const small = calculateRadar(collection(5), '2025-01-01', 5, now).scores[0]!;
    const large = calculateRadar(collection(100), '2025-01-01', 100, now).scores[0]!;
    expect(large).toBeGreaterThan(small);
    const old = calculateRadar(collection(30, { date: '1986-01-01' }), null, 30, now).scores[0]!;
    const modern = calculateRadar(collection(30, { date: '2020-01-01' }), null, 30, now).scores[0]!;
    expect(old).toBeGreaterThan(modern);
  });
  it('a single old movie cannot substitute for broad veteran viewing', () => {
    const r = calculateRadar(collection(1, { date: '1960-01-01' }), null, 1, now);
    expect(r.scores[0]!).toBeLessThan(5);
  });
  it('future regular episodes override a conflicting end-date entry', () => {
    const n = node(1, 'doing', { infobox: [{ key: '放送结束', value: '2006年2月1日' }] });
    n.episodes![0].airdate = '2099-01-01';
    expect(completion(n, now).eligible).toBe(false);
  });
  it('scores do not depend on personal ratings, comments or record order', () => {
    const records = collection();
    const a = calculateRadar(records, null, 30, now);
    for (const n of records) {
      n.item!.rate = 1;
      n.item!.comment = '个人评价';
    }
    expect(calculateRadar(records.reverse(), null, 30, now).scores).toEqual(a.scores);
  });
  it('wish and exclusion records contribute no viewing evidence', () => {
    const a = collection(5);
    const b = [...a, node(90, 'wish'), node(91, 'not_interested')];
    expect(calculateRadar(b, null, 7, now).scores).toEqual(calculateRadar(a, null, 5, now).scores);
  });
  it('caps a long single franchise instead of counting hundreds of sequels as breadth', () => {
    const long = collection(100);
    for (let i = 0; i < 99; i++) long[i].relations = [{ id: i + 2, type: 2, relation: '续集' }];
    expect(calculateRadar(long, null, 100, now).scores[0]!).toBeLessThan(
      calculateRadar(collection(10), null, 10, now).scores[0]!,
    );
  });
  it('NSFW alone never changes genre scores; one stray tag cannot dominate', () => {
    const n = node();
    const f = features(n.subject, now);
    n.subject.nsfw = true;
    expect(features(n.subject, now)).toEqual(f);
    n.subject.tagVotes.push({ name: '猎奇', count: 1 });
    expect(features(n.subject, now)[2]).toBe(f[2]);
  });
  it('confirmed disturbing themes exceed ordinary daily-life while romance alone is not normie', () => {
    const horror = node(1, 'collect', {
      tags: [
        { name: '猎奇', count: 100 },
        { name: '身体恐怖', count: 80 },
        { name: '血腥', count: 80 },
      ],
    });
    expect(features(horror.subject, now)[2]!).toBeGreaterThan(
      features(node().subject, now)[2]! + 50,
    );
    const social = node(2, 'collect', {
      tags: [
        { name: '职场', count: 100 },
        { name: '家庭', count: 90 },
        { name: '治愈', count: 80 },
      ],
    });
    const harem = node(3, 'collect', {
      tags: [
        { name: '恋爱', count: 100 },
        { name: '后宫', count: 100 },
        { name: '异世界', count: 100 },
      ],
    });
    expect(features(social.subject, now)[3]!).toBeGreaterThan(
      features(harem.subject, now)[3]! + 30,
    );
  });
  it('one or two ratings cannot create an elite score and fresh or zero-count works are not niche evidence', () => {
    const few = node(1, 'collect', {
      rating: { total: 2, score: 10 },
      tags: [{ name: '搞笑', count: 100 }],
    });
    const consensus = node(2, 'collect', {
      rating: { total: 20000, score: 8.5 },
      tags: [{ name: '搞笑', count: 100 }],
    });
    expect(features(few.subject, now)[0]!).toBeLessThan(features(consensus.subject, now)[0]!);
    expect(features(node(3, 'collect', { date: '2026-09-01' }).subject, now)[1]).toBeNull();
    expect(
      features(
        node(4, 'collect', { rating: { total: 0, score: 0 }, collection: {} }).subject,
        now,
      )[1],
    ).toBeNull();
  });
  it('partial and abandoned works are real unfinished pits, not discounted out of the denominator', () => {
    const records = [
      ...collection(10),
      ...Array.from({ length: 10 }, (_, i) => node(i + 50, 'dropped')),
    ];
    expect(calculateRadar(records, null, 20, now).scores[4]).toBe(60);
    const half = node(200, 'doing');
    half.progress = Object.fromEntries(half.episodes!.map((e, i) => [e.id, i < 6 ? 2 : 0]));
    expect(completion(half, now).score).toBe(20);
  });
  it('ignores SP, future episodes and the 30-day completion grace period', () => {
    const n = node();
    n.episodes!.push({
      id: 199,
      type: 1,
      airdate: '2099-01-01',
      name: '',
      name_cn: '',
      sort: 1,
      ep: 1,
    });
    expect(completion(n, now).score).toBe(100);
    n.episodes![0].airdate = '2099-01-01';
    expect(completion(n, now).eligible).toBe(false);
    n.episodes![0].airdate = '2026-10-01';
    expect(completion(n, now).eligible).toBe(false);
    expect(completion(node(2, 'collect', { meta_tags: ['SP'] }), now).eligible).toBe(false);
  });
  it('conflicting complete status and chapter records are flagged instead of assumed finished', () => {
    const n = node();
    n.progress = Object.fromEntries(n.episodes!.map((e) => [e.id, 0]));
    expect(completion(n, now)).toMatchObject({ score: null, conflict: true });
    expect(calculateRadar([n], null, 1, now)).toMatchObject({ conflicts: 1, completed: 0 });
  });
  it('counts a franchise once, rewards closure, and excludes unresolved graphs', () => {
    const a = node(1),
      b = node(2);
    a.relations = [{ id: 2, type: 2, relation: '续集' }];
    b.relations = [{ id: 1, type: 2, relation: '前传' }];
    expect(calculateRadar([a, b], null, 2, now)).toMatchObject({
      seriesComplete: 1,
      seriesEligible: 1,
    });
    b.item = undefined;
    expect(calculateRadar([a, b], null, 1, now).scores[4]).toBe(76);
    b.relations = null;
    expect(calculateRadar([a, b], null, 1, now).seriesEligible).toBe(0);
  });
  it('a less-viewed sequel retains the mainstream context of its franchise', () => {
    const sequel = node(2, 'collect', {
      rating: { total: 300, score: 8 },
      collection: { collect: 500 },
    });
    const standalone = calculateRadar([sequel], null, 1, now).scores[2]!;
    const original = node(1, 'collect', {
      rating: { total: 35000, score: 8 },
      collection: { collect: 50000 },
    });
    original.item = undefined;
    sequel.relations = [{ id: 1, type: 2, relation: '前传' }];
    original.relations = [{ id: 2, type: 2, relation: '续集' }];
    expect(calculateRadar([sequel, original], null, 1, now).scores[2]!).toBeLessThan(standalone);
  });
  it('missing genres remain unknown; all numeric results stay in range', () => {
    const missing = node(1, 'collect', { tags: [], rating: {}, collection: undefined });
    missing.detailKnown = false;
    expect(calculateRadar([missing], null, 1, now).scores[1]).toBeNull();
    for (const size of [0, 1, 10, 100, 500])
      for (const score of calculateRadar(collection(size), null, size, now).scores)
        if (score !== null) expect(score >= 0 && score <= 100).toBe(true);
  });
  it('extracts the registration service entry without trusting arbitrary dates or invalid calendars', () => {
    expect(
      parseRegistration(
        '<span class="service">Bangumi</span> <span class="tip">2008-6-19 加入</span>',
        now,
      ),
    ).toBe('2008-06-19');
    expect(parseRegistration('个人签名：2001-1-1 加入', now)).toBeNull();
    expect(parseRegistration('Bangumi</span><span>2025-2-31 加入</span>', now)).toBeNull();
  });
});

describe('curiosity from niche low-rated works', () => {
  const fringe = (extra: any = {}) =>
    node(80, 'collect', {
      date: '2010-01-01',
      rating: { score: 4, total: 500 },
      collection: { collect: 600, doing: 0, wish: 0 },
      ...extra,
    });
  it('adds a bounded reference only when low attention and low public score occur together', () => {
    const low = features(fringe().subject, now)[2]!;
    expect(low).toBeGreaterThan(15);
    expect(low).toBeLessThanOrEqual(40);
    expect(features(fringe({ rating: { score: 8, total: 500 } }).subject, now)[2]).toBe(0);
    expect(features(fringe({ collection: { collect: 100000 } }).subject, now)[2]).toBe(0);
  });
  it('does not infer fringe exploration from new releases, unknown dates or sparse ratings', () => {
    for (const extra of [
      { date: '2026-09-01' },
      { date: '' },
      { date: '2099-01-01' },
      { rating: { score: 1, total: 2 } },
      { rating: { score: 0, total: 500 } },
      { rating: { score: 4 } },
    ])
      expect(features(fringe(extra).subject, now)[2]).toBe(0);
  });
  it('can use public reception without disturbing tags or personal ratings', () => {
    const n = fringe({ tags: [], meta_tags: [] });
    expect(features(n.subject, now)[2]!).toBeGreaterThan(15);
    const first = calculateRadar([n], null, 1, now);
    n.item!.rate = 10;
    expect(calculateRadar([n], null, 1, now).scores).toEqual(first.scores);
    n.subject.nsfw = true;
    expect(calculateRadar([n], null, 1, now).scores).toEqual(first.scores);
  });
  it('counts actual exposure, while wish and not-interested records add no exploration evidence', () => {
    const base = collection(30);
    const additions = Array.from({ length: 10 }, (_, i) => {
      const n = fringe();
      n.subject.id = 80 + i;
      n.item!.id = 80 + i;
      return n;
    });
    const initial = calculateRadar(base, null, 30, now);
    expect(calculateRadar([...base, ...additions], null, 40, now).scores[3]!).toBeGreaterThan(
      initial.scores[3]!,
    );
    for (const n of additions) n.item!.status = 'wish';
    expect(calculateRadar([...base, ...additions], null, 40, now).scores).toEqual(initial.scores);
    for (const n of additions) n.item!.status = 'not_interested';
    expect(calculateRadar([...base, ...additions], null, 40, now).scores).toEqual(initial.scores);
  });
  it('does not treat an unpopular sequel of a mainstream franchise as a separate niche discovery', () => {
    const sequel = fringe();
    expect(features(sequel.subject, now, 0)[2]).toBe(0);
    const mainstream = node(1, 'collect', { collection: { collect: 200000 } });
    const separate = calculateRadar([mainstream, sequel], null, 2, now).scores[3]!;
    mainstream.relations = [{ id: sequel.subject.id, type: 2, relation: '续集' }];
    expect(calculateRadar([mainstream, sequel], null, 2, now).scores[3]!).toBeLessThan(separate);
  });
});
