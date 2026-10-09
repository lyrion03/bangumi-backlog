import { describe, it, expect, vi } from 'vitest';
import { Api } from '../src/api';
import { normalize } from '../src/domain';
import { scanSeriesPage, isSeriesRelation } from '../src/series';
const subjects = [1, 2, 3].map((id) => normalize({ id }));
describe('background series discovery', () => {
  it('checks subjects sequentially, ignores non-series media, and continues after a failure', async () => {
    const api = new Api(0);
    const calls: number[] = [];
    let active = 0;
    let maxActive = 0;
    vi.spyOn(api, 'related').mockImplementation(async (id) => {
      calls.push(id);
      maxActive = Math.max(maxActive, ++active);
      await Promise.resolve();
      active--;
      if (id === 2) throw new Error('network');
      return [{ id: 100, type: id === 1 ? 2 : 1, relation: '续集' }];
    });
    const result = vi.fn();
    const progress = vi.fn();
    await scanSeriesPage(
      api,
      subjects,
      () => false,
      async () => {},
      result,
      progress,
    );
    expect(calls).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
    expect(result.mock.calls).toEqual([
      [1, true],
      [3, false],
    ]);
    expect(progress).toHaveBeenLastCalledWith(3, 1);
    expect(isSeriesRelation({ id: 1, type: 2, relation: '续集' }, 1)).toBe(false);
    expect(isSeriesRelation({ id: 4, type: 2, relation: '相同世界观' }, 1)).toBe(false);
  });
  it('does not apply an obsolete page response or start its remaining requests', async () => {
    const api = new Api(0);
    let cancelled = false;
    vi.spyOn(api, 'related').mockImplementation(async () => {
      cancelled = true;
      return [{ id: 4, type: 2, relation: '前传' }];
    });
    const result = vi.fn();
    const progress = vi.fn();
    await scanSeriesPage(
      api,
      subjects,
      () => cancelled,
      async () => {},
      result,
      progress,
    );
    expect(api.related).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });
  it('shares in-flight relationships with the series view but retries failed lookups', async () => {
    const api = new Api(0);
    const request = vi
      .spyOn(api, 'request')
      .mockResolvedValue([{ id: 2, type: 2, relation: '续集' }]);
    await Promise.all([api.related(1), api.related(1)]);
    expect(request).toHaveBeenCalledTimes(1);
    api.token = 'another-session';
    await api.related(1);
    expect(request).toHaveBeenCalledTimes(2);
    request.mockRejectedValueOnce(new Error('offline'));
    await expect(api.related(3)).rejects.toThrow('offline');
    await api.related(3);
    expect(request).toHaveBeenCalledTimes(4);
  });
});

import { collectSeries, durationMinutes, hasMainlineLength } from '../src/series';
describe('mainline-only series', () => {
  it('reads valid durations and rejects missing, special-only or short regular episodes', () => {
    expect(durationMinutes('00:24:30')).toBe(24.5);
    expect(durationMinutes('24:30')).toBe(24.5);
    expect(durationMinutes('24分钟')).toBe(24);
    expect(durationMinutes('00:99:00')).toBe(0);
    const eps = (values: string[]) => values.map((duration) => ({ type: 0, duration })) as any;
    expect(hasMainlineLength(eps(['', '00:00:00']))).toBe(false);
    expect(hasMainlineLength([{ type: 1, duration: '01:30:00' }] as any)).toBe(false);
    expect(hasMainlineLength(eps(['00:03:00', '00:04:00', '00:24:00']))).toBe(false);
    expect(hasMainlineLength(eps(['', '00:24:00']))).toBe(true);
    expect(hasMainlineLength(eps(['00:04:59']))).toBe(false);
    expect(hasMainlineLength(eps(['00:05:00']))).toBe(true);
    expect(hasMainlineLength(eps(['00:12:00']))).toBe(true);
  });
  it('excludes spin-offs, WEB, other formats, shorts and absent durations without traversing them', async () => {
    const api = new Api(0);
    const related = vi
      .spyOn(api, 'related')
      .mockImplementation(async (id) =>
        id === 1
          ? [2, 3, 4, 5, 6, 7].map((id) => ({ id, type: 2, relation: id === 7 ? '衍生' : '续集' }))
          : [],
      );
    const details = vi.spyOn(api, 'subject').mockImplementation(async (id) =>
      normalize({
        id,
        platform: id === 3 ? 'WEB' : id === 4 ? '其他' : 'TV',
        date: '2020-01-01',
      }),
    );
    vi.spyOn(api, 'episodes').mockImplementation(
      async (id) =>
        [{ type: 0, duration: id === 5 ? '00:03:00' : id === 6 ? '' : '00:24:00' }] as any,
    );
    const found = await collectSeries(
      api,
      normalize({ id: 1 }),
      () => false,
      () => {},
    );
    expect(found.entries.map((s) => s.id)).toEqual([1, 2]);
    expect(related.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    expect(details.mock.calls.map((c) => c[0])).not.toContain(7);
    expect(isSeriesRelation({ id: 9, type: 2, relation: '外传' }, 1)).toBe(false);
  });
});

describe('movie duration exemption', () => {
  it('recognizes minute suffixes while non-movies still require known durations', () => {
    expect(durationMinutes('98m')).toBe(98);
    expect(durationMinutes('113 minutes')).toBe(113);
    expect(hasMainlineLength([{ type: 0, duration: '' }] as any)).toBe(false);
    expect(hasMainlineLength([{ type: 0, duration: '4m' }] as any)).toBe(false);
    expect(hasMainlineLength([])).toBe(false);
  });
  it.each([
    [9979, 321, '98m', '98分钟', '113分钟'],
    [237, 238, '', '82分钟', '100分钟'],
    [10, 11, '', '', ''],
    [20, 21, '2m', '2分钟', '1分钟'],
  ])(
    'connects official movie formats for %s and %s without admitting unknown TV or adaptations',
    async (rootId, sequelId, duration, runtime, sequelRuntime) => {
      const api = new Api(0);
      vi.spyOn(api, 'subject').mockImplementation(async (id) =>
        normalize({
          id,
          platform: id === 999 ? 'TV' : '剧场版',
          date: id === rootId ? '1989-01-01' : '1993-01-01',
          infobox: [{ key: '片长', value: id === rootId ? runtime : sequelRuntime }],
        }),
      );
      vi.spyOn(api, 'episodes').mockImplementation(
        async (id) => [{ type: 0, duration: id === rootId ? duration : '' }] as any,
      );
      const related = vi.spyOn(api, 'related').mockImplementation(async (id) =>
        id === rootId
          ? [
              { id: Number(sequelId), type: 2, relation: '续集' },
              { id: 999, type: 2, relation: '前传' },
              { id: 888, type: 2, relation: '不同演绎' },
            ]
          : [],
      );
      const result = await collectSeries(
        api,
        normalize({ id: rootId }),
        () => false,
        () => {},
      );
      expect(result.entries.map((s) => s.id)).toEqual([rootId, sequelId]);
      expect(api.episodes).toHaveBeenCalledTimes(1);
      expect(api.episodes).toHaveBeenCalledWith(999, 1);
      expect(related.mock.calls.map((c) => c[0])).not.toContain(999);
      expect(api.subject).not.toHaveBeenCalledWith(888, expect.anything());
    },
  );
});
